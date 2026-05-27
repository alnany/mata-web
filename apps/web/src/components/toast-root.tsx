import { For } from 'solid-js';
import { dismissToast, toasts, type ToastKind } from '../stores/toast.js';

const styles: Record<ToastKind, string> = {
  error: 'bg-red-600 text-white',
  info: 'bg-neutral-900 text-white dark:bg-neutral-800',
  success: 'bg-emerald-600 text-white',
};

export function ToastRoot() {
  return (
    <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      <For each={toasts()}>
        {(t) => (
          <div
            class={`toast-enter pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ${styles[t.kind]}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            <span class="flex-1 leading-5">{t.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              class="-mr-1 -mt-1 shrink-0 rounded p-1 text-xs opacity-70 hover:bg-white/10 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
