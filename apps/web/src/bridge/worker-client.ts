/**
 * Main-thread side of the typed RPC bridge.
 *
 * Owns the Worker, correlates request ids with their responses, fans out
 * pushed events to registered listeners, and surfaces typed errors via
 * MataError.
 *
 * This file is the ONLY place in `apps/web` that imports the worker. UI
 * code consumes the bridge through `useBridge()`.
 */

import type {
  EventEnvelope,
  MainToWorkerRequest,
  MatrixBridge,
  RequestEnvelope,
  ResponseEnvelope,
  ResponseFor,
  WorkerEvent,
} from '@mata/shared/rpc';
import { MataError } from '@mata/shared/errors';

// Vite turns this into a real Worker URL via `?worker` query. The bundler
// handles transpiling the worker entry + dependency graph.
import MatrixWorker from '@mata/worker-matrix?worker';

/**
 * Module-level diagnostic counters. The UI can render these directly to
 * surface what flows through the bridge without needing browser DevTools.
 *
 * Phase 5 sync hang was originally invisible because every observable
 * surface depended on a handler being attached BEFORE the worker emitted.
 * These counters tick on every envelope the message handler sees,
 * regardless of any handler being registered, so we can prove whether the
 * worker → main message channel is alive.
 */
export interface BridgeDiag {
  envelopes: number;
  responses: number;
  events: number;
  errors: number;
  byKind: Record<string, number>;
  lastEvent: { kind: string; at: number; preview: string } | null;
  latchKinds: string[];
}

export const bridgeDiag: BridgeDiag = {
  envelopes: 0,
  responses: 0,
  events: 0,
  errors: 0,
  byKind: {},
  lastEvent: null,
  latchKinds: [],
};

type EventHandler<K extends WorkerEvent['kind']> = (
  event: Extract<WorkerEvent, { kind: K }>,
) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: MataError) => void;
}

export function createMatrixBridge(): MatrixBridge {
  const worker = new MatrixWorker();
  const pending = new Map<string, Pending>();
  const listeners = new Map<WorkerEvent['kind'], Set<EventHandler<WorkerEvent['kind']>>>();

  /**
   * Latched last-known value for kinds where late subscribers must see the
   * most recent state (e.g. `syncStatus`). The worker emits `syncStatus`
   * during boot, often before the consuming component mounts. Without
   * replay, the UI would sit on a stale default ("connecting") forever.
   */
  const latched = new Map<WorkerEvent['kind'], WorkerEvent>();
  const LATCH_KINDS = new Set<WorkerEvent['kind']>(['syncStatus']);

  let counter = 0;
  const nextId = (): string => `rpc-${++counter}`;

  worker.addEventListener('message', (ev: MessageEvent<ResponseEnvelope | EventEnvelope>) => {
    const env = ev.data;
    bridgeDiag.envelopes += 1;
    if (!env) return;

    if (env.type === 'response') {
      bridgeDiag.responses += 1;
    } else if (env.type === 'event') {
      bridgeDiag.events += 1;
      const k = env.payload.kind;
      bridgeDiag.byKind[k] = (bridgeDiag.byKind[k] ?? 0) + 1;
      try {
        bridgeDiag.lastEvent = {
          kind: k,
          at: Date.now(),
          preview: JSON.stringify(env.payload).slice(0, 200),
        };
      } catch {
        bridgeDiag.lastEvent = { kind: k, at: Date.now(), preview: '<unserialisable>' };
      }
    }

    if (env.type === 'response') {
      const slot = pending.get(env.id);
      if (!slot) {
        // Late response after dispose, or programmer error in the worker.
        // Don't throw on the message bus — just drop it.
        return;
      }
      pending.delete(env.id);
      if (env.ok) {
        slot.resolve(env.payload);
      } else {
        slot.reject(MataError.from(env.error));
      }
      return;
    }

    if (env.type === 'event') {
      if (LATCH_KINDS.has(env.payload.kind)) {
        latched.set(env.payload.kind, env.payload);
        bridgeDiag.latchKinds = Array.from(latched.keys()).map(String);
      }
      const set = listeners.get(env.payload.kind);
      if (!set) return;
      for (const handler of set) {
        try {
          // Handler signature is keyed on the event kind; the cast is safe
          // because we partition listeners by kind in `on()`.
          (handler as (event: WorkerEvent) => void)(env.payload);
        } catch (err) {
          // A failing UI handler must not poison the worker stream.
          // We deliberately don't rethrow here.
          // eslint-disable-next-line no-console
          console.error('[bridge] event handler threw', err);
        }
      }
    }
  });

  worker.addEventListener('error', (ev) => {
    const err = new MataError({
      category: 'protocol',
      message: ev.message || 'Worker error',
      retryable: false,
    });
    // Reject every in-flight request so callers don't hang.
    for (const [id, slot] of pending) {
      slot.reject(err);
      pending.delete(id);
    }
  });

  function request<K extends MainToWorkerRequest['kind']>(
    payload: Extract<MainToWorkerRequest, { kind: K }>,
  ): Promise<ResponseFor<K>> {
    return new Promise<ResponseFor<K>>((resolve, reject) => {
      const id = nextId();
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const envelope: RequestEnvelope = { type: 'request', id, payload };
      worker.postMessage(envelope);
    });
  }

  function on<K extends WorkerEvent['kind']>(kind: K, handler: EventHandler<K>): () => void {
    let set = listeners.get(kind);
    if (!set) {
      set = new Set();
      listeners.set(kind, set);
    }
    set.add(handler as unknown as EventHandler<WorkerEvent['kind']>);
    // Replay last-known value for latched kinds — late subscribers see the
    // current state immediately instead of waiting for the next transition.
    if (LATCH_KINDS.has(kind)) {
      const last = latched.get(kind);
      if (last) {
        try {
          (handler as (event: WorkerEvent) => void)(last);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[bridge] replay handler threw', err);
        }
      }
    }
    return () => {
      set?.delete(handler as unknown as EventHandler<WorkerEvent['kind']>);
    };
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    worker.terminate();
    for (const [, slot] of pending) {
      slot.reject(
        new MataError({
          category: 'aborted',
          message: 'Bridge disposed',
          retryable: false,
        }),
      );
    }
    pending.clear();
    listeners.clear();
  }

  return { request, on, dispose };
}
