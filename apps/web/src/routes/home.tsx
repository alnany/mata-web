import { createResource, For, onCleanup, onMount, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import type { RoomSummary } from '@mata/shared/matrix';

export function HomePage() {
  const bridge = useBridge();
  const navigate = useNavigate();
  const [rooms, { refetch }] = createResource<RoomSummary[]>(async () => {
    const res = await bridge.request({ kind: 'loadRoomList' });
    return [...res.rooms].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  });

  // Refresh on sync deltas. Phase 2 will apply them in-place; for now we
  // just re-list to validate the bridge end-to-end.
  const unsubscribe = bridge.on('syncUpdate', () => {
    refetch();
  });
  onCleanup(unsubscribe);

  // Refresh once when sync first becomes "syncing".
  const unsubscribeStatus = bridge.on('syncStatus', (e) => {
    if (e.status === 'syncing') refetch();
  });
  onCleanup(unsubscribeStatus);

  onMount(() => {
    if (session().phase === 'anonymous') {
      navigate('/login', { replace: true });
    }
  });

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
            <For each={rooms() as RoomSummary[]}>{(room) => <RoomRow room={room} />}</For>
          </ul>
        </Show>
      </aside>
      <section class="flex h-full items-center justify-center p-12 text-sm text-neutral-500">
        <div class="text-center">
          <p>Select a room to open it.</p>
          <p class="mt-2 text-xs">Timeline rendering lands in Phase 2.</p>
        </div>
      </section>
    </div>
  );
}

function RoomRow(props: { room: RoomSummary }) {
  const r = props.room;
  return (
    <li class="row-vis border-b border-neutral-100 px-4 py-3 hover:bg-neutral-100 dark:border-neutral-900 dark:hover:bg-neutral-900">
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
    </li>
  );
}
