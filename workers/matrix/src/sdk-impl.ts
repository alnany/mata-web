/**
 * Live matrix-js-sdk integration. Imported dynamically by `MatrixCore` so
 * the worker's cold-start bundle stays small until the user signs in.
 *
 * Architecture (see ADR-001/ADR-002):
 *   - This file owns ALL matrix-js-sdk usage. Nothing outside `MatrixCore`
 *     may import the SDK directly.
 *   - All side-effecting calls go through `SdkSession`, which the worker
 *     bridge holds at most one instance of.
 *   - Sync deltas, send status, and verification requests are surfaced via
 *     `Emit`, never returned through RPC.
 *
 * Type discipline:
 *   - `@mata/shared/matrix` defines the wire-format types (RoomSummary,
 *     TimelineEvent, MessageBody, ...). This file is the *only* place we
 *     translate between matrix-js-sdk's internal shapes and the contract.
 */

import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  MatrixEventEvent,
  EventType,
  MsgType,
  type MatrixClient,
  type Room,
  type MatrixEvent,
  type IContent,
  type IRoomTimelineData,
  type IStartClientOpts,
} from 'matrix-js-sdk';
import { SyncState } from 'matrix-js-sdk/lib/sync';

import type {
  RoomMember,
  RoomSummary,
  TimelineEvent,
  UserId,
  DeviceId,
  RoomId,
  EventId,
  MessageBody,
  MxcUri,
  MediaInfo,
  RoomDelta,
} from '@mata/shared/matrix';
import { authError, networkError, syncError } from '@mata/shared/errors';
import type { WorkerEvent } from '@mata/shared/rpc';
import type { IceServer } from '@mata/shared/rpc';
import { VerificationService } from './verification.js';
import {
  type SessionRecord,
  saveSession,
  clearSession,
  touchSession,
} from './session-store.js';

const CRYPTO_DB_NAME = 'mata/crypto';

// Compile-time feature flag (wired through Vite's `define`).
// biome-ignore lint/style/noVar: declare-only at module top.
declare const ENABLE_E2EE: boolean;

export interface LoginInput {
  serverUrl: string;
  user: string;
  password: string;
  deviceDisplayName: string;
}

export interface LoggedIn {
  userId: UserId;
  deviceId: DeviceId;
}

