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

  let counter = 0;
  const nextId = (): string => `rpc-${++counter}`;

  worker.addEventListener('message', (ev: MessageEvent<ResponseEnvelope | EventEnvelope>) => {
    const env = ev.data;
    if (!env) return;

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
    set.add(handler as EventHandler<WorkerEvent['kind']>);
    return () => {
      set?.delete(handler as EventHandler<WorkerEvent['kind']>);
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
