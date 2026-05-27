/**
 * Toast store — surfaces errors and confirmations to the user.
 *
 * Any RPC rejection or unexpected failure should produce a toast. Silent
 * failures were one of the Phase-3 bugs (broken Send button felt like it
 * "did nothing").
 */

import { createSignal } from 'solid-js';

export type ToastKind = 'error' | 'info' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** ms to auto-dismiss; 0 means sticky. */
  durationMs: number;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export function showToast(kind: ToastKind, message: string, durationMs = 4000): number {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, kind, message, durationMs }]);
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export { toasts };

/**
 * Wrap an async action: any thrown error becomes a visible toast.
 * Re-throws so callers can still react if they want, but UI noise is
 * guaranteed regardless.
 */
export async function withToast<T>(
  promise: Promise<T>,
  errorPrefix = 'Failed',
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast('error', `${errorPrefix}: ${msg}`);
    throw err;
  }
}
