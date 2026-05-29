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
  RelationType,
  PendingEventOrdering,
  IndexedDBStore,
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
  RoomEncryptedEvent,
  UserId,
  DeviceId,
  RoomId,
  EventId,
  MessageBody,
  MediaMessageBody,
  EncryptedFile,
  MxcUri,
  MediaInfo,
  RoomDelta,
  SearchHit,
} from '@mata/shared/matrix';
import { authError, networkError, syncError } from '@mata/shared/errors';
import type { WorkerEvent } from '@mata/shared/rpc';
import type { IceServer, UrlPreview, UserSearchHit } from '@mata/shared/rpc';
import { parseHsPreview, fetchPreviewViaProxy, fetchPreviewClientSide } from './preview.js';
import { VerificationService } from './verification.js';
import {
  type SessionRecord,
  saveSession,
  clearSession,
  touchSession,
} from './session-store.js';
import { clearMediaCache } from './media-cache.js';

// Helpers split out to sdk-helpers.ts so this file stays under the
// per-arg size limit when committed via the Contents API. The runtime
// behaviour is unchanged.
import {
  normalizeServerUrl,
  wipeStaleCryptoStores,
  mapLoginError,
  classifyRoom,
  toSummary,
  isRoomMuted,
  partialSummary,
  extractPreview,
  categorizeFailure,
  toTimelineEvent,
  buildReplyFallback,
  buildReplyFallbackHtml,
  escapeHtmlForForward,
  stripReplyFallback,
  encodeMessageBody,
  mediaInfo,
  decodeMessageBody,
  decodeEncryptedFile,
  decodeMediaInfo,
} from './sdk-helpers.js';

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

  /** Foreground room; sync-tick reconcile re-emits its tail (see Sync handler). */
  private subscribedRoomId: RoomId | null = null;
  /** Tail size re-emitted per reconcile; UI dedupes by eventId. */
  private static readonly RECONCILE_TAIL_SIZE = 60;

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
    // Drop the per-account decrypted media cache so a different
    // account signing in next can't see the previous user's plaintext.
    await clearMediaCache();
  }

  async listRoomSummaries(): Promise<RoomSummary[]> {
    const c = this.requireClient();
    return c.getRooms().map((r) => toSummary(r, c));
  }

  subscribeRoom(roomId: RoomId): void {
    this.subscribedRoomId = roomId;
    this.emitSubscribedRoomTail(); // immediate reconcile; bails if client null
  }

  unsubscribeRoom(): void {
    this.subscribedRoomId = null;
  }

  /**
   * Re-emit the subscribed room's live-timeline tail as a syncUpdate
   * delta (idempotent — UI dedupes by eventId). Catches events that
   * slipped through RoomEvent.Timeline / MatrixEventEvent.Decrypted on
   * reconnect / gap-fill paths, where the UI lags the SDK's state.
   */
  private emitSubscribedRoomTail(): void {
    const c = this.client;
    if (!c) return;
    const rid = this.subscribedRoomId;
    if (!rid) return;
    const room = c.getRoom(rid);
    if (!room) return;
    const live = room.getLiveTimeline().getEvents();
    if (live.length === 0) return;
    const tail = live.slice(-SdkSession.RECONCILE_TAIL_SIZE);
    const events: TimelineEvent[] = [];
    for (const e of tail) {
      const tev = toTimelineEvent(e);
      if (tev) events.push(tev);
    }
    if (events.length === 0) return;
    this.emit({
      kind: 'syncUpdate',
      deltas: [
        {
          roomId: rid,
          summary: partialSummary(room, c),
          newEvents: events,
        },
      ],
      nextBatch: c.getSyncStateData()?.nextSyncToken ?? '',
    });
  }

  async loadRoomHistory(
    roomId: RoomId,
    fromToken: string | null,
    limit: number,
  ): Promise<{ events: TimelineEvent[]; prevToken: string | null; readUpToEventId: string | null }> {
    const c = this.requireClient();
    // Cold-start race: the IndexedDB room-list cache paints rooms
    // before the SDK's first /sync populates client state. If the user
    // clicks one of those cached rows during the gap, c.getRoom is
    // null and the old code threw "Unknown room" immediately. Poll
    // briefly — sync.Room arrives on the very next delta in the
    // typical case (a few hundred ms after auth on a warm session,
    // up to a few seconds on the first cold sync).
    let room = c.getRoom(roomId);
    if (!room) {
      const deadline = Date.now() + 8000;
      while (!room && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        room = c.getRoom(roomId);
      }
    }
    if (!room) throw syncError(`Unknown room ${roomId}`);
    const liveTimeline = room.getLiveTimeline();
    if (fromToken !== null) {
      // matrix-js-sdk's paginateEventTimeline ignores fromToken; it uses the
      // timeline's own backward token. We accept fromToken purely as the
      // contract-stable name for "page more", and trigger a backward page.
      await c.paginateEventTimeline(liveTimeline, { backwards: true, limit });
    }
    const events = liveTimeline.getEvents();
    // Read-marker anchor for the unread divider: the user's own
    // read-receipt up-to event id captured now, before the UI's
    // post-load markLatestRead advances it. `false` = real server-acked
    // position, not synthetic. Initial page only; UI freezes it.
    let readUpToEventId: string | null = null;
    if (fromToken === null) {
      const me = c.getUserId();
      try {
        readUpToEventId = me ? room.getEventReadUpTo(me, false) : null;
      } catch {
        readUpToEventId = null;
      }
    }
    return {
      events: events.map((e) => toTimelineEvent(e)).filter((e): e is TimelineEvent => e !== null),
      prevToken: liveTimeline.getPaginationToken('b' as unknown as Parameters<typeof liveTimeline.getPaginationToken>[0]),
      readUpToEventId,
    };
  }

  async sendMessage(
    roomId: RoomId,
    content: MessageBody,
    txnId: string,
    threadRoot?: EventId,
    replyTo?: { eventId: EventId; sender: UserId; body: string },
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

      // Reply fallback prefix per Matrix spec v1.4 (rich replies). For
      // text-class messages we prepend a quoted block referencing the
      // parent so clients without rich-reply support still see context.
      // We mutate the body field in-place on the wire payload — the
      // local-echo body stays clean (no `>` prefix) because we only
      // round-trip the original `content` upward; the wire-only prefix
      // is decoded back into a clean body via `stripReplyFallback` in
      // `decodeMessageBody` on receive.
      if (replyTo && typeof wirePayload['body'] === 'string') {
        const quoted = buildReplyFallback(replyTo.sender, replyTo.body);
        wirePayload['body'] = `${quoted}${wirePayload['body'] as string}`;
        if (typeof wirePayload['formatted_body'] === 'string') {
          wirePayload['format'] = 'org.matrix.custom.html';
          wirePayload['formatted_body'] = buildReplyFallbackHtml(
            roomId,
            replyTo.eventId,
            replyTo.sender,
            replyTo.body,
          ) + (wirePayload['formatted_body'] as string);
        }
      }

      if (threadRoot) {
        // Threaded reply. The in-reply-to fallback target is the
        // immediate parent if the user clicked Reply on a thread
        // message; otherwise we fall back to the thread root so
        // unthreaded clients still see a chain.
        wirePayload['m.relates_to'] = {
          rel_type: 'm.thread',
          event_id: threadRoot,
          is_falling_back: !replyTo,
          'm.in_reply_to': { event_id: replyTo?.eventId ?? threadRoot },
        };
      } else if (replyTo) {
        // Plain (non-thread) rich reply.
        wirePayload['m.relates_to'] = {
          'm.in_reply_to': { event_id: replyTo.eventId },
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

  /**
   * Toggle a reaction. A reaction is a one-per-(user,key,target) fact in
   * Matrix — the server rejects a second `m.annotation` with the same key
   * ("Can't send same reaction twice", M_DUPLICATE_ANNOTATION). The UI
   * treats tapping an emoji as a toggle (tap to add, tap again to remove),
   * so the add/remove decision has to live here: if the current user
   * already has a live reaction with this key on the target event, redact
   * it; otherwise send a fresh one.
   *
   * We resolve "my existing reaction" from the relations container rather
   * than trusting the caller, so a stale UI tap can't desync into a
   * duplicate send. Local echoes (txn-id `~...`) are ignored — there's no
   * server event to redact yet, and the original send is still in flight.
   */
  async sendReaction(roomId: RoomId, eventId: EventId, key: string): Promise<void> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    const myId = c.getUserId();

    const existing = room
      ?.getUnfilteredTimelineSet()
      .relations?.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction)
      ?.getRelations()
      ?.find(
        (e) =>
          e.getSender() === myId &&
          e.getRelation()?.key === key &&
          !e.isRedacted() &&
          !e.status, // status set => still a local echo, not yet on the server
      );

    if (existing) {
      const id = existing.getId();
      // Defensive: only redact a real server event id.
      if (id && !id.startsWith('~') && !id.startsWith('$local')) {
        await c.redactEvent(roomId, id);
      }
      return;
    }

    await c.sendEvent(roomId, EventType.Reaction, {
      'm.relates_to': {
        rel_type: RelationType.Annotation,
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

  /**
   * Mark an entire room read from the room list — i.e. without ever
   * opening it. The UI has no event id to anchor on (the timeline was
   * never loaded into a RoomView), so we resolve the room's newest
   * *live* timeline event here and send a read receipt against it.
   *
   * We walk the live timeline tail backwards to skip local-echo / state
   * events that have no server event id yet (a read receipt against an
   * un-acked local echo is rejected by the server). The first event with
   * a real id wins.
   *
   * After the receipt is acked we proactively emit a room delta with
   * unreadCount/highlightCount zeroed so the list badge clears instantly,
   * rather than waiting for the next /sync round-trip to reflect it.
   */
  async markRoomRead(roomId: RoomId): Promise<void> {
    const c = this.requireClient();
    const room = c.getRoom(roomId);
    if (!room) return;
    const live = room.getLiveTimeline().getEvents();
    let target: ReturnType<typeof room.findEventById> | undefined;
    for (let i = live.length - 1; i >= 0; i--) {
      const e = live[i];
      const id = e?.getId();
      // Skip local echoes (txn ids start with '~') and anything without
      // a real server-assigned event id.
      if (id && !id.startsWith('~') && !id.startsWith('$local')) {
        target = e;
        break;
      }
    }
    if (!target) return;
    try {
      await c.sendReadReceipt(target);
    } catch {
      // best-effort; even if the receipt POST fails we still clear the
      // local badge below so the user gets the affordance they asked for.
    }
    // Optimistically clear the badge in the UI. The room-summary mapper
    // reads notification counts off the Room object; zero them so the
    // next emitRoomDelta reflects "read", then emit immediately.
    try {
      room.setUnreadNotificationCount('total' as never, 0);
      room.setUnreadNotificationCount('highlight' as never, 0);
    } catch {
      /* SDK internal — non-fatal if the enum shape shifts */
    }
    this.emitRoomDelta(room);
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

  /**
   * Forward `sourceEventId` from `sourceRoomId` into `targetRoomId`.
   *
   * Implementation notes:
   *
   * 1. We pull the source event via `room.findEventById` so we get
   *    matrix-js-sdk's already-decrypted view (the UI displayed it
   *    a moment ago, so megolm keys are guaranteed in scope). For
   *    edited messages, `getEffectiveEvent().content` returns the
   *    latest-replacement content; for plain messages it's identical
   *    to `getContent()`. Using the effective content means the
   *    forward carries the user's edited body, not the original.
   *
   * 2. We strip:
   *    - `m.relates_to` (the original's reply/thread/edit relation —
   *      meaningless in the target room)
   *    - `m.new_content` (replacement-event side-channel for edits;
   *      we already collapsed to the effective body above)
   *    - `m.mentions` (different audience — never carry mentions
   *      across rooms; the original author wouldn't have @-ed people
   *      who aren't in the target)
   *    - the rich-reply `> <@sender>` text fallback prefix (it's
   *      decoration that points at an event the target room can't
   *      resolve — leaving it produces "In reply to a message that
   *      doesn't exist" garbage)
   *
   * 3. For text-class messages (`m.text` / `m.notice` / `m.emote`)
   *    we prepend a "[Forwarded from @sender]" header so the
   *    recipient knows this isn't the sender's own words. Media
   *    messages don't get a prefix — the `body` field there is an
   *    alt-text caption, not the message body.
   *
   * 4. We call `client.sendEvent` directly rather than threading
   *    through `sendMessage` because:
   *    - The status-trace / pending-bubble pipeline is wired to the
   *      source room; forwarding sends to a DIFFERENT room and the
   *      UI surfaces success via a toast, not an optimistic bubble.
   *    - We need to pass raw IContent (with `file` for encrypted
   *      media) — `encodeMessageBody` re-encodes from MessageBody
   *      and currently only emits `url`, which would silently
   *      strip the AES key from forwarded E2EE media.
   *
   * 5. Encryption works without re-uploading: for E2EE rooms the
   *    AES-CTR key for media lives in `content.file.key` and is
   *    re-encrypted by the TARGET room's megolm session as part
   *    of the outer event. The recipient decrypts megolm → reads
   *    `file.key` → fetches the encrypted blob from the (any)
   *    homeserver → decrypts the bytes locally. No re-upload.
   */
  async forwardEvent(
    sourceRoomId: RoomId,
    sourceEventId: EventId,
    targetRoomId: RoomId,
  ): Promise<EventId> {
    const c = this.requireClient();
    const sourceRoom = c.getRoom(sourceRoomId);
    if (!sourceRoom) {
      throw new Error('Source room not loaded');
    }
    const ev = sourceRoom.findEventById(sourceEventId);
    if (!ev) {
      throw new Error('Source message not found in this room');
    }
    if (ev.getType() !== EventType.RoomMessage) {
      throw new Error('Only chat messages can be forwarded');
    }

    // `getEffectiveEvent` collapses an edited message to its latest
    // replacement content. For a non-edited message it's a no-op.
    const effective = ev.getEffectiveEvent();
    const original = (effective?.content ?? ev.getContent()) as IContent;
    const cleaned: Record<string, unknown> = { ...original };

    delete cleaned['m.relates_to'];
    delete cleaned['m.new_content'];
    delete cleaned['m.mentions'];

    // Strip the `> <@sender> …\n\n` reply-fallback prefix from both
    // plain and formatted bodies. The chip rendering it as a reply
    // belongs to the relation — without the relation the text is
    // just noise referring to an event the target can't resolve.
    if (typeof cleaned['body'] === 'string') {
      cleaned['body'] = stripReplyFallback(cleaned['body'] as string);
    }
    if (typeof cleaned['formatted_body'] === 'string') {
      cleaned['formatted_body'] = (cleaned['formatted_body'] as string).replace(
        /^<mx-reply>[\s\S]*?<\/mx-reply>/,
        '',
      );
    }

    // Prepend "Forwarded from" header for text-class messages only.
    // Media bodies are alt-text captions, not message text, so a
    // prefix there would corrupt accessibility metadata.
    const msgtype = cleaned['msgtype'];
    const senderId = ev.getSender() ?? 'someone';
    if (
      msgtype === MsgType.Text ||
      msgtype === MsgType.Notice ||
      msgtype === MsgType.Emote
    ) {
      const prefix = `[Forwarded from ${senderId}]\n`;
      cleaned['body'] = prefix + (cleaned['body'] as string);
      if (typeof cleaned['formatted_body'] === 'string') {
        cleaned['format'] = 'org.matrix.custom.html';
        cleaned['formatted_body'] =
          `<em>Forwarded from ${escapeHtmlForForward(senderId)}</em><br/>` +
          (cleaned['formatted_body'] as string);
      }
    }

    const result = await c.sendEvent(
      targetRoomId,
      EventType.RoomMessage,
      cleaned as IContent,
    );
    return result.event_id as EventId;
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

  // ---------------------------------------------------------------------------
  // Message search.
  //
  // Two execution paths, picked per room:
  //
  // 1) Server search (Synapse `/_matrix/client/v3/search` via
  //    matrix-js-sdk's `searchRoomEvents`) — used when the room is
  //    NOT end-to-end encrypted. Cheap, deep, paginated by the
  //    server.
  //
  // 2) Local timeline scan — used when the room IS encrypted, OR
  //    when the server returns zero hits (defensive: some Synapse
  //    deployments compile without `matrixfederationapi.search`
  //    enabled and the endpoint still 200s with an empty result).
  //    We walk the room's live timeline + any cached timeline
  //    windows, run a case-insensitive substring match against the
  //    decrypted body, and synthesize `SearchHit`s with the
  //    immediate neighbors as context.
  //
  //    This is honest about its limits: only events the client has
  //    actually decrypted are searchable. Loading more history with
  //    scroll-back grows the searchable window. A proper persistent
  //    FTS index over decrypted events in IndexedDB is the long-term
  //    fix and tracked as a follow-on.
  //
  // First page only for the server path. When the user crosses
  // Synapse's default page size (~10) we'll wire
  // `backPaginateRoomEventsSearch` behind a `next_batch` extension
  // to this RPC.
  // ---------------------------------------------------------------------------
  async searchMessages(
    query: string,
    roomId: RoomId | null,
  ): Promise<{ results: SearchHit[]; count: number; highlights: string[] }> {
    const trimmed = query.trim();
    if (!trimmed) return { results: [], count: 0, highlights: [] };
    const client = this.requireClient();

    // Pick path. Without a roomId we can only run the server search
    // (cross-room scan would need iterating every joined room, which
    // is wasteful and not what the UI asks for today).
    const room = roomId ? client.getRoom(roomId) : null;
    const encrypted = roomId ? client.isRoomEncrypted(roomId) : false;

    if (roomId && encrypted && room) {
      return this.searchLocal(room, trimmed);
    }

    // Try server first.
    try {
      const opts: { term: string; filter?: { rooms: string[] } } = { term: trimmed };
      if (roomId) opts.filter = { rooms: [roomId] };
      const raw = await client.searchRoomEvents(opts);
      const serverHits = (raw.results ?? []).map((r): SearchHit => {
        const ev = r.context.getEvent();
        const timeline = r.context.getTimeline();
        const idx = r.context.getOurEventIndex();
        const prev = idx > 0 ? timeline[idx - 1] : undefined;
        const next = idx >= 0 && idx + 1 < timeline.length ? timeline[idx + 1] : undefined;
        return {
          eventId: ev.getId() as EventId,
          roomId: ev.getRoomId() as RoomId,
          sender: (ev.getSender() ?? '') as UserId,
          originServerTs: ev.getTs(),
          body: extractPreview(ev) ?? '',
          contextBefore: prev ? extractPreview(prev) : null,
          contextAfter: next ? extractPreview(next) : null,
        };
      });

      // Global search: the server cannot index encrypted rooms, and Mata
      // is E2EE by default, so a server-only pass would silently miss most
      // content. Always augment the global path with a local scan across
      // every joined room and merge (dedupe by eventId, newest first).
      if (!roomId) {
        const localHits = this.searchLocalAllRooms(client, trimmed);
        const merged = this.mergeHits(serverHits, localHits);
        const highlights =
          Array.isArray(raw.highlights) && raw.highlights.length ? raw.highlights : [trimmed];
        return { results: merged, count: merged.length, highlights };
      }

      if (serverHits.length > 0) {
        const count = typeof raw.count === 'number' ? raw.count : serverHits.length;
        const highlights = Array.isArray(raw.highlights) ? raw.highlights : [];
        return { results: serverHits, count, highlights };
      }
      // Server returned 0 — fall through to local scan as a safety
      // net. Some Synapse builds answer search requests but never
      // actually index, so this catches that silently.
      if (room) return this.searchLocal(room, trimmed);
      return { results: [], count: 0, highlights: [trimmed] };
    } catch (_err) {
      // Server search failed (404, 403, etc.) — degrade to local.
      if (room) return this.searchLocal(room, trimmed);
      if (!roomId) {
        const localHits = this.searchLocalAllRooms(client, trimmed);
        return { results: localHits, count: localHits.length, highlights: [trimmed] };
      }
      return { results: [], count: 0, highlights: [trimmed] };
    }
  }

  // Cross-room local scan for the global ("All chats") surface. Walks
  // every joined room's decrypted live timeline, substring-matches, and
  // returns a merged list newest-first. This is what makes global search
  // actually return content from encrypted rooms — the server can't.
  private searchLocalAllRooms(
    client: MatrixClient,
    term: string,
  ): SearchHit[] {
    const joined = client
      .getRooms()
      .filter((r) => r.getMyMembership() === 'join');
    const all: SearchHit[] = [];
    for (const room of joined) {
      for (const hit of this.searchLocal(room, term).results) all.push(hit);
    }
    all.sort((a, b) => b.originServerTs - a.originServerTs);
    return all.slice(0, 100);
  }

  // Merge two hit lists, dedupe by eventId, newest-first, capped.
  private mergeHits(a: SearchHit[], b: SearchHit[]): SearchHit[] {
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const hit of [...a, ...b]) {
      if (seen.has(hit.eventId)) continue;
      seen.add(hit.eventId);
      out.push(hit);
    }
    out.sort((x, y) => y.originServerTs - x.originServerTs);
    return out.slice(0, 100);
  }

  // Local timeline scan for encrypted rooms and server-empty cases.
  // Walks the live timeline (most recent N events the client has
  // decrypted), substring-matches case-insensitively against the
  // body, and produces ranked SearchHits — most recent first.
  //
  // We cap at 100 hits to keep the panel responsive; the UI shows
  // a per-room count and the user can refine the query if they're
  // hitting the cap.
  private searchLocal(
    room: import('matrix-js-sdk').Room,
    term: string,
  ): { results: SearchHit[]; count: number; highlights: string[] } {
    const needle = term.toLowerCase();
    const timeline = room.getLiveTimeline().getEvents();
    const hits: SearchHit[] = [];
    // Iterate newest-first so the first N hits are the most recent.
    for (let i = timeline.length - 1; i >= 0 && hits.length < 100; i--) {
      const ev = timeline[i]!;
      if (ev.getType() !== EventType.RoomMessage) continue;
      const body = extractPreview(ev);
      if (!body) continue;
      if (!body.toLowerCase().includes(needle)) continue;
      const prev = i > 0 ? timeline[i - 1] : undefined;
      const next = i + 1 < timeline.length ? timeline[i + 1] : undefined;
      hits.push({
        eventId: ev.getId() as EventId,
        roomId: ev.getRoomId() as RoomId,
        sender: (ev.getSender() ?? '') as UserId,
        originServerTs: ev.getTs(),
        body,
        contextBefore: prev ? extractPreview(prev) : null,
        contextAfter: next ? extractPreview(next) : null,
      });
    }
    return { results: hits, count: hits.length, highlights: [term] };
  }

  /**
   * Fetch URL preview via the homeserver's media preview endpoint.
   * The homeserver server-side-fetches the page so the user's IP/UA
   * never reach the third-party host — that's the privacy story
   * for link previews in Matrix.
   *
   * Two endpoints are tried, in order of "modernness":
   *
   *   1. /_matrix/client/v1/media/preview_url (MSC3916, authenticated
   *      media). Synapse 1.100+ with `enable_authenticated_media: true`
   *      requires this path; the legacy v3 endpoint returns
   *      M_UNRECOGNIZED / 404 on those servers.
   *   2. /_matrix/media/v3/preview_url (legacy). Older homeservers,
   *      including Synapse before 1.100 and most non-Synapse
   *      implementations, only expose this path.
   *
   * On a server-error response (preview disabled, opaque page, etc.)
   * we return null and the UI falls back to plain link text. We do
   * NOT swallow logic errors — if something blows up in our own
   * normalization, that's a bug we want to see in tests.
   *
   * Image normalization: we leave `mxc://` URIs as-is and let the
   * main thread fetch the bytes via the authenticated `loadMedia`
   * RPC (same pipeline as message images). Rewriting to an http URL
   * here doesn't help because a plain `<img>` tag can't attach the
   * bearer token that authenticated media requires.
   */
  async getUrlPreview(url: string): Promise<UrlPreview | null> {
    const client = this.requireClient();
    const ts = Math.floor(Date.now() / 60000) * 60000; // 60s bucket — match SDK behaviour

    const raw = await this.fetchPreviewRaw(client, url, ts);
    const fromHs = raw ? parseHsPreview(raw, url) : null;
    if (fromHs) return fromHs;

    // Fallback 1: our own same-origin Edge proxy (`/api/preview`).
    // Most homeservers (including self-hosted Synapse out of the box)
    // don't enable `url_preview_enabled`, so the HS path above returns
    // nothing. A server-side fetch has no CORS constraint, so this
    // resolves previews for ANY reachable page — unlike the direct
    // browser fetch below, which only works for sites that happen to
    // send permissive CORS. This is the primary preview path in
    // practice.
    const fromProxy = await fetchPreviewViaProxy(url);
    if (fromProxy) return fromProxy;

    // Fallback 2: direct fetch from this side. Kept as a last resort
    // for environments where the proxy isn't reachable (e.g. local
    // `vite dev` with no functions runtime). Works only for permissive-
    // CORS sites; fails silently otherwise = same UX as "no card".
    return await fetchPreviewClientSide(url);
  }

  /**
   * Two-pass fetch: authenticated media first (modern Synapse), legacy
   * v3 fallback (everything else). Either side returning null/error is
   * silenced — there's no UX signal we can give beyond "no card".
   *
   * We bypass the SDK's `client.getUrlPreview()` cache because it
   * uniquely keys on `(ts, url)` per process and the worker already
   * sits behind a per-URL bridge cache.
   */
  private async fetchPreviewRaw(
    client: MatrixClient,
    url: string,
    ts: number,
  ): Promise<Record<string, unknown> | null> {
    const accessToken = client.getAccessToken();
    const base = client.baseUrl;
    if (!accessToken || !base) return null;

    const qs = `url=${encodeURIComponent(url)}&ts=${ts}`;
    const paths = [
      `${base}/_matrix/client/v1/media/preview_url?${qs}`, // MSC3916 authed
      `${base}/_matrix/media/v3/preview_url?${qs}`, // legacy
    ];

    for (const fullUrl of paths) {
      try {
        const res = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const json = await res.json();
          if (json && typeof json === 'object') return json as Record<string, unknown>;
          continue;
        }
        // 404 / M_UNRECOGNIZED on the v1 path is "server doesn't speak
        // MSC3916"; try the next path. Any other status means the
        // server gave us a real answer and we shouldn't double-fetch.
        if (res.status !== 404 && res.status !== 400) return null;
      } catch {
        // Network / parse error — try the next path.
      }
    }
    return null;
  }

  /**
   * Live user-directory search for the "start a chat" flow. Hits
   * `searchUserDirectory` (POST /_matrix/client/v3/user_directory/
   * search) and rewrites any `mxc://` avatar to an authenticated
   * 64×64 thumbnail URL on this side — the main thread doesn't have
   * the client and can't resolve mxc itself.
   *
   * Empty / whitespace-only terms short-circuit to no results so we
   * don't burn a round-trip on every keystroke before the user has
   * typed anything meaningful.
   */
  async searchUsers(
    term: string,
    limit: number,
  ): Promise<{ results: UserSearchHit[]; limited: boolean }> {
    const trimmed = term.trim();
    if (!trimmed) return { results: [], limited: false };
    const client = this.requireClient();
    try {
      const raw = await client.searchUserDirectory({
        term: trimmed,
        limit: Math.max(1, Math.min(limit, 50)),
      });
      const results: UserSearchHit[] = (raw.results ?? []).map((r) => {
        let avatarUrl: string | undefined;
        if (r.avatar_url && r.avatar_url.startsWith('mxc://')) {
          const http = client.mxcUrlToHttp(r.avatar_url, 64, 64, 'crop', false, true, true);
          avatarUrl = http ?? undefined;
        } else if (r.avatar_url) {
          avatarUrl = r.avatar_url;
        }
        return {
          userId: r.user_id as UserId,
          displayName: r.display_name,
          avatarUrl,
        };
      });
      return { results, limited: !!raw.limited };
    } catch {
      // Synapse returns 403 on the endpoint when the homeserver
      // admin has disabled the directory entirely. Treat that as
      // "no matches" instead of an error so the UI can fall back
      // to direct Matrix-ID entry without a noisy toast.
      return { results: [], limited: false };
    }
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

    // Persistent sync store. Without this, matrix-js-sdk defaults to an
    // in-memory MemoryStore: every page refresh throws away the sync
    // token and forces a full initial /sync (the ~10s cold-boot the user
    // reported). IndexedDBStore persists rooms + the sync token to disk,
    // so on refresh the SDK loads cached rooms and reaches `Prepared`
    // near-instantly, then resumes /sync incrementally from the saved
    // token. dbName is scoped per-user so accounts never share state.
    // startup() is awaited so the cached state is loaded before the SDK
    // begins syncing; a failure here is non-fatal — we fall back to the
    // default in-memory behavior rather than blocking boot.
    let syncStore: IndexedDBStore | undefined;
    try {
      const safeUserId = record.userId.replace(/[^a-zA-Z0-9._-]/g, '_');
      syncStore = new IndexedDBStore({
        indexedDB: globalThis.indexedDB,
        dbName: `mata-sync:${safeUserId}`,
        localStorage: undefined,
      });
      const storeStart = Date.now();
      await syncStore.startup();
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: `sync cache loaded (${Date.now() - storeStart}ms)`,
      });
    } catch (storeErr) {
      syncStore = undefined;
      this.emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: `sync cache unavailable, using memory store: ${describe(storeErr)}`,
      });
    }

    const client = createClient({
      baseUrl: record.homeserverBaseUrl,
      accessToken: record.accessToken,
      userId: record.userId,
      deviceId: record.deviceId,
      timelineSupport: true,
      // Persist rooms + sync token across refreshes (see above). Undefined
      // falls back to the SDK's default MemoryStore.
      store: syncStore,
      // `Detached` keeps locally-echoed sends OUT of the live timeline
      // until the server's /sync confirms them. With the default
      // `Chronological`, matrix-js-sdk inserts the local echo into the
      // timeline immediately (with a synthetic `~!room:txn` event id
      // and status='sending'), fires RoomEvent.Timeline for it, and
      // then silently mutates that same MatrixEvent in place when the
      // remote echo lands (no second Timeline fire). That breaks our
      // UI in two ways:
      //
      //   (a) the local echo emits with status != null, which our
      //       worker filter drops — so the message vanishes from the
      //       UI the moment sendStatus 'sent' clears the pending bubble
      //       (the "sending messages doesn't work" symptom);
      //   (b) before the filter existed, the synthetic-id event AND
      //       the (server-confirmed) post-handleRemoteEcho event both
      //       reached the UI under different ids, producing the
      //       "appears twice" flash.
      //
      // With `Detached`, addPendingEvent goes into a separate
      // `pendingEventList` (no Timeline fire), and the sync delivery
      // is the ONLY Timeline fire — with status=null and the real
      // event id. The pending-bubble UI in room-view covers the
      // optimistic display window; sync delivery + our atomic
      // pending-to-events transfer handle the lock-in.
      pendingEventOrdering: PendingEventOrdering.Detached,
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
          this.emitSubscribedRoomTail(); // reconcile open room each sync tick
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
      // NOTE: we intentionally do NOT check `data.liveEvent` here.
      // During reconnects, gap-fills, and the Catchup phase, matrix-js-sdk
      // fires RoomEvent.Timeline with `liveEvent = false` for events that
      // arrived while the client was offline. Those are EXACTLY the "new
      // messages you missed" that users expect to see without refreshing.
      // `toStartOfTimeline = true` is the correct guard for backwards
      // pagination (history loads) — that's the only case we want to skip.

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
      // Drop local echoes for ordinary message events — same reason as
      // the call-events branch above. matrix-js-sdk surfaces every send
      // through Room.timeline twice: first the local echo (event.status
      // = 'sending' / 'sent') with a temporary local-only event id, then
      // the sync-confirmed delivery (status = null) with the real server
      // id. Without this filter the UI receives both copies under
      // different ids, the dedup-by-eventId in room-view can't merge
      // them, and the user sees their own message appear twice on send
      // (until /messages refresh on reload returns only the canonical
      // copy). Inbound events have status === null and pass through
      // unaffected.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgStatus = (event as any).status;
      if (msgStatus != null) return;
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

