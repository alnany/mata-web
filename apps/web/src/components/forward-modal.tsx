// ============================================================================
// ForwardModal — pick a target room and forward a message to it.
//
// Triggered from the message bubble's overflow menu ("Forward"). Shows a
// searchable list of joined rooms (DMs first, then named rooms, matching
// the sidebar order); current room is excluded from the picker because
// "forwarding to the same room" is the user's way of asking for a copy
// — and the copy is identical to the original, which is just noise.
//
// On confirm we fire the `forwardEvent` RPC and surface a single toast
// (success or failure). We do NOT navigate to the target room: most
// "forward to a friend" flows expect the user to stay in the current
// conversation. They can click the target in the sidebar if they want
// to verify it landed.
// ============================================================================

import { createMemo, createSignal, For, Show } from 'solid-js';
import type {
  EventId,
  RoomId,
  RoomMessageEvent,
  RoomSummary,
} from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials } from './message-bubble.js';

export function ForwardModal(props: {
  open: boolean;
  source: RoomMessageEvent | null;
  rooms: RoomSummary[];
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [query, setQuery] = createSignal('');
  const [submitting, setSubmitting] = createSignal<RoomId | null>(null);

  let inputRef: HTMLInputElement | undefined;

  const reset = () => {
    setQuery('');
    setSubmitting(null);
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  const candidates = createMemo(() => {
    const src = props.source;
    const exclude = src?.roomId;
    const q = query().trim().toLowerCase();
    return props.rooms
      .filter((r) => r.membership === 'join' && r.roomId !== exclude)
      .filter((r) => {
        if (!q) return true;
        return (
          r.name.toLowerCase().includes(q) ||
          r.roomId.toLowerCase().includes(q)
        );
      })
      .slice()
      .sort((a, b) => {
        // DMs first, then named rooms — matches sidebar partitioning.
        if (a.type === 'direct' && b.type !== 'direct') return -1;
        if (a.type !== 'direct' && b.type === 'direct') return 1;
        return a.name.localeCompare(b.name);
      });
  });

  const submit = async (targetRoomId: RoomId) => {
    const src = props.source;
    if (!src || submitting()) return;
    setSubmitting(targetRoomId);
    try {
      await bridge.request({
        kind: 'forwardEvent',
        sourceRoomId: src.roomId,
        sourceEventId: src.eventId,
        targetRoomId,
      });
      const target = props.rooms.find((r) => r.roomId === targetRoomId);
      showToast('success', `Forwarded to ${target?.name ?? 'room'}`);
      reset();
      props.onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Forward failed: ${msg}`);
      setSubmitting(null);
    }
  };

  // One-line preview of the source message body — text-class messages
  // show the text, media shows the msgtype label. Mirrors the room
  // list's `previewOf` style but kept local to avoid coupling.
  const sourcePreview = (): string => {
    const ev = props.source;
    if (!ev) return '';
    const c = ev.content;
    if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
      return c.body.slice(0, 200);
    }
    if (c.msgtype === 'm.image') return '📷 Image';
    if (c.msgtype === 'm.video') return '🎬 Video';
    if (c.msgtype === 'm.audio') return '🎙 Audio';
    if (c.msgtype === 'm.file') return '📎 File';
    if (c.msgtype === 'm.location') return '📍 Location';
    return '';
  };

  return (
    <Show when={props.open && props.source}>
      <div
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
        onClick={close}
      >
        <div
          class="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-elev shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          ref={(_el) => queueMicrotask(() => inputRef?.focus()) as unknown as undefined}
        >
          <header class="border-b border-line px-5 pb-3 pt-4">
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold">Forward message</h2>
              <button
                type="button"
                onClick={close}
                class="ml-auto rounded p-1 text-fg-3 hover:bg-input hover:text-fg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p class="mt-2 line-clamp-2 rounded-md bg-input px-2.5 py-1.5 text-[11.5px] text-fg-2">
              {sourcePreview() || '—'}
            </p>
          </header>

          <div class="border-b border-line px-3 py-2">
            <input
              ref={inputRef}
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder="Search rooms…"
              class="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-sm focus:border-mata-500 focus:bg-elev focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:focus:bg-neutral-900"
              disabled={submitting() !== null}
            />
          </div>

          <ul class="flex-1 overflow-y-auto py-1">
            <Show
              when={candidates().length > 0}
              fallback={
                <li class="px-5 py-8 text-center text-[12px] text-fg-3">
                  No rooms match.
                </li>
              }
            >
              <For each={candidates()}>
                {(r) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => void submit(r.roomId)}
                      disabled={submitting() !== null}
                      class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-input disabled:opacity-50"
                    >
                      <span
                        class="grid h-8 w-8 flex-none place-items-center rounded-full text-[11px] font-medium text-white"
                        style={{
                          'background-color':
                            r.type === 'direct'
                              ? 'var(--color-mata-500)'
                              : 'var(--color-fg-3)',
                        }}
                      >
                        {initials(r.name || r.roomId)}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-medium">{r.name || r.roomId}</span>
                        <span class="block truncate text-[11px] text-fg-3">
                          {r.type === 'direct' ? 'Direct message' : `${r.memberCount} members`}
                        </span>
                      </span>
                      <Show when={submitting() === r.roomId}>
                        <span class="text-[11px] text-fg-3">Sending…</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </Show>
          </ul>
        </div>
      </div>
    </Show>
  );
}
