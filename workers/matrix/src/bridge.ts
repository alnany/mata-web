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
    await core.sendMessage(req.roomId, req.content, req.txnId);
    return { kind: 'sendMessage', queued: true };
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
  listDevices: async () => ({ kind: 'listDevices', devices: [] }),
  beginDeviceVerification: async () => notImplemented('beginDeviceVerification'),
  completeSasVerification: async () => notImplemented('completeSasVerification'),
  enableKeyBackup: async () => notImplemented('enableKeyBackup'),
  restoreKeyBackup: async () => notImplemented('restoreKeyBackup'),
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
  const seenFailures = new Set<string>();
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
    try {
      const res = await origFetch(input, init);
      if (isMatrix && !res.ok) {
        const endpoint = url.replace(/^.*\/_matrix\//, '/_matrix/').split('?')[0];
        const key = `${res.status}:${endpoint}`;
        if (!seenFailures.has(key)) {
          seenFailures.add(key);
          emit({
            kind: 'syncStatus',
            status: 'reconnecting',
            reason: `http ${res.status} on ${endpoint}`,
          });
        }
      }
      return res;
    } catch (err) {
      if (isMatrix) {
        const endpoint = url.replace(/^.*\/_matrix\//, '/_matrix/').split('?')[0];
        const msg = err instanceof Error ? err.message : String(err);
        // Network-level failures (CORS, DNS, offline, TLS) hit this
        // branch. TypeError "Failed to fetch" is browser-speak for CORS
        // or DNS in 95% of cases — name it explicitly so users don't
        // have to guess.
        const hint = msg.includes('Failed to fetch')
          ? `${msg} (likely CORS or DNS — the homeserver must allow ${scope.location.origin} as Origin)`
          : msg;
        const key = `neterr:${endpoint}`;
        if (!seenFailures.has(key)) {
          seenFailures.add(key);
          emit({
            kind: 'syncStatus',
            status: 'error',
            reason: `network on ${endpoint}: ${hint}`,
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
