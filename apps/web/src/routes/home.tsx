import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import type { RoomId, RoomSummary } from '@mata/shared/matrix';
import { RoomView, createRoomCache, type RoomCache } from './room-view.js';

export function HomePage() {
  const bridge = useBridge();
  const navigate = useNavigate();

  const [rooms, { refetch }] = createResource<RoomSummary[]>(async () => {
    const res = await bridge.request({ kind: 'loadRoomList' });
    return [...res.rooms].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  });

  // Refresh room list on sync deltas (in-place updates land in Phase 4).
  const unsubscribe = bridge.on('syncUpdate', () => {
    refetch();
  });
  onCleanup(unsubscribe);
  const unsubscribeStatus = bridge.on('syncStatus', (e) => {
    if (e.status === 'syncing') refetch();
  });
  onCleanup(unsubscribeStatus);

  onMount(() => {
    if (session().phase === 'anonymous') {
      navigate('/login', { replace: true });
    }
  });

  // -------- Active room + per-room cache (silky-switch) --------------------
  const [activeId, setActiveId] = createSignal<RoomId | null>(null);
  // A Solid store of caches keyed by roomId. Reactivity is fine-grained so
  // unrelated rooms never re-render when one changes.
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
    if (!caches[room.roomId]) {
      setCaches(room.roomId, createRoomCache(room.roomId));
    }
    setActiveId(room.roomId);
  };

  const activeRoom = (): RoomSummary | null => {
    const id = activeId();
    if (!id) return null;
    return (rooms() ?? []).find((r) => r.roomId === id) ?? null;
  };

  const logout = async () => {
    try {
      await bridge.request({ kind: 'logout' });
    } finally {
      setSession({ phase: 'anonymous' });
      navigate('/login', { replace: true });
    }
  };

  return (
    <div class="grid h-full w-full grid-cols-[320px_1fr]">
      <aside class="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
        <header class="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <span class="text-sm font-semibold tracking-tight">Mata</span>
          <button
            type="button"
            onClick={logout}
            class="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Sign out
          </button>
        </header>
        <Show
          when={rooms() && (rooms() as RoomSummary[]).length > 0}
          fallback={
            <div class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500">
              <Show when={!rooms.loading} fallback={<span>Loading rooms…</span>}>
                <span>No rooms yet. Sync is in progress.</span>
              </Show>
            </div>
          }
        >
          <ul class="flex-1 overflow-y-auto">
            <For each={rooms() as RoomSummary[]}>
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
      </aside>

      <Show
        when={activeRoom()}
        fallback={
          <section class="flex h-full items-center justify-center p-12 text-sm text-neutral-500">
            <div class="text-center">
              <p>Select a room to open it.</p>
              <p class="mt-2 text-xs">Click any chat on the left.</p>
            </div>
          </section>
        }
      >
        {(room) => (
          <RoomView
            // Keying on roomId forces a full RoomView remount per room. That
            // gives us a clean lifecycle for subscriptions but the per-room
            // cache (events, prevToken, pending) is held by the parent — so
            // re-opening a previously-loaded room repaints instantly.
            room={room()}
            cache={caches[room().roomId] ?? createRoomCache(room().roomId)}
            setCache={updateCache}
          />
        )}
      </Show>
    </div>
  );
}

function RoomRow(props: { room: RoomSummary; active: boolean; onSelect: () => void }) {
  const r = props.room;
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        class={`row-vis flex w-full items-start gap-3 border-b border-neutral-100 px-4 py-3 text-left transition-colors dark:border-neutral-900 ${
          props.active
            ? 'bg-mata-500/10 hover:bg-mata-500/15 dark:bg-mata-500/15'
            : 'hover:bg-neutral-100 dark:hover:bg-neutral-900'
        }`}
      >
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {r.name.slice(0, 1).toUpperCase()}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="truncate text-sm font-medium">{r.name}</span>
            <Show when={r.unreadCount > 0}>
              <span class="rounded-full bg-mata-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                {r.unreadCount}
              </span>
            </Show>
          </div>
          <p class="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
            {r.lastEventPreview ?? <em>No messages yet</em>}
          </p>
        </div>
      </button>
    </li>
  );
}