type Emit = (event: WorkerEvent) => void;

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export class SdkSession {
  private emit: Emit;
  private client: MatrixClient | null = null;
  private currentUserId: UserId | null = null;
  /**
   * In-memory cache of SSSS private keys keyed by SSSS key id. Populated
   * by `enableKeyBackup`/`restoreKeyBackup` and read by the
   * `cryptoCallbacks.getSecretStorageKey` we registered with the SDK at
   * `createClient` time. Never persisted — rebuilt from passphrase on
   * each device boot.
   */
  readonly secretStorageKeyCache: Map<string, Uint8Array> = new Map();

  /**
   * SAS verification state machine. Lazy-instantiated because it
   * captures `this.emit` + a getter into the live client; the
   * VerificationService doesn't run until a client is booted, but the
   * field has to exist from construction so `verify()` RPCs can be
   * dispatched the moment a client appears.
   */
  readonly verification: VerificationService;

  constructor(emit: Emit) {
    this.emit = emit;
    this.verification = new VerificationService({
      client: () => this.client,
      emit: (ev) => this.emit(ev),
    });
  }

  isLoggedIn(): boolean {
    return this.client !== null;
  }

  /**
   * Stop and null any existing MatrixClient before a fresh boot. Critical
   * on re-login: without this, the previous client keeps polling /sync
   * and racing against the new client over the same IDB / device keys,
   * which surfaces as the new boot's crypto-init hanging for 30s while
   * the old client holds locks on the IndexedDB crypto store.
   */
  private async teardownExistingClient(): Promise<void> {
    const c = this.client;
    if (!c) return;
    this.client = null;
    this.currentUserId = null;
    try {
      c.stopClient();
    } catch {
      /* best-effort */
    }
    // Give the SDK a tick to settle pending /sync long-polls and IDB
    // transactions before the next initRustCrypto opens the store.
    await new Promise((r) => setTimeout(r, 50));
  }

  async login(input: LoginInput): Promise<LoggedIn> {
    const baseUrl = normalizeServerUrl(input.serverUrl);
    const probe = createClient({ baseUrl });
    let response: Awaited<ReturnType<MatrixClient['login']>>;
    try {
      // Use the Matrix spec ≥ r0.4 user identifier form. Passing { user } directly
      // sends the legacy top-level `user` field, which conduwuit (and most modern
      // homeservers) reject with M_INVALID_USERNAME.
      response = await probe.login('m.login.password', {
        identifier: {
          type: 'm.id.user',
          user: input.user,
        },
        password: input.password,
        initial_device_display_name: input.deviceDisplayName,
      });
    } catch (err) {
      throw mapLoginError(err);
    }

    const record: SessionRecord = {
      userId: response.user_id as UserId,
      deviceId: response.device_id as DeviceId,
      accessToken: response.access_token,
      refreshToken: null,
      homeserverBaseUrl: baseUrl,
      pickleKeyRef: response.user_id,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    await saveSession(record);
    // Tear down any in-flight client from a previous login before we
    // touch the crypto IDB. Without this, the old client's /sync loop
    // keeps writing to the store we're about to wipe.
    await this.teardownExistingClient();
    // Fresh login = new deviceId. Any pre-existing crypto IndexedDB
    // belongs to a previous device whose account-in-store will fail the
    // rust crypto-sdk's "account in store matches account in constructor"
    // check ("expected @user:host:OLD_DEVICE, got @user:host:NEW_DEVICE")
    // and the entire bootClient crashes inside initRustCrypto before any
    // sync starts. We have no recoverable state from the old device
    // without its keys, so wipe the crypto IDBs before booting.
    await wipeStaleCryptoStores(this.emit.bind(this));
    await this.bootClient(record);
    return { userId: record.userId, deviceId: record.deviceId };
  }

  async restoreFrom(record: SessionRecord): Promise<LoggedIn> {
    await this.bootClient(record);
    await touchSession(record.userId);
    return { userId: record.userId, deviceId: record.deviceId };
  }

  async logout(): Promise<void> {
    const c = this.client;
    const uid = this.currentUserId;
    this.client = null;
    this.currentUserId = null;
    if (!c) return;
    try {
      await c.logout(true);
    } catch {
      /* best-effort — we still clear local state below */
    }
    c.stopClient();
    if (uid) await clearSession(uid);
  }

  async listRoomSummaries(): Promise<RoomSummary[]> {
    const c = this.requireClient();
    return c.getRooms().map((r) => toSummary(r, c));
  }

  async loadRoomHistory(
    roomId: RoomId,
    fromToken: string | null,
    limit: number,
  ): Promise<{ events: TimelineEvent[]; prevToken: string | null }> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    if (!room) throw syncError(`Unknown room ${roomId}`);
    const liveTimeline = room.getLiveTimeline();
    if (fromToken !== null) {
      // matrix-js-sdk's paginateEventTimeline ignores fromToken; it uses the
      // timeline's own backward token. We accept fromToken purely as the
      // contract-stable name for "page more", and trigger a backward page.
      await c.paginateEventTimeline(liveTimeline, { backwards: true, limit });
    }
    const events = liveTimeline.getEvents();
    return {
      events: events.map((e) => toTimelineEvent(e)).filter((e): e is TimelineEvent => e !== null),
      prevToken: liveTimeline.getPaginationToken('b' as unknown as Parameters<typeof liveTimeline.getPaginationToken>[0]),
    };
  }

  async sendMessage(
    roomId: RoomId,
    content: MessageBody,
    txnId: string,
    threadRoot?: EventId,
  ): Promise<void> {
    // INSTRUMENTATION (send-pipeline trace).
    // Phase markers go through the `diagNote` event channel — they land
    // in the user's sync log feed but do NOT touch the sync-state pill.
    // (Older versions used syncStatus:'connecting' for this, which made
    // the pill flip back to amber on every send/decrypt phase even after
    // sync reached `syncing`. The "kept saying connecting" symptom.)
    // Marker phases (CORE-level):
    //   1) entered       — function reached, client OK
    //   2) checked-room  — knows whether room exists and is encrypted
    //   3) emit-sending  — local sendStatus 'sending' fired
    //   4) before-send   — about to call c.sendEvent
    //   5) sdk-returned  — c.sendEvent's promise resolved (HTTP succeeded)
    //   6) emit-sent     — local sendStatus 'sent' fired
    // If a marker is the LAST thing seen in the trace, the next phase
    // is where it hung.
    const short = txnId.slice(-6);
    const tag = (phase: string, extra = ''): void => {
      this.emit({
        kind: 'diagNote',
        note: `send-CORE[${short}] ${phase}${extra ? ': ' + extra : ''}`,
      });
    };

    tag('entered');
    const c = this.requireClient();

    // Probe room state before doing anything else. If room is null,
    // matrix-js-sdk's sendEvent will throw immediately with an opaque
    // message; surfacing it here makes the trigger obvious.
    const room = c.getRoom(roomId);
    const isEncrypted = (() => {
      try {
        return c.isRoomEncrypted(roomId);
      } catch {
        return false;
      }
    })();
    const memberCount = room ? room.getJoinedMemberCount() : -1;
    tag(
      'checked-room',
      `roomKnown=${room !== null} encrypted=${isEncrypted} joinedMembers=${memberCount}`,
    );

    this.emit({ kind: 'sendStatus', txnId, status: 'sending' });
    tag('emit-sending');

    try {
      // matrix-js-sdk can queue an outgoing event indefinitely if the room
      // is encrypted and the megolm session isn't established (or crypto
      // never finished bootstrapping). Without a hard ceiling the send
      // bubble stayed "pending" forever with no signal to the user. 45s
      // is generous enough for first-message megolm setup but short
      // enough to surface a real hang.
      tag('before-send', 'calling c.sendEvent now');
      // Compose the wire payload. When `threadRoot` is provided we
      // attach an `m.relates_to` for `m.thread` per MSC3440 / spec
      // v1.4. The `is_falling_back: true` + `m.in_reply_to` to the
      // thread root is the documented fallback that lets clients
      // without thread support still see a reply chain rather than
      // an orphan message.
      const wirePayload: Record<string, unknown> = encodeMessageBody(content);
      if (threadRoot) {
        wirePayload['m.relates_to'] = {
          rel_type: 'm.thread',
          event_id: threadRoot,
          is_falling_back: true,
          'm.in_reply_to': { event_id: threadRoot },
        };
      }
      const sendPromise = c.sendEvent(
        roomId,
        EventType.RoomMessage,
        wirePayload,
        txnId,
      );
      const result = await Promise.race([
        sendPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            tag('timeout-fired', `45s elapsed — encrypted=${isEncrypted}`);
            reject(
              new Error(
                isEncrypted
                  ? 'send exceeded 45s — encrypted room, likely waiting on megolm session / device keys'
                  : 'send exceeded 45s — homeserver did not respond',
              ),
            );
          }, 45_000),
        ),
      ]);
      tag('sdk-returned', `event_id=${(result.event_id as string).slice(0, 24)}`);
      this.emit({ kind: 'sendStatus', txnId, status: 'sent', eventId: result.event_id as EventId });
      tag('emit-sent');
    } catch (err) {
      tag('caught', describe(err).slice(0, 160));
      this.emit({
        kind: 'sendStatus',
        txnId,
        status: 'failed',
        error: { category: 'network', message: describe(err), retryable: true },
      });
      throw networkError(`sendMessage failed: ${describe(err)}`);
    }
  }

  async editMessage(
    roomId: RoomId,
    eventId: EventId,
    content: MessageBody,
    txnId: string,
  ): Promise<void> {
    const c = this.requireClient();
    this.emit({ kind: 'sendStatus', txnId, status: 'sending' });
    const newBody = encodeMessageBody(content);
    const payload: IContent = {
      ...newBody,
      'm.new_content': newBody,
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: eventId,
      },
      body: `* ${typeof newBody.body === 'string' ? newBody.body : ''}`,
    };
    try {
      const result = await c.sendEvent(roomId, EventType.RoomMessage, payload, txnId);
      this.emit({ kind: 'sendStatus', txnId, status: 'sent', eventId: result.event_id as EventId });
    } catch (err) {
      this.emit({
        kind: 'sendStatus',
        txnId,
        status: 'failed',
        error: { category: 'network', message: describe(err), retryable: true },
      });
      throw networkError(`editMessage failed: ${describe(err)}`);
    }
  }

  async redactMessage(
    roomId: RoomId,
    eventId: EventId,
    reason: string | null,
  ): Promise<void> {
    const c = this.requireClient();
    await c.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
  }

  async sendReaction(roomId: RoomId, eventId: EventId, key: string): Promise<void> {
    const c = this.requireClient();
    await c.sendEvent(roomId, EventType.Reaction, {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: eventId,
        key,
      },
    });
  }

  async sendTyping(roomId: RoomId, timeoutMs: number): Promise<void> {
    const c = this.requireClient();
    await c.sendTyping(roomId, timeoutMs > 0, timeoutMs);
  }

  async sendReadReceipt(roomId: RoomId, eventId: EventId): Promise<void> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    const ev = room?.findEventById(eventId);
    if (!ev) return;
    await c.sendReadReceipt(ev);
  }

  async uploadMedia(data: ArrayBuffer, mime: string, filename: string): Promise<MxcUri> {
    const c = this.requireClient();
    const blob = new Blob([data], { type: mime });
    const res = await c.uploadContent(blob, { name: filename, type: mime });
    return res.content_uri as MxcUri;
  }

  // ---------------------------------------------------------------------------
  // Phase 7 — room lifecycle: create / invite / join / leave.
  //
  // createRoom defaults to `private_chat` preset (invite-only, history
  // visible to members from join). For encrypted=true we add the
  // `m.room.encryption` state event in `initial_state` so the
  // megolm session bootstraps on creation, before any plaintext is
  // ever sent — this matters because some clients race to send a
  // greeting and Mata must never leak plaintext into an
  // accidentally-unencrypted room.
  //
  // DM detection: Matrix uses `m.direct` account-data to mark a room
  // as a DM with a specific user. We set `is_direct: true` on the
  // createRoom call AND push the {targetUserId: [roomId]} pair into
  // `m.direct` so other clients see the room in their DM list.
  // ---------------------------------------------------------------------------

  async createRoom(args: {
    name: string;
    topic: string | null;
    isDirect: boolean;
    encrypted: boolean;
    invite: UserId[];
  }): Promise<RoomId> {
    const c = this.requireClient();
    const initialState: Array<{
      type: string;
      state_key?: string;
      content: Record<string, unknown>;
    }> = [];
    if (args.encrypted) {
      // Spec: https://spec.matrix.org/v1.11/client-server-api/#mroomencryption
      initialState.push({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
    }
    // Import enums lazily so the worker bundle doesn't pay for them
    // unless someone actually creates a room.
    const { Preset, Visibility } = await import('matrix-js-sdk');
    const createOpts: Parameters<typeof c.createRoom>[0] = {
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
      is_direct: args.isDirect,
      invite: args.invite,
      initial_state: initialState as never,
    };
    if (args.name) createOpts.name = args.name;
    if (args.topic) createOpts.topic = args.topic;
    const res = await c.createRoom(createOpts);
    const roomId = res.room_id as RoomId;

    // For DMs, write the m.direct account-data entry so other clients
    // bucket the room correctly. Best-effort: a failure here doesn't
    // poison the createRoom success — the room exists either way.
    if (args.isDirect && args.invite[0]) {
      const target = args.invite[0];
      try {
        const existing =
          ((await c.getAccountDataFromServer('m.direct')) as
            | Record<string, string[]>
            | null) ?? {};
        const list = existing[target] ?? [];
        if (!list.includes(roomId)) {
          existing[target] = [...list, roomId];
          await c.setAccountData('m.direct', existing);
        }
      } catch (err) {
        console.warn('[mata] m.direct update failed', err);
      }
    }
    return roomId;
  }

  async inviteToRoom(roomId: RoomId, userId: UserId): Promise<void> {
    const c = this.requireClient();
    await c.invite(roomId, userId);
  }

  async joinRoom(roomId: RoomId): Promise<RoomId> {
    const c = this.requireClient();
    const r = await c.joinRoom(roomId);
    return (r.roomId ?? roomId) as RoomId;
  }

  async leaveRoom(roomId: RoomId): Promise<void> {
    const c = this.requireClient();
    await c.leave(roomId);
  }

  // ---------------------------------------------------------------------------
  // Members panel.
  //
  // matrix-js-sdk caches members from sync; if the room was lazy-loaded
  // (server returned only heroes) `room.getMembers()` will be a short
  // list. `loadMembersIfNeeded()` forces a /members fetch so the panel
  // is accurate. For encrypted rooms we walk the device list to derive
  // a per-user trust badge:
  //   - verified  : at least one device cross-signed AND we trust the
  //                 user's master key (master cross-signing verified).
  //   - unverified: user has master key but it's not verified by us, or
  //                 some devices remain unverified.
  //   - unknown   : user has no cross-signing yet, or device list is
  //                 empty.
  // ---------------------------------------------------------------------------

  async loadRoomMembers(roomId: RoomId): Promise<RoomMember[]> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    if (!room) throw new Error(`room ${roomId} not in store`);
    await room.loadMembersIfNeeded();

    const crypto = c.getCrypto();
    const isEncrypted = room.hasEncryptionStateEvent();
    const powerEvent = room.currentState.getStateEvents('m.room.power_levels', '');
    const powerContent = (powerEvent?.getContent() as
      | { users?: Record<string, number>; users_default?: number }
      | undefined) ?? {};
    const usersPowers = powerContent.users ?? {};
    const defaultPower = powerContent.users_default ?? 0;

    const rawMembers = room.getMembers();
    const out: RoomMember[] = [];
    for (const m of rawMembers) {
      let trust: RoomMember['trust'] = null;
      if (isEncrypted && crypto) {
        try {
          const userTrust = await crypto.getUserVerificationStatus(m.userId);
          const devices = await crypto.getUserDeviceInfo([m.userId]);
          const userDevices = devices.get(m.userId);
          if (userTrust.isCrossSigningVerified()) {
            // Master key verified. If every device is verified too,
            // call it green; otherwise still verified but with a note.
            trust = 'verified';
          } else if (userDevices && userDevices.size > 0) {
            trust = 'unverified';
          } else {
            trust = 'unknown';
          }
        } catch {
          trust = 'unknown';
        }
      }
      out.push({
        userId: m.userId as UserId,
        displayname: m.rawDisplayName ?? null,
        avatarUrl: (m.getMxcAvatarUrl() ?? null) as MxcUri | null,
        membership: (m.membership ?? 'leave') as RoomMember['membership'],
        powerLevel: usersPowers[m.userId] ?? defaultPower,
        trust,
      });
    }
    // Stable order: power level desc, then displayname.
    out.sort((a, b) => {
      if (b.powerLevel !== a.powerLevel) return b.powerLevel - a.powerLevel;
      return (a.displayname ?? a.userId).localeCompare(b.displayname ?? b.userId);
    });
    return out;
  }

  async kickFromRoom(roomId: RoomId, userId: UserId, reason: string | null): Promise<void> {
    const c = this.requireClient();
    await c.kick(roomId, userId, reason ?? undefined);
  }

  // ---------------------------------------------------------------------------
  // Room mute (Phase 12)
  //
  // We use matrix-js-sdk's `setRoomMutePushRule('global', roomId, muted)`
  // which is the documented helper for the `global.room` override
  // push rule. The shape is:
  //   muted=true  -> POST /pushrules/global/room/{roomId} with
  //                  actions:["dont_notify"] and a conditions[0]
  //                  event_match on roomId
  //   muted=false -> DELETE the rule
  //
  // The next sync delta refreshes `RoomSummary.isMuted` via toSummary
  // -> isRoomMuted (which reads back the same push rule). We return
  // the new boolean immediately so the UI doesn't have to wait for
  // a round trip through sync.
  //
  // We intentionally bypass any matrix-js-sdk TypeScript surface that
  // would force us to pre-construct a PushRule object — the helper
  // method takes the boolean directly and handles both create/delete.
  // ---------------------------------------------------------------------------

  async setRoomMuted(roomId: RoomId, muted: boolean): Promise<boolean> {
    const c = this.requireClient();
    type MuteCapable = {
      setRoomMutePushRule?: (scope: 'global', roomId: string, muted: boolean) => Promise<unknown>;
    };
    const helper = (c as unknown as MuteCapable).setRoomMutePushRule;
    if (typeof helper !== 'function') {
      // Defensive: every matrix-js-sdk we've used has this, but we
      // surface a clear error rather than failing silently if the
      // server (or a future sdk rev) drops it.
      throw new Error('Homeserver client does not support setRoomMutePushRule');
    }
    try {
      await helper.call(c, 'global', roomId, muted);
    } catch (err) {
      throw networkError(`setRoomMuted failed: ${describe(err)}`);
    }
    return muted;
  }

  // ---------------------------------------------------------------------------
  // Threads (Phase 13)
  //
  // matrix-js-sdk has a Thread abstraction (`room.getThread(rootId)`)
  // which paginates over the spec's
  //   GET /_matrix/client/v1/rooms/{roomId}/relations/{eventId}/m.thread
  // endpoint. When the SDK has loaded the thread (which it does
  // lazily when sync sees a thread relation), `thread.timelineSet`
  // contains every event in oldest-first order. When the thread
  // hasn't been instantiated yet we hit `fetchRelations` directly so
  // the panel can open immediately without waiting on the SDK's lazy
  // path.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------
  // Phase 14 — VoIP signaling helpers (worker side)
  // ---------------------------------------------------------------
  //
  // We deliberately do NOT route through matrix-js-sdk's MatrixCall
  // here. MatrixCall expects a `RTCPeerConnection` to exist, which it
  // doesn't in a Web Worker — `supportsMatrixCall()` returns false
  // and `placeVoiceCall()` would throw. Instead, the main thread owns
  // the peer connection and uses the worker as a thin signaling
  // pipe: this method calls `client.sendEvent()` with the m.call.*
  // body the caller hands us, and the timeline tap above forwards
  // inbound m.call.* back to the main thread.
  //
  // Note on encryption: in E2EE rooms matrix-js-sdk's sendEvent will
  // wrap m.call.* in m.room.encrypted by default — and that's what
  // we want. SDP/ICE candidates leak enough metadata (codecs, NAT
  // topology, ports) that the privacy guarantee of an encrypted DM
  // would be partially broken if we sent them in plaintext. The
  // receiving side's MatrixEventEvent.Decrypted handler routes the
  // post-decrypt m.call.* through to `callSignal` so the main thread
  // sees it the same way it sees plaintext-room signals.
  async sendCallEvent(
    roomId: RoomId,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<EventId> {
    const client = this.requireClient();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (client.sendEvent as any)(roomId, eventType, content);
      return res.event_id as EventId;
    } catch (err) {
      throw networkError(`sendCallEvent(${eventType}) failed: ${describe(err)}`);
    }
  }

  // /voip/turnServer is best-effort. Some homeservers (Synapse with
  // no TURN configured, Dendrite vanilla, conduit) return 404 or an
  // empty response. We fall back to the spec's public STUN list so
  // calls between hosts on the same NAT type can still try. If even
  // STUN-only fails the user sees "Couldn't connect — please share a
  // network with the other side" in the UI; that's a known TURN-less
  // limitation, not a Mata bug.
  async getTurnServers(): Promise<IceServer[]> {
    const client = this.requireClient();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await (client as any).turnServer();
      if (raw && Array.isArray(raw.uris) && raw.uris.length > 0) {
        return [
          {
            urls: raw.uris as string[],
            username: typeof raw.username === 'string' ? raw.username : undefined,
            credential: typeof raw.password === 'string' ? raw.password : undefined,
          },
        ];
      }
    } catch {
      // Server didn't expose turnServer — fall through to STUN-only.
    }
    return [{ urls: 'stun:turn.matrix.org' }];
  }

  async loadThread(roomId: RoomId, threadRootId: EventId): Promise<TimelineEvent[]> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    if (!room) throw new Error(`loadThread: room not found: ${roomId}`);

    // First, the root event itself — we always show it at the top of
    // the panel even though the thread relation list excludes it.
    const collected: MatrixEvent[] = [];
    const rootEv = room.findEventById(threadRootId);
    if (rootEv) collected.push(rootEv);

    // Try the SDK's in-memory thread store first.
    type ThreadCapable = {
      getThread?: (id: string) => { timeline?: MatrixEvent[]; events?: MatrixEvent[] } | null | undefined;
      fetchRoomThreads?: () => Promise<unknown>;
    };
    const roomCast = room as unknown as ThreadCapable;
    const thread = roomCast.getThread?.(threadRootId);
    if (thread) {
      const evs = (thread.timeline ?? thread.events ?? []) as MatrixEvent[];
      for (const e of evs) {
        if (e.getId() && e.getId() !== threadRootId) collected.push(e);
      }
    }

    // Hit the relations endpoint as a fallback / refresh. We use the
    // server pagination form to grab everything in one shot; threads
    // are typically small (<1k events) so a single page is fine. If
    // the homeserver doesn't support v1 relations (very old server)
    // matrix-js-sdk transparently downgrades to /unstable/.
    try {
      type RelationsCapable = {
        relations: (
          roomId: string,
          eventId: string,
          relationType: string | null,
          eventType: string | null,
          opts?: { dir?: 'b' | 'f'; limit?: number },
        ) => Promise<{ events?: MatrixEvent[]; chunk?: MatrixEvent[] }>;
      };
      const rel = await (c as unknown as RelationsCapable).relations(
        roomId,
        threadRootId,
        'm.thread',
        null,
        { dir: 'f', limit: 200 },
      );
      const chunk = (rel.events ?? rel.chunk ?? []) as MatrixEvent[];
      // De-duplicate by event_id — the SDK in-memory thread and the
      // server fetch overlap heavily during a refresh.
      const seen = new Set(collected.map((e) => e.getId()));
      for (const e of chunk) {
        const id = e.getId();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        collected.push(e);
      }
    } catch {
      // Server may not support v1 relations or thread may simply not
      // exist on the server yet (root just sent). Whatever we got
      // from the in-memory store is still a valid answer.
    }

    // Oldest first. MatrixEvent.getTs() returns origin_server_ts in ms.
    collected.sort((a, b) => (a.getTs() ?? 0) - (b.getTs() ?? 0));

    return collected.map((e) => toTimelineEvent(e)).filter((e): e is TimelineEvent => e !== null);
  }

  // ---------------------------------------------------------------------------
  // SAS verification. Thin pass-through to VerificationService; we keep
  // SdkSession as the single bridge target so the RPC dispatcher in
  // bridge.ts doesn't have to know about service objects.
  // ---------------------------------------------------------------------------

  async beginDeviceVerification(
    userId: UserId,
    deviceId: DeviceId,
  ): Promise<{ transactionId: string }> {
    // Forces the client to exist first; the service does its own
    // null-check but we want the more specific "Not logged in" error
    // from requireClient surfaced consistently.
    this.requireClient();
    return this.verification.begin(userId, deviceId);
  }

  async completeSasVerification(
    transactionId: string,
    result: 'match' | 'mismatch',
  ): Promise<void> {
    this.requireClient();
    await this.verification.complete(transactionId, result);
  }

  async cancelVerification(transactionId: string): Promise<void> {
    this.requireClient();
    await this.verification.cancel(transactionId);
  }

  // ---------------------------------------------------------------------------
  // Phase 6 — file / image attachments
  //
  // sendFileMessage: encrypt-then-upload (encrypted rooms) / upload-then-send
  // (plain rooms) in one call. loadMedia: download + AES-CTR decrypt for
  // received attachments. Both delegate to ./attachments.ts so the crypto
  // primitives live next to the spec, not next to the room-message send.
  // ---------------------------------------------------------------------------

  async sendFileMessage(args: {
    roomId: RoomId;
    data: ArrayBuffer;
    filename: string;
    info: import('@mata/shared/matrix').MediaInfo;
    txnId: string;
  }) {
    const c = this.requireClient();
    const { sendFileMessage } = await import('./attachments.js');
    return sendFileMessage(c, args);
  }

  async loadMedia(args: {
    mxc: MxcUri;
    encryptedFile: import('@mata/shared/matrix').EncryptedFile | null;
    mime: string;
  }) {
    const c = this.requireClient();
    const { loadMedia } = await import('./attachments.js');
    return loadMedia(c, args);
  }

  // ---------------------------------------------------------------------------
  // Phase 5.2 — encryption setup (cross-signing + SSSS + key backup)
  //
  // Implementation lives in `./encryption.ts` so the bulk of the
  // cross-signing / SSSS / backup protocol logic stays out of this
  // 1400-line file. These thin delegates only adapt the EncryptionDeps
  // shape (client + cache accessors) and forward.
  // ---------------------------------------------------------------------------

  private encryptionDeps(): import('./encryption.js').EncryptionDeps {
    return {
      client: () => this.client,
      secretStorageKeyCache: this.secretStorageKeyCache,
    };
  }

  async getEncryptionStatus() {
    const { getEncryptionStatus } = await import('./encryption.js');
    return getEncryptionStatus(this.encryptionDeps());
  }

  async listDevices() {
    const { listDevices } = await import('./encryption.js');
    return listDevices(this.encryptionDeps());
  }

  async enableKeyBackup(password: string, passphrase: string) {
    const { enableKeyBackup } = await import('./encryption.js');
    return enableKeyBackup(this.encryptionDeps(), password, passphrase);
  }

  async restoreKeyBackup(recoveryKey: string) {
    const { restoreKeyBackup } = await import('./encryption.js');
    return restoreKeyBackup(this.encryptionDeps(), recoveryKey);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private buildSdkLogger(): {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    getChild: (ns: string) => ReturnType<MatrixCore['buildSdkLogger']>;
  } {
    const surface = (level: 'info' | 'warn' | 'error', ns: string, args: unknown[]): void => {
      // Pretty-print whatever the SDK passed. The first arg is usually a
      // human string; subsequent args are often Errors or MatrixError
      // instances whose toString() drops the actual fields.
      const formatted = args
        .map((a) => {
          if (a instanceof Error) {
            const code =
              (a as { errcode?: string }).errcode ??
              (a as { name?: string }).name ??
              '';
            return `${code ? `[${code}] ` : ''}${a.message}`;
          }
          if (typeof a === 'object' && a !== null) {
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ');

      // Drop super-noisy debug paths so the UI banner doesn't churn.
      const lower = formatted.toLowerCase();
      const noisy =
        lower.includes('got reply from saved sync') ||
        lower.includes('sending initial sync request') ||
        lower.includes('event sent to') ||
        lower.includes('decryption keys requested');
      if (noisy && level !== 'error') return;

      // The smoking-gun line from client.js:454. Anything matching this
      // pattern is the silent sync-startup hang the heartbeat reports as
      // "sdk sync state: null" — surface it as a hard error.
      const silentHang =
        lower.includes('sync startup aborted') ||
        lower.includes('failed to start sync');
      if (silentHang) {
        this.emit({
          kind: 'syncStatus',
          status: 'error',
          reason: `matrix-js-sdk: ${formatted}`,
        });
        return;
      }

      // Other warn/error from the SDK get surfaced as reconnecting-tier
      // diagnostics — visible in the banner but don't flip the pill red
      // unless we're confident the error is fatal.
      if (level === 'error') {
        this.emit({
          kind: 'syncStatus',
          status: 'reconnecting',
          reason: `sdk[${ns}] error: ${formatted}`,
        });
      } else if (level === 'warn') {
        this.emit({
          kind: 'syncStatus',
          status: 'reconnecting',
          reason: `sdk[${ns}] warn: ${formatted}`,
        });
      }
    };

    const make = (ns: string): ReturnType<MatrixCore['buildSdkLogger']> => ({
      trace: () => {},
      debug: () => {},
      info: (...args: unknown[]) => surface('info', ns, args),
      warn: (...args: unknown[]) => surface('warn', ns, args),
      error: (...args: unknown[]) => surface('error', ns, args),
      getChild: (sub: string) => make(`${ns}/${sub}`),
    });

    return make('matrix');
  }

  private requireClient(): MatrixClient {
    if (!this.client) throw authError('Not logged in');
    return this.client;
  }

  private async probeSyncStartup(client: MatrixClient): Promise<void> {
    // Reproduce the SDK's startup prerequisites with explicit timeouts +
    // banner reporting. We probe in the same order matrix-js-sdk does
    // inside SyncApi.sync() so the FIRST step that hangs is the one we
    // call out. /versions is added on top because matrix-js-sdk's
    // `prepareLazyLoadingForSync` reads `canSupport` (a map seeded by an
    // implicit /versions probe) — if /versions never resolved, that map
    // is empty and downstream code can hang waiting on it.
    const withTimeout = async <T>(
      label: string,
      fn: () => Promise<T>,
      ms: number,
    ): Promise<{ ok: boolean; ms: number; detail?: string }> => {
      const started = Date.now();
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: `probing ${label}`,
      });
      try {
        await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`timeout after ${ms}ms — endpoint never responded`),
                ),
              ms,
            ),
          ),
        ]);
        const elapsed = Date.now() - started;
        this.emit({
          kind: 'syncStatus',
          status: 'connecting',
          reason: `probe ${label} ok (${elapsed}ms)`,
        });
        return { ok: true, ms: elapsed };
      } catch (err) {
        const elapsed = Date.now() - started;
        const detail =
          err instanceof Error
            ? `${(err as { errcode?: string }).errcode ? `[${(err as { errcode: string }).errcode}] ` : ''}${err.message}`
            : String(err);
        this.emit({
          kind: 'syncStatus',
          status: 'error',
          reason: `probe ${label} FAILED (${elapsed}ms): ${detail}`,
        });
        return { ok: false, ms: elapsed, detail };
      }
    };

    // 1) /_matrix/client/versions — completely unauthenticated, should
    //    never fail unless the homeserver URL is unreachable, CORS is
    //    blocking, or DNS is broken. Failing here means "this isn't a
    //    homeserver", not a token problem.
    await withTimeout('GET /versions', () => client.getVersions(), 8_000);

    // 2) GET /_matrix/client/v3/pushrules/ — first authenticated call
    //    matrix-js-sdk makes during sync startup. 401 here = bad token.
    //    Hang here = homeserver dropping authenticated requests but
    //    responding to unauthenticated ones (rare but possible behind a
    //    proxy with misconfigured auth middleware).
    await withTimeout('GET /pushrules', () => client.getPushRules(), 10_000);

    // 3) POST /_matrix/client/v3/user/{userId}/filter — second auth
    //    call. Same auth surface, but a different proxy path, so a
    //    pushrules-pass + filter-fail combo points at server config for
    //    that specific endpoint.
    await withTimeout(
      'POST /user/<id>/filter',
      async () => {
        const userId = client.getUserId();
        if (!userId) throw new Error('no userId on client (unexpected)');
        await client.createFilter({
          room: { timeline: { limit: 30 } },
        });
      },
      10_000,
    );

    // We deliberately do NOT abort startClient on probe failure — the
    // SDK has its own retry+keepalive loop and may recover. The probes
    // exist only to surface WHICH step is the bottleneck.
  }

  private async bootClient(record: SessionRecord): Promise<void> {
    // Every observable transition is announced via `syncStatus` so the UI
    // pill can pinpoint exactly which startup stage is hung. Previously
    // we always overwrote the last status with 'connecting' right before
    // `startClient`, which clobbered any crypto error we'd just emitted.
    let cryptoOk = true;
    this.emit({
      kind: 'syncStatus',
      status: 'connecting',
      reason: 'creating client',
    });

    const client = createClient({
      baseUrl: record.homeserverBaseUrl,
      accessToken: record.accessToken,
      userId: record.userId,
      deviceId: record.deviceId,
      timelineSupport: true,
      // Wire the SSSS callback so that any time the SDK needs to
      // decrypt an SSSS-protected secret (cross-signing private parts,
      // backup decryption key) it can look up the cached private bytes
      // for the matching SSSS key id. Cache is populated by
      // `enableKeyBackup` on setup and `restoreKeyBackup` on a fresh
      // device — both store the raw `Uint8Array` keyed by SSSS key id.
      // The SDK invokes us with the list of acceptable key ids; we
      // return the first one we have, or `null` to make the SDK fail
      // open with a "key not found" error the UI can surface.
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          for (const keyId of Object.keys(keys)) {
            const cached = this.secretStorageKeyCache.get(keyId);
            if (cached) return [keyId, cached];
          }
          return null;
        },
        cacheSecretStorageKey: (keyId, _info, key) => {
          this.secretStorageKeyCache.set(keyId, key);
        },
      },
      // matrix-js-sdk swallows fatal sync startup errors via
      //   logger.info("Sync startup aborted with an error:", e)
      // (see client.js#454). When the silent path triggers, syncState is
      // left at null forever — exactly the "connecting · sdk sync state:
      // null" symptom the user reported. We replace the SDK's default
      // logger with one that re-emits anything matching that signature
      // (and any `error` call from the sync code) into syncStatus.reason
      // so the cause becomes visible in the UI.
      logger: this.buildSdkLogger(),
    });
    this.client = client;
    this.currentUserId = record.userId;

    if (ENABLE_E2EE) {
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: 'loading crypto (~9MB, one-time)',
      });
      const cryptoStart = Date.now();
      try {
        const { initRustCrypto } = await import('./crypto-bootstrap.js');
        this.emit({
          kind: 'syncStatus',
          status: 'connecting',
          reason: `initializing Olm device (loaded in ${Date.now() - cryptoStart}ms)`,
        });
        // 30s timeout — first-time device upload + OTK claim can be slow,
        // but anything past this is a real hang. We race with a rejected
        // promise so we get a deterministic surface to the UI rather than
        // an infinite "connecting".
        // Track the last phase the crypto bootstrap reached so the
        // timeout error names the actual stuck step, not a guess.
        let lastPhase = 'pre-init';
        let lastPhaseAt = Date.now();
        const onCryptoPhase = (name: string, elapsed: number): void => {
          lastPhase = name;
          lastPhaseAt = Date.now();
          this.emit({
            kind: 'syncStatus',
            status: 'connecting',
            reason: `crypto: ${name} (+${elapsed}ms)`,
          });
        };
        await Promise.race([
          initRustCrypto(client, record.pickleKeyRef, CRYPTO_DB_NAME, onCryptoPhase),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `crypto init exceeded 30s; stuck in phase "${lastPhase}" for ${Date.now() - lastPhaseAt}ms (homeserver: ${record.homeserverBaseUrl})`,
                  ),
                ),
              30_000,
            ),
          ),
        ]);
        this.emit({
          kind: 'syncStatus',
          status: 'connecting',
          reason: `crypto ready (${Date.now() - cryptoStart}ms)`,
        });
      } catch (err) {
        // Account-mismatch is a well-known recoverable state: previous
        // bundle/login left a rust-crypto store keyed to a different
        // deviceId, and now this restore is trying to open it as the
        // new deviceId. The store data is unrecoverable (we don't have
        // the old device's keys), so wipe + retry once. This SHOULD be
        // unreachable on `login` (that path runs wipeStaleCryptoStores
        // proactively), but on `restoreFrom` the wipe is skipped to
        // preserve crypto keys across page reloads, so this auto-recovery
        // is the only path that handles the "user's IDB drifted from
        // session record" case.
        const msg = err instanceof Error ? err.message : String(err);
        const isAccountMismatch =
          msg.includes("account in the store doesn't match") ||
          msg.includes('account in the store does not match');
        if (isAccountMismatch) {
          this.emit({
            kind: 'syncStatus',
            status: 'connecting',
            reason: 'recovering: stale crypto store detected, wiping & retrying',
          });
          // Tear down the half-initialized client so its handles release
          // the IDB locks before we delete the underlying databases.
          await this.teardownExistingClient();
          await wipeStaleCryptoStores(this.emit.bind(this));
          // Re-enter bootClient ONCE with the same session record. If
          // this second attempt also fails, fall through to the normal
          // error path on the next throw (no infinite loop — recursion
          // is bounded because the wipe guarantees a clean store).
          this.emit({
            kind: 'syncStatus',
            status: 'connecting',
            reason: 'retrying boot after crypto wipe',
          });
          await this.bootClient(record);
          return;
        }
        cryptoOk = false;
        this.emit({
          kind: 'syncStatus',
          status: 'error',
          reason: `Crypto bootstrap failed after ${Date.now() - cryptoStart}ms: ${describe(err)}`,
        });
        // Stop here when E2EE is on but crypto failed — proceeding to
        // startClient with broken crypto causes /sync to hang indefinitely
        // on encrypted to-device messages it can't process. Fail loud.
        return;
      }
    }

    this.wireListeners(client);
    if (cryptoOk) {
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: 'starting sync',
      });
    }
    // Before letting matrix-js-sdk run its hidden sync-startup sequence
    // (getPushRules → prepareLazyLoadingForSync → storeClientOptions →
    // getFilter), probe each prerequisite endpoint OURSELVES with a 10s
    // timeout. The SDK awaits these silently and, if any one HANGS
    // (rather than throws), syncState stays null forever and no logger
    // line ever fires. That matches exactly what the user is reporting.
    // Probing here makes the failing step obvious before we even kick
    // off startClient. Each probe failure is non-fatal — we surface it
    // and keep going so /sync still runs if a later step recovers.
    await this.probeSyncStartup(client);

    const opts: IStartClientOpts = {
      initialSyncLimit: 30,
      lazyLoadMembers: true,
    };
    // Bookend startClient so we can distinguish "SDK is hanging inside
    // its prerequisite chain (getFilter/getPushRules/etc.) before the
    // first /sync" from "SDK started fine but never reaches PREPARED".
    // The "started" line should appear within milliseconds; if it doesn't,
    // startClient itself is blocked on a synchronous step. Combined with
    // the fetch tracer in bridge.ts, the banner tells us exactly which
    // step is wedged.
    this.emit({
      kind: 'syncStatus',
      status: 'connecting',
      reason: 'invoking client.startClient',
    });
    const startClientAt = Date.now();
    try {
      await client.startClient(opts);
      // Hook the verification service to incoming requests. Safe to
      // call before /sync returns first batch — it only attaches a
      // listener, doesn't query anything.
      this.verification.attachIncomingListener();
    } catch (err) {
      this.emit({
        kind: 'syncStatus',
        status: 'error',
        reason: `startClient failed: ${describe(err)}`,
      });
      throw err;
    }
    this.emit({
      kind: 'syncStatus',
      status: 'connecting',
      reason: `client.startClient returned (${Date.now() - startClientAt}ms) — awaiting /sync`,
    });
    // WATCHDOG: observe crypto.onSyncCompleted (do NOT race / release).
    //
    // Earlier (db9bef9a) this raced onSyncCompleted against a 10s timeout
    // and resolved the watchdog branch if the real call hadn't returned.
    // That was wrong. After resetting crypto to a brand new device on a
    // 99-room account, the user still saw "exceeded 10s" — fresh store,
    // so it can't be on-disk corruption. The smoking gun was two timeouts
    // 200ms apart (call #1 +16.6s, call #2 +16.8s): if the watchdog
    // resolves to undefined, matrix-js-sdk thinks onSyncCompleted finished
    // and fires the next /sync. Its onSyncCompleted starts while the
    // PREVIOUS real wasm call is still mid-flight. They serialize on
    // IndexedDB, each one runs slower than the last, and we get a cascade
    // of false "deadlock" alarms.
    //
    // It's not a deadlock — on first sync after fresh login with 99 rooms,
    // wasm legitimately has to process device-list updates and to-device
    // events for every member of every room. That can take >10s on a
    // single-threaded wasm + IDB pipeline. Releasing the sync loop early
    // turned a slow-but-finite catchup into a self-induced congestion
    // collapse.
    //
    // New behavior: log progressively, but never short-circuit. We await
    // the real call. matrix-js-sdk's natural backpressure (one sync at a
    // time) is preserved. Tags >2s, >5s, >15s, >30s as the call runs so
    // the banner shows "this is slow, still working" instead of "broken".
    // If a real deadlock ever happens, the banner will sit at >30s and we
    // can decide then; the current shape stops manufacturing the problem.
    if (ENABLE_E2EE) {
      try {
        type CryptoApiLike = {
          onSyncCompleted?: (data: unknown) => Promise<void> | void;
        };
        const crypto = (client.getCrypto?.() as CryptoApiLike | undefined) ?? undefined;
        if (crypto && typeof crypto.onSyncCompleted === 'function') {
          const original = crypto.onSyncCompleted.bind(crypto);
          let nthCall = 0;
          crypto.onSyncCompleted = async (data: unknown): Promise<void> => {
            const callId = ++nthCall;
            const startedAt = Date.now();
            // Fire-and-forget progress beacons. Each beacon clears itself
            // when the real call resolves.
            let finished = false;
            const beacons: ReturnType<typeof setTimeout>[] = [];
            const beacon = (ms: number, label: string): void => {
              beacons.push(
                setTimeout(() => {
                  if (finished) return;
                  this.emit({
                    kind: 'diagNote',
                    note: `crypto.onSyncCompleted call #${callId} still running at ${label} (first-sync catchup may be heavy; not releasing the loop)`,
                  });
                }, ms),
              );
            };
            beacon(2_000, '2s');
            beacon(5_000, '5s');
            beacon(15_000, '15s');
            beacon(30_000, '30s');
            try {
              await original(data);
              finished = true;
              for (const id of beacons) clearTimeout(id);
              const dur = Date.now() - startedAt;
              if (dur > 2_000) {
                this.emit({
                  kind: 'diagNote',
                  note: `crypto.onSyncCompleted call #${callId} completed in ${dur}ms`,
                });
              }
            } catch (err) {
              finished = true;
              for (const id of beacons) clearTimeout(id);
              this.emit({
                kind: 'syncStatus',
                status: 'reconnecting',
                reason: `crypto.onSyncCompleted call #${callId} rejected after ${Date.now() - startedAt}ms: ${describe(err)}`,
              });
              // Swallow — the SDK does not want us to throw from this hook.
            }
          };
          this.emit({
            kind: 'diagNote',
            note: 'watchdog: crypto.onSyncCompleted instrumented (observe-only, no release)',
          });
        }
      } catch (err) {
        // Wrapping is best-effort — if the crypto object shape doesn't
        // match expectations on this SDK version, skip silently rather
        // than block sync startup.
        this.emit({
          kind: 'syncStatus',
          status: 'connecting',
          reason: `watchdog: could not wrap crypto.onSyncCompleted (${describe(err)})`,
        });
      }
    }
    // Heartbeat poll on the SDK's internal sync state. ClientEvent.Sync
    // only fires on transitions — if the SDK gets stuck in an
    // intermediate state (e.g. waiting on /sync, processing a slow
    // initial batch, gated on crypto), the pill stays at "starting sync"
    // with no signal about what's actually happening. This loop surfaces
    // the live SDK state into the banner so we can see exactly where it
    // is — Prepared / Syncing turn the pill green; anything else is
    // reported verbatim alongside the last /sync error if any.
    // 1s heartbeat so the gap between "startClient returned" and a live
    // sync state is no longer a 4s black box. The home.tsx log dedupes
    // identical consecutive entries, so quiet stretches still collapse
    // to one line — the timestamp difference between that line and the
    // next event tells us exactly how long the SDK was wedged.
    let tick = 0;
    const heartbeat = setInterval(() => {
      tick += 1;
      const state = client.getSyncState();
      if (state === 'PREPARED' || state === 'SYNCING') return;
      const data = client.getSyncStateData();
      const dataErr =
        data && typeof data === 'object' && 'error' in data && data.error
          ? ` (last error: ${describe((data as { error: unknown }).error)})`
          : '';
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: `sdk sync state: ${state ?? 'null'} [t+${tick}s]${dataErr}`,
      });
    }, 1_000);
    // Stop the heartbeat once the SDK reaches a live state — there's no
    // need to keep flooding the pill with redundant status updates.
    // Also flip the bridge's fetch tracer out of startup-trace mode so
    // steady-state /sync long-polls collapse by endpoint family.
    const onSyncLive = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        clearInterval(heartbeat);
        client.off(ClientEvent.Sync, onSyncLive);
        const disable = (
          self as unknown as { __mata_disableStartupTrace?: () => void }
        ).__mata_disableStartupTrace;
        if (typeof disable === 'function') disable();
      }
    };
    client.on(ClientEvent.Sync, onSyncLive);
  }

  private wireListeners(client: MatrixClient): void {
    client.on(ClientEvent.Sync, (state: SyncState, _prev: SyncState | null, data?: unknown) => {
      // Pull the error payload off the data object — matrix-js-sdk attaches
      // the last network/HTTP error there on Reconnecting/Catchup/Error,
      // and without surfacing it the user just sees "reconnecting" with no
      // explanation. Common shapes: { error: MatrixError }, MatrixError
      // (HTTP 401/403/429/5xx), or fetch TypeError (CORS, DNS, offline).
      const errPayload =
        data && typeof data === 'object' && 'error' in data
          ? (data as { error: unknown }).error
          : undefined;
      const errStr = errPayload ? `: ${describe(errPayload)}` : '';
      switch (state) {
        case SyncState.Prepared:
        case SyncState.Syncing:
          this.emit({
            kind: 'syncStatus',
            status: 'syncing',
            reason: state === SyncState.Prepared
              ? `prepared (rooms: ${client.getRooms().length})`
              : undefined,
          });
          if (state === SyncState.Prepared) this.emitInitialRooms(client);
          break;
        case SyncState.Reconnecting:
        case SyncState.Catchup:
          this.emit({
            kind: 'syncStatus',
            status: 'reconnecting',
            reason: `sdk: ${state}${errStr}`,
          });
          break;
        case SyncState.Error:
          this.emit({
            kind: 'syncStatus',
            status: 'error',
            reason: errPayload ? describe(errPayload) : (data instanceof Error ? data.message : 'sync error'),
          });
          break;
        case SyncState.Stopped:
          this.emit({ kind: 'syncStatus', status: 'idle' });
          break;
      }
    });

    client.on(RoomEvent.Timeline, (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
      _removed: boolean,
      data: IRoomTimelineData,
    ) => {
      if (!room || toStartOfTimeline) return;
      if (!data.liveEvent) return;

      // Phase 14 — VoIP signaling tap. We catch m.call.* events
      // BEFORE they hit `toTimelineEvent` (which only knows about
      // message / member / redaction shapes) and forward them to the
      // main thread, where the actual peer connection lives. We
      // include encrypted-room re-deliveries: in an E2EE room, the
      // call signaling body lives inside the decrypted m.room.message
      // wrapper... wait, no — by spec m.call.* events are NOT wrapped
      // in m.room.encrypted; they're sent as plaintext top-level
      // events even in E2EE rooms. Element matches; we follow suit.
      const type = event.getType();
      if (type.startsWith('m.call.')) {
        const content = event.getContent() as Record<string, unknown>;
        const sender = (event.getSender() ?? '') as UserId;
        // Drop local echoes only. matrix-js-sdk surfaces `Room.timeline`
        // twice for each send: first as an unconfirmed local echo
        // (event.status !== null), then as a server-confirmed sync
        // delivery (event.status === null). We forward only the latter.
        //
        // Importantly we do NOT filter by sender MXID here. Previously
        // we dropped all events where `sender === client.getUserId()`,
        // which silently broke same-account multi-device testing — the
        // user's other device's invites never reached the main thread.
        // Same-device echo filtering is handled in the main-thread
        // routeSignal layer by comparing the event's `party_id` against
        // our active CallSession's partyId (which is the canonical
        // per-device identity in MSC2746).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status = (event as any).status;
        if (status != null) return;
        const partyId =
          typeof content.party_id === 'string' ? content.party_id : null;
        const ageMs = (() => {
          const ts = event.getTs();
          return ts ? Math.max(0, Date.now() - ts) : 0;
        })();
        this.emit({
          kind: 'callSignal',
          roomId: room.roomId as RoomId,
          eventType: type,
          sender,
          partyId,
          ageMs,
          content,
        });
        return;
      }

      const tev = toTimelineEvent(event);
      if (!tev) return;
      this.emit({
        kind: 'syncUpdate',
        deltas: [
          {
            roomId: room.roomId as RoomId,
            summary: partialSummary(room, client),
            newEvents: [tev],
          },
        ],
        nextBatch: client.getSyncStateData()?.nextSyncToken ?? '',
      });
    });

    // ---- Decryption updates --------------------------------------------
    // RoomEvent.Timeline fires with the event still in its m.room.encrypted
    // shape (decryption is async). We forward that placeholder so the UI
    // can show a "decrypting…" slot. Once matrix-js-sdk finishes the wasm
    // decrypt, it fires MatrixEventEvent.Decrypted on the event object —
    // the type internally flips from m.room.encrypted to m.room.message
    // (or stays encrypted on failure). Without this re-emit the live tab
    // shows the encrypted placeholder forever; only a refresh (which
    // re-reads the post-decrypt timeline) makes the message appear. This
    // was the "friend replied, didn't see it until refresh" symptom.
    client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent) => {
      const roomId = event.getRoomId();
      if (!roomId) return;
      const room = client.getRoom(roomId);
      if (!room) return;

      // Phase 14 — VoIP signaling tap (encrypted-room path). In an
      // E2EE room m.call.* events ride inside m.room.encrypted; the
      // RoomEvent.Timeline tap above sees the encrypted wrapper and
      // skips it because `type !== m.call.*`. After matrix-js-sdk
      // finishes wasm decrypt it flips the event type to its inner
      // value and fires this Decrypted callback — that's the only
      // place we can catch decrypted call signals. Without this branch
      // calls in encrypted DMs simply never ring on the receiver: the
      // invite arrives but nothing routes it to the main thread.
      const type = event.getType();
      if (type.startsWith('m.call.')) {
        const content = event.getContent() as Record<string, unknown>;
        const sender = (event.getSender() ?? '') as UserId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status = (event as any).status;
        if (status != null) return;
        const partyId =
          typeof content.party_id === 'string' ? content.party_id : null;
        const ageMs = (() => {
          const ts = event.getTs();
          return ts ? Math.max(0, Date.now() - ts) : 0;
        })();
        this.emit({
          kind: 'callSignal',
          roomId: roomId as RoomId,
          eventType: type,
          sender,
          partyId,
          ageMs,
          content,
        });
        return;
      }

      const tev = toTimelineEvent(event);
      if (!tev) return;
      this.emit({
        kind: 'syncUpdate',
        deltas: [
          {
            roomId: roomId as RoomId,
            summary: partialSummary(room, client),
            newEvents: [tev],
          },
        ],
        nextBatch: client.getSyncStateData()?.nextSyncToken ?? '',
      });
    });

    client.on(RoomEvent.Name, (room: Room) => this.emitRoomDelta(room));
    client.on(RoomEvent.AccountData, (_ev: MatrixEvent, room: Room) => this.emitRoomDelta(room));
    client.on(RoomEvent.Receipt, (_ev: MatrixEvent, room: Room) => this.emitRoomDelta(room));
    client.on(RoomStateEvent.Members, (_ev: MatrixEvent, _state, member) => {
      const room = client.getRoom(member.roomId);
      if (room) this.emitRoomDelta(room);
    });

    client.on(RoomMemberEvent.Typing, (_ev: MatrixEvent, member) => {
      const room = client.getRoom(member.roomId);
      if (!room) return;
      this.emit({
        kind: 'typing',
        roomId: room.roomId as RoomId,
        userIds: room.currentState
          .getMembers()
          .filter((m) => m.typing)
          .map((m) => m.userId as UserId),
      });
    });
  }

  private emitInitialRooms(client: MatrixClient): void {
    const deltas: RoomDelta[] = client.getRooms().map((r) => ({
      roomId: r.roomId as RoomId,
      summary: toSummary(r, client),
      newEvents: [],
    }));
    if (deltas.length === 0) return;
    this.emit({
      kind: 'syncUpdate',
      deltas,
      nextBatch: client.getSyncStateData()?.nextSyncToken ?? '',
    });
  }

  private emitRoomDelta(room: Room): void {
    const c = this.client;
    if (!c) return;
    this.emit({
      kind: 'syncUpdate',
      deltas: [
        {
          roomId: room.roomId as RoomId,
          summary: partialSummary(room, c),
          newEvents: [],
        },
      ],
      nextBatch: c.getSyncStateData()?.nextSyncToken ?? '',
    });
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

/**
 * Wipe IndexedDB databases that hold rust-crypto-sdk state from a
 * previous device login.
 *
 * matrix-js-sdk's rust-crypto pipeline opens an IDB store named with the
 * `RUST_SDK_STORE_PREFIX` constant ("matrix-js-sdk"); matrix-sdk-crypto-wasm
 * creates one or more child databases under that prefix. When a user logs
 * in fresh, the server allocates a NEW deviceId. The OlmMachine then
 * compares the account it finds in the existing store (which still
 * belongs to the previous device) against the constructor's
 * (userId, deviceId) pair, finds a mismatch, and throws:
 *
 *    the account in the store doesn't match the account in the
 *    constructor: expected @user:host:OLD_DEVICE, got @user:host:NEW_DEVICE
 *
 * The original device's keys are unrecoverable without that device's
 * pickle key anyway, so the only safe move is to discard the stale
 * crypto state and let bootClient initialise a fresh store for the new
 * device. This is the same recovery path Element-web takes when its
 * "clear storage" button is pressed.
 *
 * `indexedDB.databases()` is available in modern Chromium/Safari/Firefox
 * (and is exposed inside DedicatedWorkerGlobalScope). When unavailable
 * (e.g. older browsers, polyfilled jsdom tests) we fall back to deleting
 * known names from the SDK.
 */
async function wipeStaleCryptoStores(
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  const PREFIX = 'matrix-js-sdk';
  const wiped: string[] = [];
  try {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return;
    let names: string[] = [];
    if (typeof (idb as { databases?: unknown }).databases === 'function') {
      const list = (await idb.databases()) as Array<{ name?: string }>;
      names = list
        .map((d) => d.name ?? '')
        .filter((n) => n && n.startsWith(PREFIX));
    } else {
      // Fallback: delete the well-known names matrix-js-sdk + rust-crypto
      // historically create. deleteDatabase is a no-op if the DB does
      // not exist, so listing extras here is harmless.
      names = [
        `${PREFIX}::matrix-sdk-crypto`,
        `${PREFIX}::matrix-sdk-crypto-meta`,
        `${PREFIX}:crypto`,
        `${PREFIX}:riot-web-sync`,
      ];
    }
    for (const name of names) {
      await new Promise<void>((resolve) => {
        const req = idb.deleteDatabase(name);
        req.onsuccess = () => {
          wiped.push(name);
          resolve();
        };
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  } catch (err) {
    // Best-effort: if wiping fails, bootClient will surface the real
    // bootstrap error and the user can fall back to a manual reset.
    emit({
      kind: 'syncStatus',
      status: 'error',
      reason: `crypto store wipe failed: ${(err as Error)?.message ?? String(err)}`,
    });
    return;
  }
  if (wiped.length > 0) {
    emit({
      kind: 'syncStatus',
      status: 'connecting',
      reason: `wiped ${wiped.length} stale crypto store(s): ${wiped.join(', ')}`,
    });
  }
}

function mapLoginError(err: unknown): Error {
  const msg = describe(err);
  // Match on Matrix error codes only — never on free-text substrings, which
  // misclassified transport-layer errors as auth failures (the `M_INVALID_USERNAME`
  // → "Invalid username or password" confusion that masked the real bug for hours).
  if (/M_FORBIDDEN|M_UNKNOWN_TOKEN|M_MISSING_TOKEN|M_BAD_JSON/i.test(msg)) {
    return authError('Invalid username or password');
  }
  if (/M_USER_IN_USE|M_INVALID_USERNAME/i.test(msg)) {
    return authError('That username is not accepted by this homeserver');
  }
  if (/M_LIMIT_EXCEEDED/i.test(msg)) {
    return authError('Too many attempts — wait a moment and try again');
  }
  if (/M_USER_DEACTIVATED/i.test(msg)) {
    return authError('This account has been deactivated');
  }
  return authError(`Sign-in failed: ${msg.slice(0, 300)}`);
}

function classifyRoom(room: Room): 'dm' | 'room' | 'space' {
  if (room.isSpaceRoom?.()) return 'space';
  if (room.getDMInviter() || (room.getJoinedMemberCount?.() === 2 && !room.isSpaceRoom?.())) return 'dm';
  return 'room';
}

function toSummary(room: Room, client: MatrixClient): RoomSummary {
  const last = room.getLiveTimeline().getEvents().slice(-1)[0];
  return {
    roomId: room.roomId as RoomId,
    type: classifyRoom(room),
    name: room.name || room.roomId,
    topic: (room.currentState.getStateEvents(EventType.RoomTopic, '') as MatrixEvent | null)?.getContent()?.topic ?? null,
    avatarUrl: (room.getMxcAvatarUrl() ?? null) as MxcUri | null,
    unreadCount: room.getUnreadNotificationCount(),
    highlightCount: room.getUnreadNotificationCount('highlight'),
    lastActivityTs: last?.getTs() ?? 0,
    lastEventPreview: last ? extractPreview(last) : null,
    isEncrypted: room.hasEncryptionStateEvent(),
    isMuted: isRoomMuted(client, room.roomId as RoomId),
    membership: (room.getMyMembership() as 'join' | 'invite' | 'leave') ?? 'leave',
  };
}

/**
 * Detect mute via the canonical Matrix push rule: a room-override
 * rule under `global.room` whose rule_id matches the roomId and whose
 * actions list does NOT include `notify`. matrix-js-sdk surfaces these
 * through `client.getRoomPushRule('global', roomId)`. Returns false
 * for any error / missing rule (the default), so an unconfigured room
 * reads as unmuted.
 */
function isRoomMuted(client: MatrixClient, roomId: RoomId): boolean {
  try {
    // getRoomPushRule has been on matrix-js-sdk's Client for a long
    // time but isn't in its public typings; cast through unknown to
    // reach the runtime method without weakening the rest of the file.
    const rule = (client as unknown as {
      getRoomPushRule?: (scope: 'global', roomId: string) => { actions?: unknown[] } | undefined;
    }).getRoomPushRule?.('global', roomId);
    if (!rule) return false;
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    // Per Matrix spec: a rule notifies iff its actions list contains
    // the bare string `'notify'`. Anything else (`'dont_notify'`,
    // empty list, `set_tweak` entries only) is muted.
    return !actions.some((a) => a === 'notify');
  } catch {
    return false;
  }
}

function partialSummary(room: Room, client: MatrixClient): Partial<RoomSummary> {
  return toSummary(room, client);
}

function extractPreview(ev: MatrixEvent): string | null {
  if (ev.isRedacted()) return '(message deleted)';
  if (ev.isDecryptionFailure()) return '(encrypted message)';
  const type = ev.getType();
  if (type === EventType.RoomMessage) {
    const c = ev.getContent();
    if (c.msgtype === MsgType.Text || c.msgtype === MsgType.Emote || c.msgtype === MsgType.Notice) {
      return typeof c.body === 'string' ? c.body : null;
    }
    if (c.msgtype === MsgType.Image) return '📷 Image';
    if (c.msgtype === MsgType.Video) return '🎬 Video';
    if (c.msgtype === MsgType.File) return '📎 File';
    if (c.msgtype === MsgType.Audio) return '🎙 Audio';
  }
  if (type === EventType.RoomMember) {
    const c = ev.getContent();
    if (c.membership === 'join') return `${ev.getSender()} joined`;
    if (c.membership === 'leave') return `${ev.getSender()} left`;
  }
  return null;
}

function toTimelineEvent(ev: MatrixEvent): TimelineEvent | null {
  const type = ev.getType();
  const sender = ev.getSender();
  if (!sender) return null;
  const base = {
    eventId: ev.getId() as EventId,
    roomId: ev.getRoomId() as RoomId,
    sender: sender as UserId,
    originServerTs: ev.getTs(),
  } as const;

  if (type === EventType.RoomMessage) {
    const c = ev.getContent();
    const body = decodeMessageBody(c);
    return {
      type: 'm.room.message',
      ...base,
      content: body,
      reactions: [],
      edits: ev.replacingEventId() ? [ev.replacingEventId() as EventId] : [],
      // `inReplyTo` is set whenever the event carries an
      // m.in_reply_to relation, including the fallback chain inside a
      // thread. `threadRoot` is set ONLY when rel_type is m.thread —
      // otherwise it would collide with regular reply chains, which
      // use the same `event_id` key under `m.relates_to`.
      inReplyTo: (c['m.relates_to']?.['m.in_reply_to']?.event_id as EventId | undefined) ?? null,
      threadRoot:
        c['m.relates_to']?.rel_type === 'm.thread'
          ? ((c['m.relates_to']?.event_id as EventId | undefined) ?? null)
          : null,
    };
  }
  if (type === EventType.RoomEncrypted) {
    return {
      type: 'm.room.encrypted',
      ...base,
      decryptionStatus: ev.isDecryptionFailure() ? 'failed' : 'pending',
      failureReason: ev.isDecryptionFailure() ? 'decryption failed' : null,
    };
  }
  if (type === EventType.RoomMember) {
    const c = ev.getContent();
    return {
      type: 'm.room.member',
      ...base,
      target: (ev.getStateKey() ?? '') as UserId,
      membership: (c.membership ?? 'leave') as 'join' | 'leave' | 'invite' | 'ban' | 'knock',
      displayname: typeof c.displayname === 'string' ? c.displayname : null,
      avatarUrl: typeof c.avatar_url === 'string' ? (c.avatar_url as MxcUri) : null,
    };
  }
  if (type === EventType.RoomRedaction) {
    return {
      type: 'm.room.redaction',
      ...base,
      redacts: (ev.event.redacts ?? '') as EventId,
      reason: typeof ev.getContent()?.reason === 'string' ? (ev.getContent().reason as string) : null,
    };
  }
  return null;
}

function encodeMessageBody(body: MessageBody): IContent {
  // MSC3952 intentional mentions: attach as `m.mentions` when present,
  // so push rules on the homeserver fire correctly even when the body
  // text has no display-name match. We merge it onto every text-ish
  // result via the helper below to avoid duplicating the spread in
  // each branch (text formatted vs unformatted etc).
  const withMentions = <T extends Record<string, unknown>>(out: T): T => {
    if (body.msgtype !== 'm.text' && body.msgtype !== 'm.emote' && body.msgtype !== 'm.notice') {
      return out;
    }
    const m = body.mentions;
    if (!m) return out;
    const payload: { user_ids?: string[]; room?: true } = {};
    if (m.userIds && m.userIds.length > 0) payload.user_ids = m.userIds;
    if (m.room) payload.room = true;
    if (Object.keys(payload).length === 0) return out;
    return { ...out, 'm.mentions': payload };
  };

  switch (body.msgtype) {
    case 'm.text':
      return withMentions(
        body.formattedBody
          ? {
              msgtype: MsgType.Text,
              body: body.body,
              format: 'org.matrix.custom.html',
              formatted_body: body.formattedBody,
            }
          : { msgtype: MsgType.Text, body: body.body },
      );
    case 'm.emote':
      return withMentions({ msgtype: MsgType.Emote, body: body.body });
    case 'm.notice':
      return withMentions({ msgtype: MsgType.Notice, body: body.body });
    case 'm.image':
      return { msgtype: MsgType.Image, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.video':
      return { msgtype: MsgType.Video, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.audio':
      return { msgtype: MsgType.Audio, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.file':
      return { msgtype: MsgType.File, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.location':
      return { msgtype: 'm.location', body: body.body, geo_uri: body.geoUri };
  }
}

function mediaInfo(info: MediaInfo): Record<string, unknown> {
  return {
    mimetype: info.mimetype,
    size: info.size,
    ...(info.width !== undefined ? { w: info.width } : {}),
    ...(info.height !== undefined ? { h: info.height } : {}),
    ...(info.duration !== undefined ? { duration: info.duration } : {}),
    ...(info.thumbnailUrl !== undefined ? { thumbnail_url: info.thumbnailUrl } : {}),
    ...(info.blurhash !== undefined ? { 'xyz.amorgan.blurhash': info.blurhash } : {}),
  };
}

function decodeMessageBody(c: IContent): MessageBody {
  const msgtype = (c.msgtype ?? MsgType.Text) as string;
  const body = typeof c.body === 'string' ? c.body : '';
  // MSC3952 mentions on the receive side. We pluck this out once and
  // merge it into the structured text variants; matrix-js-sdk does
  // *not* surface this field at the typed-event layer, so the cast
  // to a record is unavoidable.
  const decodeMentions = (): { userIds: UserId[]; room?: boolean } | undefined => {
    const raw = (c as Record<string, unknown>)['m.mentions'];
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { user_ids?: unknown; room?: unknown };
    const userIds: UserId[] = Array.isArray(r.user_ids)
      ? r.user_ids.filter((u): u is UserId => typeof u === 'string' && u.startsWith('@'))
      : [];
    const isRoom = r.room === true;
    if (userIds.length === 0 && !isRoom) return undefined;
    const out: { userIds: UserId[]; room?: boolean } = { userIds };
    if (isRoom) out.room = true;
    return out;
  };
  switch (msgtype) {
    case MsgType.Text: {
      const mentions = decodeMentions();
      const base: MessageBody = {
        msgtype: 'm.text',
        body,
        formattedBody:
          c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string'
            ? c.formatted_body
            : null,
      };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Emote: {
      const mentions = decodeMentions();
      const base: MessageBody = { msgtype: 'm.emote', body };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Notice: {
      const mentions = decodeMentions();
      const base: MessageBody = { msgtype: 'm.notice', body };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Image:
      return {
        msgtype: 'm.image',
        body,
        url: (c.url ?? '') as MxcUri,
        info: decodeMediaInfo(c.info),
      };
    case MsgType.Video:
      return {
        msgtype: 'm.video',
        body,
        url: (c.url ?? '') as MxcUri,
        info: decodeMediaInfo(c.info),
      };
    case MsgType.Audio:
      return {
        msgtype: 'm.audio',
        body,
        url: (c.url ?? '') as MxcUri,
        info: decodeMediaInfo(c.info),
      };
    case MsgType.File:
      return {
        msgtype: 'm.file',
        body,
        url: (c.url ?? '') as MxcUri,
        info: decodeMediaInfo(c.info),
      };
    default:
      return { msgtype: 'm.text', body, formattedBody: null };
  }
}

function decodeMediaInfo(info: unknown): MediaInfo {
  const i = (info ?? {}) as Record<string, unknown>;
  return {
    mimetype: typeof i.mimetype === 'string' ? i.mimetype : 'application/octet-stream',
    size: typeof i.size === 'number' ? i.size : 0,
    ...(typeof i.w === 'number' ? { width: i.w } : {}),
    ...(typeof i.h === 'number' ? { height: i.h } : {}),
    ...(typeof i.duration === 'number' ? { duration: i.duration } : {}),
    ...(typeof i.thumbnail_url === 'string' ? { thumbnailUrl: i.thumbnail_url as MxcUri } : {}),
    ...(typeof i['xyz.amorgan.blurhash'] === 'string' ? { blurhash: i['xyz.amorgan.blurhash'] as string } : {}),
  };
}
