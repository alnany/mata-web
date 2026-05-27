import { createResource, For, Show, createSignal } from 'solid-js';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import { themeMode, setThemeMode, type ThemeMode } from '../stores/theme.js';
import { withToast } from '../stores/toast.js';
import { useNavigate } from '@solidjs/router';
import type { Device } from '@mata/shared/matrix';

/**
 * Settings drawer — slides in from the left over the app shell.
 *
 * Includes:
 * - Profile (read-only display of user id + device id for now)
 * - Appearance (light / dark / system)
 * - Devices (signed-in sessions, from listDevices RPC)
 * - Sign out
 *
 * Display-name editing, avatar upload, and notification settings are
 * Phase 4B: they need additional RPC methods we haven't wired yet
 * (setDisplayName, setAvatar, pushRules). Same for device verification
 * (E2EE phase).
 */
export function SettingsDrawer(props: { open: boolean; onClose: () => void }) {
  const bridge = useBridge();
  const navigate = useNavigate();

  const [tab, setTab] = createSignal<'profile' | 'appearance' | 'devices'>('profile');

  const [devices] = createResource<Device[]>(
    () => (props.open && tab() === 'devices' ? Math.random() : null), // refetch when tab opened
    async () => {
      const res = await withToast(
        bridge.request({ kind: 'listDevices' }),
        'Could not load devices',
      );
      return res.devices;
    },
  );

  const me = () => {
    const s = session();
    return s.phase === 'authenticated' ? s : null;
  };

  const signOut = async () => {
    try {
      await bridge.request({ kind: 'logout' });
    } catch {
      // ignore
    }
    setSession({ phase: 'anonymous' });
    props.onClose();
    navigate('/login', { replace: true });
  };

  /**
   * Reset encryption data — nukes the local rust-crypto IndexedDB stores
   * and signs out. The user signs back in with a fresh crypto session.
   *
   * Used as the escape hatch when the wasm bridge deadlocks on every
   * sync cycle (corrupted device-tracking state on disk). The watchdog
   * keeps the UI usable but key exchange never converges; only a wipe
   * fixes it.
   *
   * We stop the client first (via logout), then delete every matrix-js-sdk
   * IndexedDB database from the main thread, then hard-reload so any
   * in-memory caches drop too. Login page re-prompts for password.
   */
  const [resetBusy, setResetBusy] = createSignal(false);
  const resetEncryption = async () => {
    if (resetBusy()) return;
    const ok = window.confirm(
      'Reset encryption data?\n\n' +
        'This will:\n' +
        '• Sign you out\n' +
        '• Delete locally cached encryption keys\n' +
        '• Reload the app\n\n' +
        'Your messages on the server are NOT affected, but you may lose access ' +
        "to history in encrypted rooms until other devices share keys back. " +
        'Use this when the connection banner shows repeated "wasm bridge deadlocked" errors.',
    );
    if (!ok) return;
    setResetBusy(true);
    try {
      try {
        await bridge.request({ kind: 'logout' });
      } catch {
        // best-effort — even if logout fails (already disconnected),
        // we still want to wipe and reload.
      }
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (idb) {
        const PREFIX = 'matrix-js-sdk';
        let names: string[] = [];
        if (typeof (idb as { databases?: unknown }).databases === 'function') {
          const list = (await idb.databases()) as Array<{ name?: string }>;
          names = list
            .map((d) => d.name ?? '')
            .filter((n) => n && n.startsWith(PREFIX));
        } else {
          names = [
            `${PREFIX}::matrix-sdk-crypto`,
            `${PREFIX}::matrix-sdk-crypto-meta`,
            `${PREFIX}:crypto`,
            `${PREFIX}:riot-web-sync`,
          ];
        }
        await Promise.all(
          names.map(
            (name) =>
              new Promise<void>((resolve) => {
                const req = idb.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              }),
          ),
        );
      }
    } finally {
      // Hard reload — drops any in-memory crypto state in the worker too.
      window.location.replace('/login');
      // location.replace won't synchronously unload; ensure we don't
      // re-enable the button if the user is still on this page somehow.
      setTimeout(() => setResetBusy(false), 5000);
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40 flex"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div
          class="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={props.onClose}
        />
        <aside class="relative z-10 flex h-full w-[420px] max-w-[90vw] flex-col border-r border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
          <header class="flex items-center justify-between border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
            <h2 class="text-base font-semibold">Settings</h2>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
          <nav class="flex gap-1 border-b border-neutral-200 px-4 dark:border-neutral-800">
            {(['profile', 'appearance', 'devices'] as const).map((t) => (
              <button
                type="button"
                onClick={() => setTab(t)}
                class={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab() === t
                    ? 'border-mata-500 text-mata-600 dark:text-mata-500'
                    : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
                }`}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>

          <div class="flex-1 overflow-y-auto p-5">
            <Show when={tab() === 'profile'}>
              <div class="space-y-4">
                <div>
                  <label class="block text-xs font-medium text-neutral-500">User ID</label>
                  <div class="mt-1 break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs dark:bg-neutral-900">
                    {me()?.userId ?? '—'}
                  </div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-neutral-500">Device ID</label>
                  <div class="mt-1 break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs dark:bg-neutral-900">
                    {me()?.deviceId ?? '—'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={signOut}
                  class="mt-6 w-full rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  onClick={resetEncryption}
                  disabled={resetBusy()}
                  class="mt-2 w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400 dark:hover:bg-amber-950"
                >
                  {resetBusy() ? 'Resetting…' : 'Reset encryption data'}
                </button>
                <p class="text-[11px] text-neutral-500">
                  Use this if the connection banner repeatedly shows
                  "wasm bridge deadlocked" or encrypted sends never succeed.
                  Signs you out and clears local encryption keys.
                </p>
              </div>
            </Show>

            <Show when={tab() === 'appearance'}>
              <div class="space-y-3">
                <label class="block text-sm font-medium">Theme</label>
                <div class="grid grid-cols-3 gap-2">
                  {(['light', 'dark', 'system'] as ThemeMode[]).map((m) => (
                    <button
                      type="button"
                      onClick={() => setThemeMode(m)}
                      class={`rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                        themeMode() === m
                          ? 'border-mata-500 bg-mata-500/10 text-mata-600 dark:text-mata-500'
                          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </Show>

            <Show when={tab() === 'devices'}>
              <div class="space-y-2">
                <Show
                  when={!devices.loading}
                  fallback={<div class="text-sm text-neutral-500">Loading…</div>}
                >
                  <Show
                    when={(devices() ?? []).length > 0}
                    fallback={<div class="text-sm text-neutral-500">No other devices.</div>}
                  >
                    <For each={devices()}>
                      {(d) => (
                        <div class="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                          <div class="flex items-baseline justify-between gap-2">
                            <span class="truncate text-sm font-medium">
                              {d.displayName || d.deviceId}
                            </span>
                            <Show when={d.verified === 'verified'}>
                              <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                                verified
                              </span>
                            </Show>
                          </div>
                          <div class="mt-1 font-mono text-[10px] text-neutral-500">{d.deviceId}</div>
                          <Show when={d.lastSeenTs}>
                            <div class="text-[11px] text-neutral-500">
                              last seen {new Date(d.lastSeenTs as number).toLocaleString()}
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
                <p class="pt-3 text-[11px] text-neutral-500">
                  Device verification and key backup land with the encryption rollout.
                </p>
              </div>
            </Show>
          </div>

          <footer class="border-t border-neutral-200 px-5 py-3 text-[11px] text-neutral-500 dark:border-neutral-800">
            Mata · built on Matrix protocol
          </footer>
        </aside>
      </div>
    </Show>
  );
}
