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

  constructor(emit: Emit) {
    this.emit = emit;
  }

  isLoggedIn(): boolean {
    return this.client !== null;
  }

  async login(input: LoginInput): Promise<LoggedIn> {
    const baseUrl = normalizeServerUrl(input.serverUrl);
    const probe = createClient({ baseUrl });
    let response: Awaited<ReturnType<MatrixClient['login']>>;
    try {
      response = await probe.login('m.login.password', {
        user: input.user,
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
    return c.getRooms().map((r) => toSummary(r));
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

  async sendMessage(roomId: RoomId, content: MessageBody, txnId: string): Promise<void> {
    const c = this.requireClient();
    this.emit({ kind: 'sendStatus', txnId, status: 'sending' });
    try {
      // matrix-js-sdk can queue an outgoing event indefinitely if the room
      // is encrypted and the megolm session isn't established (or crypto
      // never finished bootstrapping). Without a hard ceiling the send
      // bubble stayed "pending" forever with no signal to the user. 45s
      // is generous enough for first-message megolm setup but short
      // enough to surface a real hang.
      const sendPromise = c.sendEvent(
        roomId,
        EventType.RoomMessage,
        encodeMessageBody(content),
        txnId,
      );
      const result = await Promise.race([
        sendPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            const isEncrypted = c.isRoomEncrypted(roomId);
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
      this.emit({ kind: 'sendStatus', txnId, status: 'sent', eventId: result.event_id as EventId });
    } catch (err) {
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
        await Promise.race([
          initRustCrypto(client, record.pickleKeyRef, CRYPTO_DB_NAME),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `crypto init exceeded 30s — likely hanging on device-key upload to ${record.homeserverBaseUrl}`,
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
    // Heartbeat poll on the SDK's internal sync state. ClientEvent.Sync
    // only fires on transitions — if the SDK gets stuck in an
    // intermediate state (e.g. waiting on /sync, processing a slow
    // initial batch, gated on crypto), the pill stays at "starting sync"
    // with no signal about what's actually happening. This loop surfaces
    // the live SDK state into the banner so we can see exactly where it
    // is — Prepared / Syncing turn the pill green; anything else is
    // reported verbatim alongside the last /sync error if any.
    const heartbeat = setInterval(() => {
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
        reason: `sdk sync state: ${state ?? 'null'}${dataErr}`,
      });
    }, 4_000);
    // Stop the heartbeat once the SDK reaches a live state — there's no
    // need to keep flooding the pill with redundant status updates.
    const onSyncLive = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        clearInterval(heartbeat);
        client.off(ClientEvent.Sync, onSyncLive);
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
      const tev = toTimelineEvent(event);
      if (!tev) return;
      this.emit({
        kind: 'syncUpdate',
        deltas: [
          {
            roomId: room.roomId as RoomId,
            summary: partialSummary(room),
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
      summary: toSummary(r),
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
          summary: partialSummary(room),
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

function mapLoginError(err: unknown): Error {
  const msg = describe(err);
  if (/M_FORBIDDEN|invalid.*username|invalid.*password|incorrect/i.test(msg)) {
    return authError('Invalid username or password');
  }
  if (/M_LIMIT_EXCEEDED|rate.?limit/i.test(msg)) {
    return authError('Too many attempts — wait a moment and try again');
  }
  if (/M_USER_DEACTIVATED/i.test(msg)) {
    return authError('This account has been deactivated');
  }
  return authError(`Sign-in failed: ${msg}`);
}

function classifyRoom(room: Room): 'dm' | 'room' | 'space' {
  if (room.isSpaceRoom?.()) return 'space';
  if (room.getDMInviter() || (room.getJoinedMemberCount?.() === 2 && !room.isSpaceRoom?.())) return 'dm';
  return 'room';
}

function toSummary(room: Room): RoomSummary {
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
    membership: (room.getMyMembership() as 'join' | 'invite' | 'leave') ?? 'leave',
  };
}

function partialSummary(room: Room): Partial<RoomSummary> {
  return toSummary(room);
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
      inReplyTo: (c['m.relates_to']?.['m.in_reply_to']?.event_id as EventId | undefined) ?? null,
      threadRoot: (c['m.relates_to']?.event_id as EventId | undefined) ?? null,
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
  switch (body.msgtype) {
    case 'm.text':
      return body.formattedBody
        ? {
            msgtype: MsgType.Text,
            body: body.body,
            format: 'org.matrix.custom.html',
            formatted_body: body.formattedBody,
          }
        : { msgtype: MsgType.Text, body: body.body };
    case 'm.emote':
      return { msgtype: MsgType.Emote, body: body.body };
    case 'm.notice':
      return { msgtype: MsgType.Notice, body: body.body };
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
  switch (msgtype) {
    case MsgType.Text:
      return {
        msgtype: 'm.text',
        body,
        formattedBody:
          c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string'
            ? c.formatted_body
            : null,
      };
    case MsgType.Emote:
      return { msgtype: 'm.emote', body };
    case MsgType.Notice:
      return { msgtype: 'm.notice', body };
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
