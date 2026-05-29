import { createEffect, createResource, For, Show, createSignal } from 'solid-js';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import { themeMode, setThemeMode, type ThemeMode } from '../stores/theme.js';
import {
  notifyEnabled,
  notifyPermission,
  setNotifyEnabled,
} from '../stores/notifications.js';
import { withToast } from '../stores/toast.js';
import { useNavigate } from '@solidjs/router';
import type { Device } from '@mata/shared/matrix';
import { EncryptionPanel } from './encryption-panel.js';
import { startVerification } from '../stores/verification.js';
import { clearRoomList, clearAllTimelines } from '../lib/persistent-cache.js';

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
type SettingsTab = 'profile' | 'appearance' | 'encryption' | 'devices';

export function SettingsDrawer(props: {
  open: boolean;
  onClose: () => void;
  /**
   * Optional tab to land on when the drawer opens. Used by the
   * timeline's "Restore from backup" CTA, which deep-links straight
   * to the Encryption tab. When omitted/null, falls back to the
   * previously-selected tab (defaults to 'profile' on first open).
   */
  initialTab?: SettingsTab | null;
}) {
  const bridge = useBridge();
  const navigate = useNavigate();

  const [tab, setTab] = createSignal<SettingsTab>('profile');

  // When the drawer is opened with an explicit initialTab, jump to it.
  // We watch (open, initialTab) together so that re-opening the drawer
  // with the same tab still re-applies — e.g. user closes the drawer,
  // clicks Restore again, and we re-land on Encryption even though the
  // `initialTab` value didn't change between the two opens.
  createEffect(() => {
    if (props.open && props.initialTab) setTab(props.initialTab);
  });

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
    // Drop persisted UI caches so the next account signing in here
    // can't see this user's room names / timeline tails / unread
    // counts on first paint. Worker-side media cache + matrix-sdk
    // stores are cleared by the `logout` RPC above; these two are
    // main-thread state.
    await Promise.all([clearRoomList(), clearAllTimelines()]).catch(() => {});
    try {
      // Persisted "last opened room" pointer (see home.tsx auto-select).
      localStorage.removeItem('mata:lastRoomId');
    } catch {
      /* private mode */
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
        <aside class="relative z-10 flex h-full w-[420px] max-w-[90vw] flex-col border-r border-line bg-elev shadow-2xl">
          <header class="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 class="text-base font-semibold">Settings</h2>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded p-1 text-fg-3 hover:bg-input hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
          <nav class="flex gap-1 border-b border-line px-4">
            {(['profile', 'appearance', 'encryption', 'devices'] as const).map((t) => (
              <button
                type="button"
                onClick={() => setTab(t)}
                class={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab() === t
                    ? 'border-mata-500 text-mata-600 dark:text-mata-500'
                    : 'border-transparent text-fg-3 hover:text-fg'
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
                  <label class="block text-xs font-medium text-fg-3">User ID</label>
                  <div class="mt-1 break-all rounded-lg bg-input px-3 py-2 font-mono text-xs">
                    {me()?.userId ?? '—'}
                  </div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-fg-3">Device ID</label>
                  <div class="mt-1 break-all rounded-lg bg-input px-3 py-2 font-mono text-xs">
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
                <p class="text-[11px] text-fg-3">
                  Use this if the connection banner repeatedly shows
                  "wasm bridge deadlocked" or encrypted sends never succeed.
                  Signs you out and clears local encryption keys.
                </p>
              </div>
            </Show>

            <Show when={tab() === 'appearance'}>
              <div class="space-y-6">
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
                            : 'border-line hover:border-line'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div class="space-y-2">
                  <label class="block text-sm font-medium">Notifications</label>
                  {/*
                    The permission request must come from THIS click — the
                    browser silently denies any Notification.requestPermission()
                    call that lacks a user gesture in the call stack.
                  */}
                  <div class="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
                    <div class="min-w-0 flex-1">
                      <div class="text-sm">Desktop notifications</div>
                      <div class="text-[11px] text-fg-3">
                        Chime + browser toast for mentions and new messages in
                        rooms you're not viewing.
                      </div>
                      <Show when={notifyEnabled() && notifyPermission() !== 'granted'}>
                        <div class="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                          Browser permission not granted — open browser settings
                          to allow notifications for this site.
                        </div>
                      </Show>
                    </div>
                    <button
                      type="button"
                      onClick={() => void setNotifyEnabled(!notifyEnabled())}
                      class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        notifyEnabled()
                          ? 'bg-mata-500'
                          : 'bg-input'
                      }`}
                      aria-pressed={notifyEnabled()}
                      aria-label="Toggle notifications"
                    >
                      <span
                        class={`inline-block h-4 w-4 transform rounded-full bg-elev shadow transition-transform ${
                          notifyEnabled() ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={tab() === 'encryption'}>
              <EncryptionPanel />
            </Show>

            <Show when={tab() === 'devices'}>
              <div class="space-y-2">
                <Show
                  when={!devices.loading}
                  fallback={<div class="text-sm text-fg-3">Loading…</div>}
                >
                  <Show
                    when={(devices() ?? []).length > 0}
                    fallback={<div class="text-sm text-fg-3">No other devices.</div>}
                  >
                    <For each={devices()}>
                      {(d) => {
                        const m = me();
                        const isThis = m && d.deviceId === m.deviceId;
                        const canVerify =
                          !!m && !isThis && d.verified !== 'verified';
                        return (
                          <div class="rounded-lg border border-line p-3">
                            <div class="flex items-baseline justify-between gap-2">
                              <span class="truncate text-sm font-medium">
                                {d.displayName || d.deviceId}
                              </span>
                              <div class="flex items-center gap-1.5">
                                <Show when={isThis}>
                                  <span class="rounded bg-mata-50 px-1.5 py-0.5 text-[10px] font-medium text-mata-700 dark:bg-mata-900/40 dark:text-mata-300">
                                    this device
                                  </span>
                                </Show>
                                <Show when={d.verified === 'verified'}>
                                  <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                                    verified
                                  </span>
                                </Show>
                                <Show when={d.verified === 'unverified'}>
                                  <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                                    not verified
                                  </span>
                                </Show>
                              </div>
                            </div>
                            <div class="mt-1 font-mono text-[10px] text-fg-3">{d.deviceId}</div>
                            <Show when={d.lastSeenTs}>
                              <div class="text-[11px] text-fg-3">
                                last seen {new Date(d.lastSeenTs as number).toLocaleString()}
                              </div>
                            </Show>
                            <Show when={canVerify}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!m) return;
                                  void startVerification(
                                    bridge,
                                    m.userId,
                                    d.deviceId,
                                  );
                                }}
                                class="mt-2 rounded-md border border-mata-300 bg-mata-50 px-2.5 py-1 text-[11px] font-medium text-mata-700 hover:bg-mata-100 dark:border-mata-800 dark:bg-mata-950/40 dark:text-mata-300 dark:hover:bg-mata-950/60"
                              >
                                Verify with emojis
                              </button>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
                <p class="pt-3 text-[11px] text-fg-3">
                  Devices marked verified have been cross-signed with your
                  master key. Set up key backup in the Encryption tab to
                  unlock cross-device key recovery.
                </p>
              </div>
            </Show>
          </div>

          <footer class="border-t border-line px-5 py-3 text-[11px] text-fg-3">
            Mata · built on Matrix protocol
          </footer>
        </aside>
      </div>
    </Show>
  );
}
