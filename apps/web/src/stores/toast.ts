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
 * Boot quiet-window for error toasts.
 *
 * On a cold load there is a 1-3s window where the worker is still
 * restoring session + bootstrapping crypto, but the UI has already
 * mounted home + auto-opened the last room. Any RPC that fires in
 * that window (loadRoomList, loadRoomHistory, subscribeRoom, …)
 * rejects with `Not logged in` until SdkSession comes up, and a
 * raw `showToast('error', …)` would surface that as an alarming
 * red pill in the corner — false alert.
 *
 * `bootSettled` flips to `true` the first time we see a real-sync
 * status (`syncing`) come through. Code paths that fire during the
 * initial-load race should call `showBootGuardedError` instead of
 * `showToast('error', …)`: it forwards once boot has settled, and
 * silently drops the toast (logs to console.warn) before that.
 *
 * This is NOT for genuine user-actionable errors (failed send,
 * upload retry, permission denied on join, …). Those originate
 * from a user gesture and should always toast — keep using
 * `showToast` for them.
 */
const [bootSettled, setBootSettled] = createSignal(false);

export { bootSettled };

export function markBootSettled(): void {
  if (!bootSettled()) setBootSettled(true);
}

export function showBootGuardedError(message: string, durationMs = 4000): number | null {
  if (!bootSettled()) {
    // Log once so debugging is still possible; do not surface to UI.
    console.warn('[toast/boot-guarded suppressed]', message);
    return null;
  }
  return showToast('error', message, durationMs);
}

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
