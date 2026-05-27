import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import { showToast } from '../stores/toast.js';
import type { RoomId, RoomSummary } from '@mata/shared/matrix';
import { RoomView, createRoomCache, type RoomCache } from './room-view.js';
import { SettingsDrawer } from '../components/settings-drawer.js';
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

  // Sync state pill ('idle' | 'connecting' | 'syncing' | 'reconnecting' | 'error')
  const [syncState, setSyncState] = createSignal<string>('connecting');
  onCleanup(
    bridge.on('syncStatus', (e) => {
      setSyncState(e.status);
      if (e.status === 'error' && e.reason) {
        showToast('error', `Sync error: ${e.reason}`, 6000);
      }
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
      const sorted = sortRooms(res.rooms);
      setRooms(sorted);
      void writeRoomList(sorted);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      showToast('error', `Failed to load rooms: ${m}`);
    }
  };

  // Refresh on every sync delta. Worker holds canonical state; this is cheap.
  onCleanup(bridge.on('syncUpdate', () => refetchRooms()));

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

  const activeRoom = (): RoomSummary | null => {
    const id = activeId();
    if (!id) return null;
    return (rooms() ?? []).find((r) => r.roomId === id) ?? null;
  };

  // -------- Filtered room list ------------------------------------------
  const filteredRooms = (): RoomSummary[] => {
    const q = filter().trim().toLowerCase();
    const list = rooms() ?? [];
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
          <SyncPill state={syncState()} />
        </header>

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

        <Show
          when={(rooms() ?? []).length > 0}
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
          {(room) => (
            <RoomView
              room={room()}
              cache={caches[room().roomId] ?? createRoomCache(room().roomId)}
              setCache={updateCache}
            />
          )}
        </Show>
      </div>

      <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function meLine(): string {
  const s = session();
  if (s.phase !== 'authenticated') return '';
  return s.userId;
}

function SyncPill(props: { state: string }) {
  const map: Record<string, { color: string; label: string }> = {
    idle: { color: 'bg-neutral-400', label: 'idle' },
    connecting: { color: 'bg-amber-500 animate-pulse', label: 'connecting' },
    syncing: { color: 'bg-emerald-500', label: 'synced' },
    reconnecting: { color: 'bg-amber-500 animate-pulse', label: 'reconnecting' },
    error: { color: 'bg-red-500', label: 'error' },
  };
  const m = map[props.state] ?? map.idle;
  return (
    <span class="ml-auto inline-flex items-center gap-1 text-[10px] text-neutral-500">
      <span class={`inline-block h-1.5 w-1.5 rounded-full ${m.color}`} />
      {m.label}
    </span>
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
