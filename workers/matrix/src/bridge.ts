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
    const { events, prevToken } = await core.loadRoomHistory(req.roomId, req.fromToken, req.limit);
    return { kind: 'loadRoomHistory', events, prevToken };
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
      await core.sendMessage(req.roomId, req.content, req.txnId);
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
  uploadMedia: async (req, core) => {
    const mxc = await core.uploadMedia(req.data, req.mime, req.filename);
    return { kind: 'uploadMedia', mxc };
  },
  subscribeRoom: async () => ({ kind: 'subscribeRoom' }),
  unsubscribeRoom: async () => ({ kind: 'unsubscribeRoom' }),
  listDevices: async (_req, core) => {
    const devices = await core.listDevices();
    return { kind: 'listDevices', devices };
  },
  beginDeviceVerification: async () => notImplemented('beginDeviceVerification'),
  completeSasVerification: async () => notImplemented('completeSasVerification'),
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
            emit({
              kind: 'syncStatus',
              status: 'reconnecting',
              reason: `http ${res.status} on ${family}`,
            });
          }
        } else {
          const key = `ok:${method}:${family}`;
          // During startup, ALWAYS emit ok lines (with a request seq
          // counter so dedup across identical calls still gives visible
          // progress). Once sync is live, only emit the first ok per
          // family to avoid log flood.
          const shouldEmit = startupTraceMode || !seenOk.has(key);
          if (shouldEmit) {
            seenOk.add(key);
            const ms = Date.now() - startedAt;
            emit({
              kind: 'syncStatus',
              status: 'connecting',
              reason: `ok ${method} ${family} (${ms}ms)`,
            });
          }
        }
      }
      return res;
    } catch (err) {
      if (isMatrix) {
        const family = endpointFamily(url);
        const msg = err instanceof Error ? err.message : String(err);
        // Network-level failures (CORS, DNS, offline, TLS) hit this
        // branch. TypeError "Failed to fetch" is browser-speak for CORS
        // or DNS in 95% of cases — name it explicitly so users don't
        // have to guess.
        const hint = msg.includes('Failed to fetch')
          ? `${msg} (likely CORS or DNS — the homeserver must allow ${scope.location.origin} as Origin)`
          : msg;
        const key = `neterr:${family}`;
        if (!seenFailures.has(key)) {
          seenFailures.add(key);
          emit({
            kind: 'syncStatus',
            status: 'error',
            reason: `network on ${family}: ${hint}`,
          });
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
