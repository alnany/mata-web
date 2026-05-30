// ============================================================================
// MessageInfoModal — "Message info" panel for a single event.
//
// Opened from the bubble overflow menu ("Info") or by clicking the "edited"
// pill. Surfaces metadata Telegram/Element expose behind the message menu:
//   • exact wall-clock timestamp (not the relative/short time on the bubble)
//   • message type + event id (copyable, for debugging / permalink building)
//   • full "Seen by" roster — the bubble only stacks 3 avatars, here we list
//     everyone whose read receipt sits on this event, with the time they read
//   • edit history — when the message was edited, every prior version with the
//     timestamp of each revision (original → … → current)
//
// All data is fetched on mount via the worker RPCs `fetchReadReceipts`,
// `fetchEditHistory`, and `loadRoomMembers` (for display-name resolution).
// ============================================================================

import { createSignal, For, Show, onMount } from 'solid-js';
import type { EventId, RoomId, RoomMessageEvent, RoomMember, UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { prettyName, initials } from './message-bubble.js';

type EditVersion = { body: string; ts: number; sender: UserId };
type SeenBy = { userId: UserId; ts: number };

const MSGTYPE_LABEL: Record<string, string> = {
  'm.text': 'Text',
  'm.emote': 'Emote',
  'm.notice': 'Notice',
  'm.image': 'Image',
  'm.file': 'File',
  'm.audio': 'Audio',
  'm.video': 'Video',
  'm.location': 'Location',
};

function fullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MessageInfoModal(props: {
  roomId: RoomId;
  event: RoomMessageEvent;
  me: UserId | null;
  onClose: () => void;
  onOpenProfile?: (userId: UserId) => void;
}) {
  const bridge = useBridge();
  const [seenBy, setSeenBy] = createSignal<SeenBy[]>([]);
  const [history, setHistory] = createSignal<EditVersion[]>([]);
  const [members, setMembers] = createSignal<Map<UserId, RoomMember>>(new Map());
  const [loading, setLoading] = createSignal(true);

  const nameFor = (userId: UserId): string => {
    const m = members().get(userId);
    return m?.displayname?.trim() || prettyName(userId);
  };

  onMount(() => {
    void (async () => {
      try {
        const [receipts, edits, mems] = await Promise.all([
          bridge
            .request({ kind: 'fetchReadReceipts', roomId: props.roomId })
            .then((r) => (r.kind === 'fetchReadReceipts' ? r.receipts : []))
            .catch(() => []),
          bridge
            .request({ kind: 'fetchEditHistory', roomId: props.roomId, eventId: props.event.eventId })
            .then((r) => (r.kind === 'fetchEditHistory' ? r.versions : []))
            .catch(() => []),
          bridge
            .request({ kind: 'loadRoomMembers', roomId: props.roomId })
            .then((r) => r.members)
            .catch(() => [] as RoomMember[]),
        ]);

        const map = new Map<UserId, RoomMember>();
        for (const m of mems) map.set(m.userId, m);
        setMembers(map);

        // Only receipts that land on THIS event, sender excluded (you don't
        // "see" your own message), sorted by who read it most recently.
        const here = receipts
          .filter((r) => r.eventId === props.event.eventId && r.userId !== props.event.sender)
          .map((r) => ({ userId: r.userId, ts: r.ts }))
          .sort((a, b) => b.ts - a.ts);
        setSeenBy(here);
        setHistory(edits);
      } finally {
        setLoading(false);
      }
    })();
  });

  const copyEventId = () => {
    void navigator.clipboard
      .writeText(props.event.eventId)
      .then(() => showToast('success', 'Event ID copied'))
      .catch(() => showToast('error', 'Copy failed'));
  };

  const msgtype = () => props.event.content.msgtype ?? 'm.text';

  return (
    <div
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={props.onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label="Message info"
        class="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-elev shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 class="text-sm font-semibold text-fg-1">Message info</h2>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded-md px-2 py-1 text-fg-3 transition-colors hover:bg-input hover:text-fg-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-4 py-3">
          {/* Metadata */}
          <dl class="space-y-2 text-[13px]">
            <div class="flex items-baseline justify-between gap-3">
              <dt class="flex-none text-fg-3">From</dt>
              <dd class="truncate text-right text-fg-1">{nameFor(props.event.sender)}</dd>
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <dt class="flex-none text-fg-3">Sent</dt>
              <dd class="text-right text-fg-1">{fullTimestamp(props.event.originServerTs)}</dd>
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <dt class="flex-none text-fg-3">Type</dt>
              <dd class="text-right text-fg-1">{MSGTYPE_LABEL[msgtype()] ?? msgtype()}</dd>
            </div>
            <div class="flex items-baseline justify-between gap-3">
              <dt class="flex-none text-fg-3">Event ID</dt>
              <dd class="min-w-0 text-right">
                <button
                  type="button"
                  onClick={copyEventId}
                  title="Copy event ID"
                  class="max-w-full truncate rounded bg-input px-1.5 py-0.5 font-mono text-[11px] text-fg-2 transition-colors hover:text-mata-500"
                >
                  {props.event.eventId}
                </button>
              </dd>
            </div>
          </dl>

          {/* Edit history */}
          <Show when={history().length > 0}>
            <div class="mt-4">
              <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-fg-3">
                Edit history
              </h3>
              <ol class="space-y-1.5">
                <For each={history()}>
                  {(v, i) => (
                    <li class="rounded-md border border-line bg-input/60 px-2.5 py-1.5">
                      <div class="mb-0.5 flex items-center justify-between text-[10.5px] text-fg-3">
                        <span>{i() === 0 ? 'Original' : `Edit ${i()}`}</span>
                        <span>{fullTimestamp(v.ts)}</span>
                      </div>
                      <p class="whitespace-pre-wrap break-words text-[13px] text-fg-1">{v.body}</p>
                    </li>
                  )}
                </For>
              </ol>
            </div>
          </Show>

          {/* Seen by */}
          <div class="mt-4">
            <h3 class="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-fg-3">
              Seen by{' '}
              <Show when={!loading()}>
                <span class="text-fg-3">({seenBy().length})</span>
              </Show>
            </h3>
            <Show
              when={!loading()}
              fallback={<p class="text-[13px] text-fg-3">Loading…</p>}
            >
              <Show
                when={seenBy().length > 0}
                fallback={<p class="text-[13px] text-fg-3">No read receipts yet.</p>}
              >
                <ul class="space-y-1">
                  <For each={seenBy()}>
                    {(r) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => props.onOpenProfile?.(r.userId)}
                          class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-input"
                        >
                          <span class="grid h-7 w-7 flex-none place-items-center rounded-full bg-mata-500 text-[10px] font-medium text-white">
                            {initials(nameFor(r.userId))}
                          </span>
                          <span class="min-w-0 flex-1 truncate text-[13px] text-fg-1">
                            {nameFor(r.userId)}
                          </span>
                          <span class="flex-none text-[11px] text-fg-3">{clockTime(r.ts)}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
