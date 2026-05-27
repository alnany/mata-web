// ============================================================================
// MembersPanel — slide-in right rail listing the room's people.
//
// Sectioned by membership:
//   - Joined (default expanded)
//   - Invited (folded into the same list, badge-tagged)
// `leave`/`ban` rows are hidden in v1; the row count under the joined
// header is the primary "how many" answer.
//
// Trust indicator (encrypted rooms only):
//   🟢 verified     master cross-signing key trusted by us
//   ⚠️ unverified   user has cross-signing but it isn't trusted yet
//   ⚫ unknown      no cross-signing or empty device list
//
// Kick is the only state-changing action wired right now and only
// renders when the current user's power level outranks the target's.
// The full power-level editor lives in a future "room admin" pass.
// ============================================================================

import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from 'solid-js';
import type { RoomMember, RoomSummary, UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials, prettyName } from './message-bubble.js';

export function MembersPanel(props: {
  room: RoomSummary;
  open: boolean;
  myUserId: UserId | null;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [search, setSearch] = createSignal('');
  const [acting, setActing] = createSignal<Record<string, boolean>>({});

  // `version` is a bumpable token to force createResource to re-fetch
  // after we mutate (kick / invite). Solid's resource refetch() would
  // do the same, but a signal-driven key composes better with
  // createResource's source-tracking and keeps the loading state
  // visible across mutations.
  const [version, setVersion] = createSignal(0);
  const [members] = createResource(
    () => (props.open ? [props.room.roomId, version()] : null),
    async () => {
      const res = await bridge.request({
        kind: 'loadRoomMembers',
        roomId: props.room.roomId,
      });
      return res.members;
    },
  );

  const myPower = (): number => {
    const me = props.myUserId;
    if (!me) return 0;
    return members()?.find((m) => m.userId === me)?.powerLevel ?? 0;
  };

  const canKick = (m: RoomMember): boolean => {
    return (
      m.userId !== props.myUserId &&
      m.membership === 'join' &&
      myPower() > m.powerLevel &&
      myPower() >= 50
    );
  };

  const kick = async (m: RoomMember) => {
    if (acting()[m.userId]) return;
    if (!confirm(`Remove ${m.displayname || m.userId} from this room?`)) return;
    setActing({ ...acting(), [m.userId]: true });
    try {
      await bridge.request({
        kind: 'kickFromRoom',
        roomId: props.room.roomId,
        userId: m.userId,
        reason: null,
      });
      showToast('success', 'Removed');
      setVersion(version() + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Remove failed: ${msg}`);
    } finally {
      const next = { ...acting() };
      delete next[m.userId];
      setActing(next);
    }
  };

  const filtered = (): { joined: RoomMember[]; invited: RoomMember[] } => {
    const all = members() ?? [];
    const q = search().trim().toLowerCase();
    const match = (m: RoomMember) =>
      !q ||
      m.userId.toLowerCase().includes(q) ||
      (m.displayname ?? '').toLowerCase().includes(q);
    return {
      joined: all.filter((m) => m.membership === 'join' && match(m)),
      invited: all.filter((m) => m.membership === 'invite' && match(m)),
    };
  };

  return (
    <Show when={props.open}>
      <aside
        class="absolute inset-y-0 right-0 z-20 flex w-72 flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
        aria-label="Members panel"
      >
        <header class="flex items-center gap-2 border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
          <span class="text-sm font-semibold">People</span>
          <span class="text-[11px] text-neutral-500">
            <Show when={members()} fallback="…">
              {(_) => `${filtered().joined.length}`}
            </Show>
          </span>
          <button
            type="button"
            onClick={props.onClose}
            class="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div class="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <input
            type="text"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search members…"
            class="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs focus:border-mata-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:bg-neutral-900"
          />
        </div>

        <div class="flex-1 overflow-y-auto">
          <Switch>
            <Match when={members.loading}>
              <div class="px-4 py-6 text-center text-xs text-neutral-500">Loading…</div>
            </Match>
            <Match when={members.error}>
              <div class="px-4 py-6 text-center text-xs text-red-500">
                Couldn't load members.
              </div>
            </Match>
            <Match when={members()}>
              <Show when={filtered().invited.length > 0}>
                <SectionHeader label="Invited" count={filtered().invited.length} />
                <For each={filtered().invited}>
                  {(m) => (
                    <MemberRow
                      member={m}
                      isMe={m.userId === props.myUserId}
                      canKick={false}
                      showInviteBadge
                      isEncrypted={props.room.isEncrypted}
                      acting={!!acting()[m.userId]}
                      onKick={() => kick(m)}
                    />
                  )}
                </For>
              </Show>
              <SectionHeader label="Joined" count={filtered().joined.length} />
              <For each={filtered().joined}>
                {(m) => (
                  <MemberRow
                    member={m}
                    isMe={m.userId === props.myUserId}
                    canKick={canKick(m)}
                    isEncrypted={props.room.isEncrypted}
                    acting={!!acting()[m.userId]}
                    onKick={() => kick(m)}
                  />
                )}
              </For>
              <Show
                when={filtered().joined.length === 0 && filtered().invited.length === 0}
              >
                <div class="px-4 py-6 text-center text-xs text-neutral-500">
                  No members match.
                </div>
              </Show>
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
  );
}

function SectionHeader(props: { label: string; count: number }) {
  return (
    <div class="sticky top-0 z-10 flex items-center gap-2 bg-white/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 backdrop-blur dark:bg-neutral-900/95">
      <span>{props.label}</span>
      <span class="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
        {props.count}
      </span>
    </div>
  );
}

function MemberRow(props: {
  member: RoomMember;
  isMe: boolean;
  canKick: boolean;
  showInviteBadge?: boolean;
  isEncrypted: boolean;
  acting: boolean;
  onKick: () => void;
}) {
  const m = props.member;
  const name = m.displayname || prettyName(m.userId);
  const powerBadge = (): string | null => {
    if (m.powerLevel >= 100) return 'Admin';
    if (m.powerLevel >= 50) return 'Mod';
    return null;
  };
  return (
    <div class="group flex items-center gap-2.5 border-b border-neutral-100 px-3 py-2 last:border-b-0 dark:border-neutral-800/60">
      <div class="relative shrink-0">
        <div class="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {initials(name)}
        </div>
        <Show when={props.isEncrypted && m.trust && m.membership === 'join'}>
          <span
            class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white text-[9px] dark:border-neutral-900"
            classList={{
              'bg-emerald-500 text-white': m.trust === 'verified',
              'bg-amber-500 text-white': m.trust === 'unverified',
              'bg-neutral-400 text-white': m.trust === 'unknown',
            }}
            title={
              m.trust === 'verified'
                ? 'Verified'
                : m.trust === 'unverified'
                  ? 'Devices not verified'
                  : 'No cross-signing yet'
            }
          >
            {m.trust === 'verified' ? '✓' : m.trust === 'unverified' ? '!' : '?'}
          </span>
        </Show>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="truncate text-sm font-medium">{name}</span>
          <Show when={props.isMe}>
            <span class="rounded-full bg-mata-50 px-1.5 py-0.5 text-[9px] font-medium text-mata-700 dark:bg-mata-900/40 dark:text-mata-300">
              you
            </span>
          </Show>
          <Show when={props.showInviteBadge}>
            <span class="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              invited
            </span>
          </Show>
          <Show when={powerBadge()}>
            {(label) => (
              <span class="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[9px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {label()}
              </span>
            )}
          </Show>
        </div>
        <div class="truncate text-[10px] text-neutral-500">{m.userId}</div>
      </div>
      <Show when={props.canKick}>
        <button
          type="button"
          onClick={props.onKick}
          disabled={props.acting}
          class="opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-50"
          aria-label="Remove from room"
          title="Remove from room"
        >
          <span class="rounded-md border border-red-200 px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40">
            Kick
          </span>
        </button>
      </Show>
    </div>
  );
}
