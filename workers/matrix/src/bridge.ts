/**
 * Worker-side of the typed RPC bridge.
 *
 * Receives `RequestEnvelope`, dispatches by `payload.kind` against a
 * `MatrixCore` instance (the only owner of the SDK), responds with a
 * matching `ResponseEnvelope`. Pushes `WorkerEvent`s as `EventEnvelope`.
 *
 * See ADR-001 for the boundary contract this enforces.
 */

import type {
  EventEnvelope,
  MainToWorkerRequest,
  MainToWorkerResponse,
  RequestEnvelope,
  ResponseEnvelope,
  WorkerEvent,
} from '@mata/shared/rpc';
import { type SerializedError, MataError } from '@mata/shared/errors';
import { MatrixCore } from './sdk.js';
import { searchUsers as runUserSearch } from './user-search.js';

type Handlers = {
  [K in MainToWorkerRequest['kind']]: (
    req: Extract<MainToWorkerRequest, { kind: K }>,
    core: MatrixCore,
  ) => Promise<Extract<MainToWorkerResponse, { kind: K }>>;
};

function notImplemented(kind: string): never {
  throw new MataError({
    category: 'protocol',
    message: `RPC "${kind}" not implemented yet`,
    retryable: false,
  });
}

const handlers: Handlers = {
  ping: async () => ({ kind: 'ping', pong: true }),

  diagLog: async (req, core) => {
    core.diagLog(req.note);
    return { kind: 'diagLog', ok: true };
  },

  login: async (req, core) => {
    const { userId, deviceId } = await core.login({
      serverUrl: req.serverUrl,
      user: req.user,
      password: req.password,
      deviceDisplayName: req.deviceDisplayName,
    });
    return { kind: 'login', userId, deviceId };
  },

  restoreSession: async (_req, core) => {
    const result = await core.tryRestore();
    if (!result) {
      return { kind: 'restoreSession', restored: false, userId: null, deviceId: null };
    }
    return { kind: 'restoreSession', restored: true, userId: result.userId, deviceId: result.deviceId };
  },

  logout: async (_req, core) => {
    await core.logout();
    return { kind: 'logout' };
  },

  loadRoomList: async (_req, core) => {
    const rooms = await core.listRoomSummaries();
    return { kind: 'loadRoomList', rooms };
  },

  // Phase 2 handlers — fully wired to MatrixCore.
  loadRoomHistory: async (req, core) => {
    const { events, prevToken, readUpToEventId } = await core.loadRoomHistory(req.roomId, req.fromToken, req.limit);
    return { kind: 'loadRoomHistory', events, prevToken, readUpToEventId };
  },
  sendMessage: async (req, core) => {
    // INSTRUMENTATION (send-pipeline trace).
    // The user reports "no bubble, non-responsive" when sending: no
    // `/send` PUT, no error toast, no optimistic bubble. We can't see
    // browser console output, so each phase emits to the visible sync
    // log. Three phase markers from the bridge layer:
    //   - "send-RPC: handler entered" — RPC reached the worker
    //   - "send-RPC: core returned ok" — core.sendMessage resolved
    //   - "send-RPC: core threw <err>" — core.sendMessage rejected
    // The deepest markers ("send-CORE: ...") live in sdk-impl.ts and
    // narrow it down further once we see which CORE phase is last.
    core.diagLog(`send-RPC: handler entered txn=${req.txnId.slice(-6)} room=${req.roomId.slice(0, 24)}`);
    try {
      await core.sendMessage(req.roomId, req.content, req.txnId, req.threadRoot, req.replyTo);
      core.diagLog(`send-RPC: core returned ok txn=${req.txnId.slice(-6)}`);
      return { kind: 'sendMessage', queued: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.diagLog(`send-RPC: core threw txn=${req.txnId.slice(-6)} err=${msg.slice(0, 160)}`);
      throw err;
    }
  },
  editMessage: async (req, core) => {
    await core.editMessage(req.roomId, req.eventId, req.content, req.txnId);
    return { kind: 'editMessage', queued: true };
  },
  redactMessage: async (req, core) => {
    await core.redactMessage(req.roomId, req.eventId, req.reason);
    return { kind: 'redactMessage' };
  },
  pinEvent: async (req, core) => {
    await core.pinEvent(req.roomId, req.eventId);
    return { kind: 'pinEvent' };
  },
  unpinEvent: async (req, core) => {
    await core.unpinEvent(req.roomId, req.eventId);
    return { kind: 'unpinEvent' };
  },
  fetchPresence: async (req, core) => {
    const p = await core.fetchPresence(req.userId);
    return {
      kind: 'fetchPresence',
      presence: p?.presence ?? 'offline',
      lastActiveAgoMs: p?.lastActiveAgoMs ?? null,
      currentlyActive: p?.currentlyActive ?? null,
    };
  },
  fetchProfile: async (req, core) => {
    const p = await core.fetchProfile(req.userId);
    return { kind: 'fetchProfile', displayName: p.displayName, avatarUrl: p.avatarUrl, ignored: p.ignored };
  },
  setIgnored: async (req, core) => {
    await core.setIgnored(req.userId, req.ignored);
    return { kind: 'setIgnored' };
  },
  fetchRoomSettings: async (req, core) => {
    const s = await core.fetchRoomSettings(req.roomId);
    return {
      kind: 'fetchRoomSettings',
      name: s.name,
      topic: s.topic,
      canSetName: s.canSetName,
      canSetTopic: s.canSetTopic,
      canSetAvatar: s.canSetAvatar,
    };
  },
  setRoomName: async (req, core) => {
    await core.setRoomName(req.roomId, req.name);
    return { kind: 'setRoomName' };
  },
  setRoomTopic: async (req, core) => {
    await core.setRoomTopic(req.roomId, req.topic);
    return { kind: 'setRoomTopic' };
  },
  setRoomAvatar: async (req, core) => {
    await core.setRoomAvatar(req.roomId, req.mxc);
    return { kind: 'setRoomAvatar' };
  },
  setMemberPowerLevel: async (req, core) => {
    await core.setMemberPowerLevel(req.roomId, req.userId, req.powerLevel);
    return { kind: 'setMemberPowerLevel' };
  },
  fetchReadReceipts: async (req, core) => {
    const receipts = await core.fetchReadReceipts(req.roomId);
    return { kind: 'fetchReadReceipts', receipts };
  },
  fetchEditHistory: async (req, core) => {
    const versions = await core.fetchEditHistory(req.roomId, req.eventId);
    return { kind: 'fetchEditHistory', versions };
  },
  jumpToTimestamp: async (req, core) => {
    const eventId = await core.jumpToTimestamp(req.roomId, req.ts);
    return { kind: 'jumpToTimestamp', eventId };
  },
  forgetRoom: async (req, core) => {
    await core.forgetRoom(req.roomId);
    return { kind: 'forgetRoom' };
  },
  fetchEvent: async (req, core) => {
    const event = await core.fetchEvent(req.roomId, req.eventId);
    return { kind: 'fetchEvent', event };
  },
  setWebPusher: async (req, core) => {
    await core.setWebPusher(req.subscription, req.gatewayUrl, req.appId, req.lang);
    return { kind: 'setWebPusher' };
  },
  removeWebPusher: async (req, core) => {
    await core.removeWebPusher(req.endpoint, req.appId);
    return { kind: 'removeWebPusher' };
  },
  sendReaction: async (req, core) => {
    await core.sendReaction(req.roomId, req.eventId, req.key);
    return { kind: 'sendReaction' };
  },
  sendTyping: async (req, core) => {
    await core.sendTyping(req.roomId, req.timeoutMs);
    return { kind: 'sendTyping' };
  },
  sendReadReceipt: async (req, core) => {
    await core.sendReadReceipt(req.roomId, req.eventId);
    return { kind: 'sendReadReceipt' };
  },
  markRoomRead: async (req, core) => {
    await core.markRoomRead(req.roomId);
    return { kind: 'markRoomRead' };
  },
  sendFileMessage: async (req, core) => {
    const { eventId } = await core.sendFileMessage({
      roomId: req.roomId,
      data: req.data,
      filename: req.filename,
      info: req.info,
      txnId: req.txnId,
      extraContent: req.extraContent,
    });
    return { kind: 'sendFileMessage', eventId };
  },
  loadMedia: async (req, core) => {
    const { data, mime } = await core.loadMedia({
      mxc: req.mxc,
      encryptedFile: req.encryptedFile,
      mime: req.mime,
    });
    return { kind: 'loadMedia', data, mime };
  },
  createRoom: async (req, core) => {
    const roomId = await core.createRoom({
      name: req.name,
      topic: req.topic,
      isDirect: req.isDirect,
      encrypted: req.encrypted,
      invite: req.invite,
    });
    return { kind: 'createRoom', roomId };
  },
  inviteToRoom: async (req, core) => {
    await core.inviteToRoom(req.roomId, req.userId);
    return { kind: 'inviteToRoom' };
  },
  forwardEvent: async (req, core) => {
    const eventId = await core.forwardEvent(
      req.sourceRoomId,
      req.sourceEventId,
      req.targetRoomId,
    );
    return { kind: 'forwardEvent', eventId };
  },
  joinRoom: async (req, core) => {
    const roomId = await core.joinRoom(req.roomId);
    return { kind: 'joinRoom', roomId };
  },
  leaveRoom: async (req, core) => {
    await core.leaveRoom(req.roomId);
    return { kind: 'leaveRoom' };
  },
  loadRoomMembers: async (req, core) => {
    const members = await core.loadRoomMembers(req.roomId);
    return { kind: 'loadRoomMembers', members };
  },
  kickFromRoom: async (req, core) => {
    await core.kickFromRoom(req.roomId, req.userId, req.reason);
    return { kind: 'kickFromRoom' };
  },
  banFromRoom: async (req, core) => {
    await core.banFromRoom(req.roomId, req.userId, req.reason);
    return { kind: 'banFromRoom' };
  },
  unbanFromRoom: async (req, core) => {
    await core.unbanFromRoom(req.roomId, req.userId);
    return { kind: 'unbanFromRoom' };
  },
  fetchBannedMembers: async (req, core) => {
    const banned = await core.fetchBannedMembers(req.roomId);
    return { kind: 'fetchBannedMembers', banned };
  },
  setRoomMuted: async (req, core) => {
    // Returns the resulting boolean so the UI doesn't have to wait
    // for the next sync delta to flip RoomSummary.isMuted in place.
    const muted = await core.setRoomMuted(req.roomId, req.muted);
    return { kind: 'setRoomMuted', muted };
  },
  loadThread: async (req, core) => {
    const events = await core.loadThread(req.roomId, req.threadRootId);
    return { kind: 'loadThread', events };
  },
  sendCallEvent: async (req, core) => {
    const eventId = await core.sendCallEvent(req.roomId, req.eventType, req.content);
    return { kind: 'sendCallEvent', eventId };
  },
  getTurnServers: async (_req, core) => {
    const iceServers = await core.getTurnServers();
    return { kind: 'getTurnServers', iceServers };
  },
  searchMessages: async (req, core) => {
    const { results, count, highlights } = await core.searchMessages(req.query, req.roomId);
    return { kind: 'searchMessages', results, count, highlights };
  },
  getUrlPreview: async (req, core) => {
    const preview = await core.getUrlPreview(req.url);
    return { kind: 'getUrlPreview', preview };
  },
  searchUsers: async (req, core) => {
    // Routed through `user-search.ts` (sibling utility) instead of
    // through MatrixCore directly so we can iterate on this surface
    // without re-uploading the large sdk-impl module. See
    // `MatrixCore.getMatrixClient` for the typed-leak seam.
    const client = core.getMatrixClient() as Parameters<typeof runUserSearch>[0];
    const { results, limited } = await runUserSearch(client, req.term, req.limit);
    return { kind: 'searchUsers', results, limited };
  },
  uploadMedia: async (req, core) => {
    const mxc = await core.uploadMedia(req.data, req.mime, req.filename);
    return { kind: 'uploadMedia', mxc };
  },
  subscribeRoom: async (req, core) => {
    core.subscribeRoom(req.roomId);
    return { kind: 'subscribeRoom' };
  },
  unsubscribeRoom: async (_req, core) => {
    core.unsubscribeRoom();
    return { kind: 'unsubscribeRoom' };
  },
  listDevices: async (_req, core) => {
    const devices = await core.listDevices();
    return { kind: 'listDevices', devices };
  },
  fetchUserDevices: async (req, core) => {
    const devices = await core.fetchUserDevices(req.userId);
    return { kind: 'fetchUserDevices', devices };
  },
  beginDeviceVerification: async (req, core) => {
    const { transactionId } = await core.beginDeviceVerification(req.userId, req.deviceId);
    return { kind: 'beginDeviceVerification', transactionId };
  },
  completeSasVerification: async (req, core) => {
    await core.completeSasVerification(req.transactionId, req.result);
    return { kind: 'completeSasVerification' };
  },
  cancelVerification: async (req, core) => {
    await core.cancelVerification(req.transactionId);
    return { kind: 'cancelVerification' };
  },
  getEncryptionStatus: async (_req, core) => {
    const status = await core.getEncryptionStatus();
    return { kind: 'getEncryptionStatus', status };
  },
  enableKeyBackup: async (req, core) => {
    const { recoveryKey } = await core.enableKeyBackup(req.password, req.passphrase);
    return { kind: 'enableKeyBackup', recoveryKey };
  },
  restoreKeyBackup: async (req, core) => {
    const { keysImported } = await core.restoreKeyBackup(req.recoveryKey);
    return { kind: 'restoreKeyBackup', keysImported };
  },
};

function serializeError(err: unknown): SerializedError {
  if (err instanceof MataError) return err.toJSON();
  if (err instanceof Error) {
    return { category: 'unknown', message: err.message, retryable: false };
  }
  return { category: 'unknown', message: String(err), retryable: false };
}

export interface BridgeContext {
  emit: (event: WorkerEvent) => void;
}

export function installBridge(scope: DedicatedWorkerGlobalScope): BridgeContext {
  const emit = (event: WorkerEvent): void => {
    const envelope: EventEnvelope = { type: 'event', payload: event };
    scope.postMessage(envelope);
  };

  // Intercept fetch INSIDE the worker so /sync, /keys/upload, /keys/query
  // failures show up in the UI banner instead of being swallowed by
  // matrix-js-sdk's internal retry loop. matrix-js-sdk silently retries
  // most network errors and never re-emits Sync.Error for transient
  // failures (CORS, DNS, 429, 5xx) — so the pill sits at "connecting"
  // forever while every /sync is failing in the background. We don't
  // change behavior, just announce the first non-200 we see per endpoint.
  //
  // The interceptor ALSO traces success paths: it emits "first contact"
  // when the very first /_matrix/ request fires, and "ok" for each
  // distinct endpoint family on first 2xx. This exists because Firefox
  // does not surface Web Worker fetches in the main-thread Network panel
  // by default — without these traces, the user can't tell whether the
  // SDK is hanging before HTTP (no traces appear) or during/after HTTP
  // (traces appear but sync never reaches PREPARED).
  const seenFailures = new Set<string>();
  const seenOk = new Set<string>();
  // Homeserver reachability probe state. When a network failure hits
  // /sync (a 30s long-poll, very prone to mid-flight interruption from
  // tab suspension / WiFi roam / VPN handoff), we don't want to scream
  // "CORS!" at the user when the SDK will just retry the long-poll and
  // succeed. Instead we kick a cheap GET /_matrix/client/versions probe
  // against the same homeserver to verify it's actually reachable from
  // this origin. The result is cached briefly so a burst of failures
  // shares one probe.
  let homeserverReachableProbe: Promise<boolean> | null = null;
  let lastProbeAt = 0;
  const probeHomeserverReachable = (sampleUrl: string): Promise<boolean> => {
    const now = Date.now();
    if (homeserverReachableProbe && now - lastProbeAt < 5000) {
      return homeserverReachableProbe;
    }
    lastProbeAt = now;
    const baseMatch = sampleUrl.match(/^(https?:\/\/[^/]+)/);
    if (!baseMatch) return Promise.resolve(false);
    const versionsUrl = `${baseMatch[1]}/_matrix/client/versions`;
    homeserverReachableProbe = origFetch(versionsUrl, { method: 'GET' })
      .then((r) => r.ok)
      .catch(() => false);
    return homeserverReachableProbe;
  };
  // During startup we want EVERY matrix endpoint logged once, not
  // collapsed by family. Once the sync reaches PREPARED we go back to
  // family-dedup so steady-state /sync long-polls don't flood the log.
  // Setting this from outside the closure: bridge.ts wires it via
  // toggleStartupTrace() which bridges' SyncBanner subscriber flips on
  // first Prepared/Syncing event.
  let startupTraceMode = true;
  // Track whether sync has ever transitioned to a live state. While
  // false, the fetch tracer also logs every distinct (method, family)
  // tuple as a separate ok line so we can spot the SDK silently going
  // quiet between two HTTP calls.
  (scope as unknown as { __mata_disableStartupTrace?: () => void }).__mata_disableStartupTrace =
    () => {
      startupTraceMode = false;
    };
  let firstMatrixContactAt: number | null = null;
  const endpointFamily = (url: string): string =>
    url
      .replace(/^.*\/_matrix\//, '/_matrix/')
      .split('?')[0]
      // Collapse opaque ids (txn ids, event ids, room ids, user ids,
      // sync tokens) so the banner shows the endpoint shape, not 500
      // lines of "PUT /rooms/!aaa:x/send/m.room.message/m1234567"
      .replace(/\/(?:\$|!|@)[^/]+/g, '/{id}')
      .replace(/\/m\d{10,}/g, '/{txn}');
  const origFetch = scope.fetch.bind(scope);
  scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
    // Only instrument matrix-client endpoints, not every fetch in the
    // worker (wasm streaming, etc.).
    const isMatrix = url.includes('/_matrix/');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (isMatrix && firstMatrixContactAt === null) {
      firstMatrixContactAt = Date.now();
      emit({
        kind: 'syncStatus',
        status: 'connecting',
        reason: `first /_matrix/ request: ${method} ${endpointFamily(url)}`,
      });
    }
    const startedAt = isMatrix ? Date.now() : 0;
    try {
      const res = await origFetch(input, init);
      if (isMatrix) {
        const family = endpointFamily(url);
        if (!res.ok) {
          const key = `${res.status}:${family}`;
          if (!seenFailures.has(key)) {
            seenFailures.add(key);
            // Same rule as the success branch: during startup the pill
            // is our progress indicator, after startup the pill follows
            // SDK SyncState only. A single 400 on /receipt (matrix-js-sdk
            // emits a malformed receipt id intermittently — known SDK
            // quirk, not a real connectivity loss) shouldn't drag the
            // pill to "reconnecting" while sync is fine. Real connectivity
            // problems hit the catch branch below AND the SDK's own
            // SyncState.Reconnecting / Error event.
            if (startupTraceMode) {
              emit({
                kind: 'syncStatus',
                status: 'reconnecting',
                reason: `http ${res.status} on ${family}`,
              });
            } else {
              emit({
                kind: 'diagNote',
                note: `http ${res.status} on ${family}`,
              });
            }
          }
        } else {
          const key = `ok:${method}:${family}`;
          // During startup we touch the pill on every endpoint so the
          // user can SEE the SDK making progress (the 4-second sync
          // null window used to be a silent black box). After PREPARED
          // the pill must follow ONLY the SDK's own SyncState — otherwise
          // every routine PUT /typing or POST /receipt flickers the pill
          // back to "connecting" forever, even though sync is healthy.
          // Post-startup, route successful traces to `diagNote` which
          // lands in the log panel but does not change pill state.
          if (startupTraceMode) {
            if (!seenOk.has(key)) {
              seenOk.add(key);
              const ms = Date.now() - startedAt;
              emit({
                kind: 'syncStatus',
                status: 'connecting',
                reason: `ok ${method} ${family} (${ms}ms)`,
              });
            }
          } else if (!seenOk.has(key)) {
            // First-time-this-session endpoint after startup — log it
            // once for forensic value, but as a diag note so the pill
            // stays put.
            seenOk.add(key);
            const ms = Date.now() - startedAt;
            emit({
              kind: 'diagNote',
              note: `ok ${method} ${family} (${ms}ms)`,
            });
          }
        }
      }
      return res;
    } catch (err) {
      if (isMatrix) {
        const family = endpointFamily(url);
        const msg = err instanceof Error ? err.message : String(err);
        const isFailedToFetch = msg.includes('Failed to fetch');
        // /sync is a 30s long-poll. The browser interrupts long-polls
        // on tab suspension, network flips, or VPN handoff — the SDK
        // just retries and recovers without user-visible disruption.
        // Surfacing a hard error toast on every such interruption is
        // pure noise.
        const isSyncLongPoll = family.startsWith('/_matrix/client/v3/sync');

        if (isFailedToFetch) {
          // Kick a reachability probe before accusing CORS. If the
          // homeserver answers /versions from this same origin, CORS
          // and DNS are fine and the failure was transient.
          probeHomeserverReachable(url).then((reachable) => {
            const key = reachable
              ? `transient:${family}`
              : `unreach:${family}`;
            if (seenFailures.has(key)) return;
            seenFailures.add(key);
            if (reachable) {
              // Server is up and CORS-permits this origin. The failure
              // was a transient browser/network interruption. For /sync
              // long-polls we say nothing visible (SDK retries silently);
              // for other endpoints we drop a diag note for forensics.
              if (!isSyncLongPoll) {
                emit({
                  kind: 'diagNote',
                  note: `transient network blip on ${family} (homeserver still reachable)`,
                });
              }
            } else {
              emit({
                kind: 'syncStatus',
                status: 'error',
                reason: `Homeserver unreachable from ${scope.location.origin} (DNS / TLS / CORS preflight on /_matrix/client/versions failed). Check that the homeserver URL is correct, the server is up, and your network allows it.`,
              });
            }
          });
        } else {
          // Non-"Failed to fetch" errors (AbortError, timeout, TLS errors
          // with named messages) — surface the message itself, once per
          // family.
          const key = `neterr:${family}`;
          if (!seenFailures.has(key)) {
            seenFailures.add(key);
            emit({
              kind: 'syncStatus',
              status: isSyncLongPoll ? 'reconnecting' : 'error',
              reason: `network on ${family}: ${msg}`,
            });
          }
        }
      }
      throw err;
    }
  };

  const core = new MatrixCore(emit);

  // Catch anything that escapes a handler's try/catch (silent worker hangs
  // were impossible to diagnose otherwise — the pill stayed at 'connecting'
  // forever while the actual cause sat in the worker console).
  scope.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason =
      ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
    emit({
      kind: 'syncStatus',
      status: 'error',
      reason: `Worker unhandled rejection: ${reason}`,
    });
  });
  scope.addEventListener('error', (ev: ErrorEvent) => {
    emit({
      kind: 'syncStatus',
      status: 'error',
      reason: `Worker error: ${ev.message}`,
    });
  });

  scope.addEventListener('message', async (ev: MessageEvent<RequestEnvelope>) => {
    const env = ev.data;
    if (!env || env.type !== 'request') return;
    const { id, payload } = env;
    try {
      const handler = handlers[payload.kind] as (
        req: MainToWorkerRequest,
        core: MatrixCore,
      ) => Promise<MainToWorkerResponse>;
      const response = await handler(payload, core);
      const out: ResponseEnvelope = { type: 'response', id, ok: true, payload: response };
      scope.postMessage(out);
    } catch (err) {
      const out: ResponseEnvelope = {
        type: 'response',
        id,
        ok: false,
        error: serializeError(err),
      };
      scope.postMessage(out);
    }
  });

  // Signal life. The main thread waits for ping → pong, so this `syncStatus`
  // is informational (e.g., devtools, future bridge dashboards).
  emit({ kind: 'syncStatus', status: 'idle' });

  return { emit };
}
