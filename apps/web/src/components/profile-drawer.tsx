/**
 * Profile drawer (Phase 1) — a right-side slide-over opened by clicking
 * any avatar (message gutter, member row, DM header). Mirrors the
 * members/search panel `aside` pattern so motion + chrome stay uniform.
 *
 * Phase 1 surfaces:
 *   - Identity: large initials avatar + live presence dot, display name
 *     (canonical `/profile` displayname → room member name → localpart),
 *     `@user:server` (click-to-copy), and "last seen" / "online".
 *   - Trust pill + role (Admin/Moderator) when known from room state.
 *   - Actions: Message (open/create DM) and Block/Unblock
 *     (m.ignored_user_list).
 *
 * Device-level Verify, shared media, and common rooms are later phases.
 * Everything degrades gracefully: a federated profile fetch that fails
 * just falls back to the localpart; presence stays dark if the server
 * has it disabled.
 */
import { Show, createMemo, createResource, createSignal, createEffect, For } from 'solid-js';
import type { Device, RoomMember, UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials, prettyName } from './message-bubble.js';
import { PresenceDot } from './presence-dot.js';
import { presenceOf, lastSeenLabel, ensurePresence } from '../stores/presence.js';
import { startVerification, activeFlow } from '../stores/verification.js';

export function ProfileDrawer(props: {
  userId: UserId | null;
  member?: RoomMember | null;
  isEncrypted: boolean;
  myUserId: UserId | null;
  onClose: () => void;
  onMessage: (userId: UserId) => void;
}) {
  const bridge = useBridge();
  const [ignoredLocal, setIgnoredLocal] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [profile] = createResource(
    () => props.userId,
    async (uid) => {
      ensurePresence(bridge, uid);
      setIgnoredLocal(null);
      const res = await bridge.request({ kind: 'fetchProfile', userId: uid });
      if (res.kind === 'fetchProfile') {
        setIgnoredLocal(res.ignored);
        return res;
      }
      return null;
    },
  );

  const name = createMemo(() => {
    const uid = props.userId;
    if (!uid) return '';
    return profile()?.displayName || props.member?.displayname || prettyName(uid);
  });
  const isSelf = createMemo(() => !!props.userId && props.userId === props.myUserId);
  const ignored = createMemo(() => ignoredLocal() ?? false);

  const copyId = async () => {
    const uid = props.userId;
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      showToast('success', 'User ID copied');
    } catch {
      showToast('error', 'Copy failed');
    }
  };

  const toggleIgnore = async () => {
    const uid = props.userId;
    if (!uid || busy()) return;
    const next = !ignored();
    setBusy(true);
    try {
      await bridge.request({ kind: 'setIgnored', userId: uid, ignored: next });
      setIgnoredLocal(next);
      showToast('success', next ? 'User blocked' : 'User unblocked');
    } catch {
      showToast('error', 'Could not update block state');
    } finally {
      setBusy(false);
    }
  };

  // Phase 2: device list + per-device verify. Only meaningful in
  // encrypted contexts (trust is a cross-signing concept). The resource
  // re-runs when the viewed user changes; we also refetch when a
  // verification flow finishes so freshly-verified devices flip to green.
  const [devices, { refetch: refetchDevices }] = createResource(
    () => (props.isEncrypted ? props.userId : null),
    async (uid) => {
      const res = await bridge.request({ kind: 'fetchUserDevices', userId: uid });
      return res.kind === 'fetchUserDevices' ? res.devices : [];
    },
  );

  // When the global verification modal closes, refresh trust state.
  let hadFlow = false;
  createEffect(() => {
    const active = !!activeFlow();
    if (hadFlow && !active) void refetchDevices();
    hadFlow = active;
  });

  // Devices worth showing a Verify button for: skip our own current
  // device (you can't verify yourself against yourself) and already-
  // verified ones.
  const verifyDevice = (deviceId: string) => {
    const uid = props.userId;
    if (!uid) return;
    void startVerification(bridge, uid, deviceId);
  };

  const trustPill = createMemo(() => {
    const t = props.member?.trust;
    if (!props.isEncrypted || !t) return null;
    if (t === 'verified') return { text: 'Verified', cls: 'bg-emerald-500 text-white' };
    if (t === 'unverified') return { text: 'Not verified', cls: 'bg-amber-500 text-white' };
    return { text: 'Unknown device', cls: 'bg-neutral-400 text-white' };
  });
  const roleLabel = createMemo(() => {
    const p = props.member?.powerLevel ?? 0;
    if (p >= 100) return 'Admin';
    if (p >= 50) return 'Moderator';
    return null;
  });

  return (
    <Show when={props.userId}>
      <aside class="absolute inset-y-0 right-0 z-30 flex w-72 flex-col border-l border-line bg-elev shadow-xl">
        <div class="flex items-center justify-between border-b border-line px-3 py-2">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-fg-3">Profile</span>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded-md p-1 text-fg-3 hover:bg-input hover:text-fg"
            aria-label="Close profile"
          >
            ✕
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <div class="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <div class="relative">
              <div class="flex h-20 w-20 items-center justify-center rounded-full bg-input text-2xl font-semibold text-fg-2">
                {initials(props.userId ?? undefined)}
              </div>
              <PresenceDot userId={props.userId!} overlay />
            </div>
            <div class="text-base font-semibold text-fg">{name()}</div>
            <button
              type="button"
              onClick={() => void copyId()}
              title="Copy user ID"
              class="font-mono text-[11px] text-fg-3 transition-colors hover:text-fg"
            >
              {props.userId}
            </button>
            <Show when={lastSeenLabel(presenceOf(props.userId ?? ''))}>
              {(l) => <div class="text-[11px] text-fg-3">{l()}</div>}
            </Show>
            <div class="mt-1 flex flex-wrap items-center justify-center gap-1.5">
              <Show when={trustPill()}>
                {(t) => (
                  <span class={`rounded-full px-2 py-0.5 text-[10px] font-medium ${t().cls}`}>{t().text}</span>
                )}
              </Show>
              <Show when={roleLabel()}>
                {(r) => (
                  <span class="rounded-full bg-input px-2 py-0.5 text-[10px] font-medium text-fg-2">{r()}</span>
                )}
              </Show>
            </div>
          </div>

          <Show
            when={!isSelf()}
            fallback={<p class="px-4 pb-4 text-center text-[11px] text-fg-3">This is you.</p>}
          >
            <div class="flex flex-col gap-2 px-4 pb-4">
              <button
                type="button"
                onClick={() => props.userId && props.onMessage(props.userId)}
                class="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-[filter] hover:brightness-95"
              >
                Message
              </button>
              <button
                type="button"
                onClick={() => void toggleIgnore()}
                disabled={busy()}
                classList={{
                  'w-full rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50': true,
                  'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40':
                    !ignored(),
                  'border-line text-fg-2 hover:bg-input': ignored(),
                }}
              >
                {ignored() ? 'Unblock user' : 'Block user'}
              </button>
              <Show when={ignored()}>
                <p class="text-center text-[10px] text-fg-3">
                  You won't see messages from this user.
                </p>
              </Show>
            </div>
          </Show>

          <Show when={props.isEncrypted}>
            <div class="border-t border-line px-4 py-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-[10px] font-semibold uppercase tracking-wide text-fg-3">
                  {isSelf() ? 'Your devices' : 'Devices'}
                </span>
                <Show when={devices.loading}>
                  <span class="text-[10px] text-fg-3">Loading…</span>
                </Show>
              </div>

              <Show
                when={(devices() ?? []).length > 0}
                fallback={
                  <Show when={!devices.loading}>
                    <p class="text-[11px] text-fg-3">No devices found.</p>
                  </Show>
                }
              >
                <ul class="flex flex-col gap-1.5">
                  <For each={devices()}>
                    {(d: Device) => {
                      const verified = d.verified === 'verified';
                      // Can't SAS-verify our own current session against itself.
                      const selfCurrent = isSelf() && d.isCurrent;
                      return (
                        <li class="flex items-center gap-2 rounded-lg bg-input/60 px-2.5 py-2">
                          <span
                            class={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                              verified ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            aria-hidden="true"
                          />
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-[12px] font-medium text-fg">
                              {d.displayName || d.deviceId}
                              <Show when={d.isCurrent}>
                                <span class="ml-1 text-[10px] font-normal text-fg-3">(this device)</span>
                              </Show>
                            </div>
                            <div class="truncate font-mono text-[10px] text-fg-3">{d.deviceId}</div>
                          </div>
                          <Show
                            when={!verified && !selfCurrent}
                            fallback={
                              <span
                                class={`shrink-0 text-[10px] font-medium ${
                                  verified ? 'text-emerald-600 dark:text-emerald-400' : 'text-fg-3'
                                }`}
                              >
                                {verified ? 'Verified' : '—'}
                              </span>
                            }
                          >
                            <button
                              type="button"
                              onClick={() => verifyDevice(d.deviceId)}
                              class="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-fg-2 transition-colors hover:bg-elev hover:text-fg"
                            >
                              Verify
                            </button>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
                <p class="mt-2 text-[10px] leading-snug text-fg-3">
                  {isSelf()
                    ? 'Verify each device to confirm your encrypted sessions are trusted.'
                    : 'Verifying confirms this contact is who they claim to be.'}
                </p>
              </Show>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
