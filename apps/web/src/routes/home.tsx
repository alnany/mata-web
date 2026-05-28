import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { bridgeDiag } from '../bridge/worker-client.js';
import { session, setSession } from '../stores/session.js';
import { showToast } from '../stores/toast.js';
import type { RoomId, RoomSummary } from '@mata/shared/matrix';
import { RoomView, createRoomCache, type RoomCache } from './room-view.js';
import { SettingsDrawer } from '../components/settings-drawer.js';
import { dispatchSyncDeltas, setRoomCounts } from '../stores/notifications.js';
import { NewRoomModal } from '../components/new-room-modal.js';
import { readRoomList, writeRoomList } from '../lib/persistent-cache.js';
import { listTime } from '../lib/date-buckets.js';
import { initials } from '../components/message-bubble.js';

export function HomePage() {
  const bridge = useBridge();
  const navigate = useNavigate();

  // -------- Room list with persistent cache for instant first paint -------
  const [rooms, setRooms] = createSignal<RoomSummary[] | null>(null);
  const [filter, setFilter] = createSignal('');
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [newRoomOpen, setNewRoomOpen] = createSignal(false);

  // ---- Invite accept/decline -------------------------------------------
  // `acting` indexes by roomId so the Accept/Decline buttons can show
  // their per-row pending state without a heavier component split.
  const [acting, setActing] = createSignal<Record<string, 'join' | 'leave'>>({});
  const respondToInvite = async (roomId: RoomId, action: 'join' | 'leave') => {
    if (acting()[roomId]) return;
    setActing({ ...acting(), [roomId]: action });
    try {
      if (action === 'join') {
        const res = await bridge.request({ kind: 'joinRoom', roomId });
        showToast('success', 'Joined room');
        // Don't force-open — let the sync delta promote it into the
        // joined list, then the user clicks normally. Forcing open
        // before the room exists in our cache causes a flash of
        // "Loading…" that we'd rather avoid.
        void res;
      } else {
        await bridge.request({ kind: 'leaveRoom', roomId });
        showToast('info', 'Invite declined');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `${action === 'join' ? 'Join' : 'Decline'} failed: ${msg}`);
    } finally {
      const next = { ...acting() };
      delete next[roomId];
      setActing(next);
    }
  };

  // Sync state pill ('idle' | 'connecting' | 'syncing' | 'reconnecting' | 'error')
  const [syncState, setSyncState] = createSignal<string>('connecting');
  // Stage hint (e.g., 'loading crypto (~9MB)') — shown next to the pill so
  // a stuck startup is observable, not silent.
  const [syncReason, setSyncReason] = createSignal<string>('');
  // Append-only log of every distinct (state, reason) pair the worker has
  // emitted, in time order. The pill / single-reason banner is useless for
  // debugging a startup hang because the 4-second heartbeat overwrites
  // every interesting trace within 4s with "sdk sync state: null". This
  // log preserves every emit so the user can SEE the worker's progress
  // (or the exact point at which it stops emitting) without DevTools.
  // Bounded ring buffer so a long-running session can't OOM.
  type SyncLogEntry = { at: number; state: string; reason: string };
  const [syncLog, setSyncLog] = createSignal<SyncLogEntry[]>([]);
  const SYNC_LOG_MAX = 30;
  // Diagnostic tick that re-reads bridgeDiag counters every 500ms. The
  // bridgeDiag object is mutated by the bridge message handler regardless
  // of whether any handler is attached, so this surfaces the raw
  // worker→main message flow even if the syncStatus subscription path is
  // broken. Stays in the DOM as a single line we can read via the
  // browser tool's read_page_text.
  const [diagTick, setDiagTick] = createSignal(0);
  const diagInterval = window.setInterval(() => setDiagTick((n) => n + 1), 500);
  onCleanup(() => window.clearInterval(diagInterval));

  onCleanup(
    bridge.on('syncStatus', (e) => {
      setSyncState(e.status);
      setSyncReason(e.reason ?? '');
      const reason = e.reason ?? '<no reason>';
      setSyncLog((prev) => {
        // Dedup against most recent entry: the heartbeat emits the same
        // "sdk sync state: null" line every 4s; we only want one copy.
        const last = prev[prev.length - 1];
        if (last && last.state === e.status && last.reason === reason) {
          return prev;
        }
        const next = [...prev, { at: Date.now(), state: e.status, reason }];
        return next.length > SYNC_LOG_MAX
          ? next.slice(next.length - SYNC_LOG_MAX)
          : next;
      });
      if (e.status === 'error' && e.reason) {
        showToast('error', `Sync error: ${e.reason}`, 8000);
      }
    }),
  );

  // `diagNote` is the noise-only diagnostic feed (send-pipeline phase
  // markers, watchdog beacons, etc.). It lands in the same syncLog
  // panel the user sees but explicitly does NOT touch the sync-state
  // pill — otherwise every send / decrypt cycle would drag the pill
  // back to "connecting" forever even after sync reached `syncing`.
  // Logged with state='diag' so the row renders distinct from real
  // state transitions.
  onCleanup(
    bridge.on('diagNote', (e) => {
      const reason = e.note;
      setSyncLog((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.state === 'diag' && last.reason === reason) {
          return prev;
        }
        const next = [...prev, { at: Date.now(), state: 'diag', reason }];
        return next.length > SYNC_LOG_MAX
          ? next.slice(next.length - SYNC_LOG_MAX)
          : next;
      });
    }),
  );

  onMount(async () => {
    if (session().phase === 'anonymous') {
      navigate('/login', { replace: true });
      return;
    }
    // 1) Instant: paint from persisted cache if we have one.
    const cached = await readRoomList();
    if (cached && !rooms()) {
      setRooms(sortRooms(cached.rooms));
    }
    // 2) Live: ask the worker. Replaces cached snapshot once ready.
    void refetchRooms();
  });

  const refetchRooms = async () => {
    try {
      const res = await bridge.request({ kind: 'loadRoomList' });
      // Stable-reference merge: <For> in Solid keys by reference. If we
      // hand it a brand-new RoomSummary object on every sync, every row
      // re-mounts — that's the visible flashing. Preserve identity for
      // rooms whose fields are unchanged.
      const prev = rooms() ?? [];
      const merged = mergeRooms(prev, res.rooms);
      setRooms(merged);
      // Phase 11: push aggregate unread/highlight to notifications store
      // so the tab title reflects ground-truth server counts instead of
      // a session-wide accumulator.
      let u = 0, h = 0;
      for (const r of merged) { if (r.membership === 'join') { u += r.unreadCount; h += r.highlightCount; } }
      setRoomCounts({ unread: u, highlights: h });
      void writeRoomList(merged);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      showToast('error', `Failed to load rooms: ${m}`);
    }
  };

  // Refresh on every sync delta. Worker holds canonical state; this is cheap.
  onCleanup(
    bridge.on('syncUpdate', (e) => {
      refetchRooms();
      // Drive desktop notifications + chime + tab badge tally off the
      // same delta stream. Active room + focused window short-circuit
      // inside dispatchSyncDeltas, so no need to gate at the caller.
      const me = (() => {
        const s = session();
        return s.phase === 'authenticated' ? s.userId : null;
      })();
      const roomById = new Map<RoomId, RoomSummary>();
      for (const r of rooms() ?? []) roomById.set(r.roomId, r);
      dispatchSyncDeltas({
        deltas: e.deltas,
        activeRoomId: activeId(),
        me,
        roomById,
        onClickRoom: (rid) => {
          const r = roomById.get(rid);
          if (r) openRoom(r);
        },
      });
    }),
  );

  // -------- Active room + per-room cache (silky switch) -------------------
  const [activeId, setActiveId] = createSignal<RoomId | null>(null);
  const [caches, setCaches] = createStore<Record<string, RoomCache>>({});
  const updateCache = (roomId: RoomId, updater: (c: RoomCache) => void) => {
    setCaches(
      produce((state: Record<string, RoomCache>) => {
        if (!state[roomId]) state[roomId] = createRoomCache(roomId);
        updater(state[roomId]);
      }),
    );
  };

  const openRoom = (room: RoomSummary) => {
    if (!caches[room.roomId]) setCaches(room.roomId, createRoomCache(room.roomId));
    setActiveId(room.roomId);
  };

  /**
   * Stable reference: only changes when the underlying roomId changes.
   * Without this memo, every sync delta rebuilt the RoomSummary object
   * and propagated through to RoomView, even when the room's data was
   * actually unchanged. The visible flash on click came from here.
   */
  const activeRoom = createMemo<RoomSummary | null>(() => {
    const id = activeId();
    if (!id) return null;
    return (rooms() ?? []).find((r) => r.roomId === id) ?? null;
  });

  // -------- Filtered room list ------------------------------------------
  const joinedRooms = (): RoomSummary[] =>
    (rooms() ?? []).filter((r) => r.membership === 'join');
  const invitedRooms = (): RoomSummary[] =>
    (rooms() ?? []).filter((r) => r.membership === 'invite');

  const filteredRooms = (): RoomSummary[] => {
    const q = filter().trim().toLowerCase();
    const list = joinedRooms();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.topic ?? '').toLowerCase().includes(q) ||
        r.roomId.toLowerCase().includes(q),
    );
  };

  // -------- Keyboard shortcuts ------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const input = document.getElementById('mata-room-search') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <div class="grid h-full min-h-0 w-full grid-cols-[320px_1fr]">
      {/* Sidebar */}
      <aside class="flex h-full min-h-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
        <header class="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            class="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label="Settings"
            title="Settings"
          >
            ☰
          </button>
          <span class="text-sm font-semibold tracking-tight">Mata</span>
          <SyncPill state={syncState()} reason={syncReason()} />
          <button
            type="button"
            onClick={() => setNewRoomOpen(true)}
            class="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label="New conversation"
            title="New conversation"
          >
            ✎
          </button>
        </header>
        <SyncBanner
          state={syncState()}
          reason={syncReason()}
          log={syncLog()}
        />
        <BridgeDiagBanner ticks={diagTick()} />

        <div class="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div class="relative">
            <input
              id="mata-room-search"
              type="text"
              placeholder="Search rooms (⌘K)"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              class="w-full rounded-lg border border-neutral-200 bg-white py-1.5 pl-8 pr-3 text-sm placeholder:text-neutral-400 focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:border-neutral-800 dark:bg-neutral-900"
            />
            <span class="pointer-events-none absolute left-2.5 top-1.5 text-neutral-400">🔍</span>
          </div>
        </div>

        <Show when={invitedRooms().length > 0}>
          <div class="border-b border-neutral-200 bg-amber-50/60 px-3 py-2 dark:border-neutral-800 dark:bg-amber-950/30">
            <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Pending invites · {invitedRooms().length}
            </div>
            <ul class="space-y-1.5">
              <For each={invitedRooms()}>
                {(r) => (
                  <li class="flex items-center gap-2 rounded-md bg-white/70 px-2 py-1.5 text-xs dark:bg-neutral-900/70">
                    <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-100">
                      {initials(r.name || r.roomId)}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate font-medium">{r.name || r.roomId}</div>
                      <Show when={r.topic}>
                        <div class="truncate text-[10px] text-neutral-500">{r.topic}</div>
                      </Show>
                    </div>
                    <button
                      type="button"
                      onClick={() => respondToInvite(r.roomId, 'join')}
                      disabled={!!acting()[r.roomId]}
                      class="rounded-md bg-mata-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-mata-500 disabled:opacity-50"
                    >
                      {acting()[r.roomId] === 'join' ? '…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      onClick={() => respondToInvite(r.roomId, 'leave')}
                      disabled={!!acting()[r.roomId]}
                      class="rounded-md border border-neutral-300 px-2 py-1 text-[10px] font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      {acting()[r.roomId] === 'leave' ? '…' : 'Decline'}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        <Show
          when={joinedRooms().length > 0}
          fallback={
            <div class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500">
              <Show
                when={rooms() !== null}
                fallback={<span>Loading rooms…</span>}
              >
                <span>No rooms yet.</span>
              </Show>
            </div>
          }
        >
          <ul class="flex-1 overflow-y-auto">
            <For
              each={filteredRooms()}
              fallback={
                <li class="p-4 text-center text-xs text-neutral-500">No rooms match</li>
              }
            >
              {(room) => (
                <RoomRow
                  room={room}
                  active={activeId() === room.roomId}
                  onSelect={() => openRoom(room)}
                />
              )}
            </For>
          </ul>
        </Show>

        <footer class="border-t border-neutral-200 px-3 py-2 text-[10px] text-neutral-500 dark:border-neutral-800">
          {session().phase === 'authenticated' ? meLine() : '—'}
        </footer>
      </aside>

      {/* Main pane */}
      <div class="min-h-0">
        <Show
          when={activeRoom()}
          fallback={
            <section class="flex h-full items-center justify-center p-12 text-sm text-neutral-500">
              <div class="text-center">
                <div class="mb-3 text-4xl">💬</div>
                <p class="font-medium">Select a room to start chatting</p>
                <p class="mt-1 text-xs">Click any chat on the left, or press ⌘K to search.</p>
              </div>
            </section>
          }
        >
          {(room) => {
            // Ensure the cache exists before RoomView reads it. Without
            // this guard, `caches[id] ?? createRoomCache(id)` produced a
            // transient `loaded:false` cache on every reactive read,
            // resetting RoomView's loaded state and dropping the
            // pending-send bubble during a sync delta — which is why
            // sends felt broken.
            if (!caches[room().roomId]) {
              setCaches(room().roomId, createRoomCache(room().roomId));
            }
            return (
              <RoomView
                room={room()}
                cache={caches[room().roomId]}
                setCache={updateCache}
              />
            );
          }}
        </Show>
      </div>

      <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <NewRoomModal
        open={newRoomOpen()}
        onClose={() => setNewRoomOpen(false)}
        onCreated={(roomId) => {
          // The sync delta will land the room in our list shortly; once
          // it does the route param triggers RoomView. Pushing the
          // route immediately works because openRoom only looks up by
          // id and falls back gracefully if the row isn't there yet.
          navigate(`/rooms/${encodeURIComponent(roomId)}`);
          setActiveId(roomId);
        }}
      />
    </div>
  );
}

function meLine(): string {
  const s = session();
  if (s.phase !== 'authenticated') return '';
  return s.userId;
}

function SyncPill(props: { state: string; reason?: string }) {
  const map: Record<string, { color: string; label: string }> = {
    idle: { color: 'bg-neutral-400', label: 'idle' },
    connecting: { color: 'bg-amber-500 animate-pulse', label: 'connecting' },
    syncing: { color: 'bg-emerald-500', label: 'synced' },
    reconnecting: { color: 'bg-amber-500 animate-pulse', label: 'reconnecting' },
    error: { color: 'bg-red-500', label: 'error' },
  };
  const m = map[props.state] ?? map.idle;
  return (
    <span
      class="ml-auto inline-flex items-center gap-1 text-[10px] text-neutral-500"
      title={props.reason || m.label}
    >
      <span class={`inline-block h-1.5 w-1.5 rounded-full ${m.color}`} />
      {m.label}
    </span>
  );
}

// Dedicated diagnostic banner — full-width under the sidebar header — so
// stage hints / errors are readable instead of getting truncated in the
// 130-ish-pixel slot the pill has. Renders a SCROLLING LOG of every
// distinct syncStatus emit so a stuck startup is fully observable: the
// user can see the worker's last successful step, the exact point it
// stopped emitting, and any HTTP traces from the fetch interceptor.
// Only renders when sync is not healthy.
function SyncBanner(props: {
  state: string;
  reason?: string;
  log: ReadonlyArray<{ at: number; state: string; reason: string }>;
}) {
  const visible = () =>
    props.state !== 'syncing' &&
    props.state !== 'idle';
  const tone = () =>
    props.state === 'error'
      ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
      : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
  const t0 = () => props.log[0]?.at ?? Date.now();
  const dt = (at: number) => {
    const ms = at - t0();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };
  const copyLog = () => {
    const lines = props.log.map(
      (e) => `+${dt(e.at)}\t[${e.state}]\t${e.reason}`,
    );
    void navigator.clipboard?.writeText(lines.join('\n'));
  };
  return (
    <Show when={visible()}>
      <div class={`border-b ${tone()}`}>
        <div class="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wider opacity-70">
          <span>
            sync log · {props.log.length} entries · latest: {props.state}
            {props.reason ? ` · ${props.reason.slice(0, 80)}` : ' · <no reason>'}
          </span>
          <button
            type="button"
            onClick={copyLog}
            class="rounded border border-current/30 px-1.5 py-0.5 text-[10px] hover:bg-current/10"
            title="Copy full log to clipboard"
          >
            copy
          </button>
        </div>
        <ol class="max-h-40 overflow-y-auto px-3 pb-1.5 text-[11px] leading-snug font-mono">
          <For each={props.log}>
            {(entry) => (
              <li class="flex gap-2 break-words">
                <span class="shrink-0 tabular-nums opacity-60">
                  +{dt(entry.at)}
                </span>
                <span class="shrink-0 font-medium">[{entry.state}]</span>
                <span class="min-w-0 break-all">{entry.reason}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Show>
  );
}

function RoomRow(props: { room: RoomSummary; active: boolean; onSelect: () => void }) {
  const r = props.room;
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        class={`row-vis flex w-full items-start gap-3 border-b border-neutral-100 px-3 py-2.5 text-left transition-colors dark:border-neutral-900 ${
          props.active
            ? 'bg-mata-500/10 hover:bg-mata-500/15 dark:bg-mata-500/15'
            : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'
        }`}
      >
        <div class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {initials(r.name)}
          <Show when={r.isEncrypted}>
            <span class="absolute -bottom-0.5 -right-0.5 text-[10px]" title="Encrypted">
              🔒
            </span>
          </Show>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="truncate text-sm font-medium">{r.name}</span>
            <span class="shrink-0 text-[10px] text-neutral-500">{listTime(r.lastActivityTs)}</span>
          </div>
          <div class="mt-0.5 flex items-baseline gap-2">
            <p class="flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
              {r.lastEventPreview ?? <em>No messages yet</em>}
            </p>
            <Show when={r.unreadCount > 0}>
              <span
                class={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white ${
                  r.highlightCount > 0 ? 'bg-red-500' : 'bg-mata-500'
                }`}
              >
                {r.unreadCount > 99 ? '99+' : r.unreadCount}
              </span>
            </Show>
          </div>
        </div>
      </button>
    </li>
  );
}

function sortRooms(list: RoomSummary[]): RoomSummary[] {
  return [...list].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
}

/**
 * Merge a fresh RoomSummary[] from the worker with the previously rendered
 * list, preserving object identity for rooms whose fields are unchanged.
 *
 * <For> in Solid keys by reference. Returning a new object for every row
 * on every sync causes every list item to re-mount — the visible flash.
 */
function mergeRooms(prev: RoomSummary[], next: RoomSummary[]): RoomSummary[] {
  const byId = new Map(prev.map((r) => [r.roomId, r]));
  const out = next.map((nr) => {
    const old = byId.get(nr.roomId);
    return old && shallowRoomEqual(old, nr) ? old : nr;
  });
  return sortRooms(out);
}

function shallowRoomEqual(a: RoomSummary, b: RoomSummary): boolean {
  return (
    a.roomId === b.roomId &&
    a.name === b.name &&
    a.topic === b.topic &&
    a.type === b.type &&
    a.isEncrypted === b.isEncrypted &&
    a.unreadCount === b.unreadCount &&
    a.highlightCount === b.highlightCount &&
    a.lastActivityTs === b.lastActivityTs &&
    a.lastEventPreview === b.lastEventPreview
  );
}

/**
 * Permanently visible diagnostic strip surfacing the raw bridge counters.
 *
 * Phase 5 sync-hang investigation: the SyncBanner only updates when a
 * `syncStatus` handler fires. If no handler fires at all (latch empty +
 * subscription too late or worker→main channel silent), the banner stays
 * frozen with no signal as to whether the worker even sent anything. This
 * strip reads bridgeDiag (mutated by the bridge's message handler
 * regardless of any subscriber) every 500ms via the `ticks` prop, so the
 * user can SEE whether envelopes are arriving, which kinds, and whether
 * syncStatus is in the latched set.
 *
 * Once Phase 5 is closed out cleanly this strip can be removed, but it's
 * cheap and useful while we still don't have a reliable observability
 * surface for the worker pipeline.
 */
function BridgeDiagBanner(props: { ticks: number }) {
  // The `ticks` prop forces re-render every 500ms even though we read the
  // raw module state (which is plain JS, not a Solid signal).
  return (
    <div class="border-b border-neutral-200 bg-neutral-50 px-3 py-1 text-[10px] font-mono uppercase tracking-tight text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      <span data-tick={props.ticks}>
        bridge · env={bridgeDiag.envelopes} · resp={bridgeDiag.responses} · evt={bridgeDiag.events} · err={bridgeDiag.errors} · latched=[{bridgeDiag.latchKinds.join(',') || '-'}] · last={bridgeDiag.lastEvent?.kind ?? '-'}@{bridgeDiag.lastEvent ? Math.floor((Date.now() - bridgeDiag.lastEvent.at) / 1000) + 's' : '-'} · kinds={Object.entries(bridgeDiag.byKind).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}
      </span>
    </div>
  );
}
