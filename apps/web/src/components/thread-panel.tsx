/**
 * Thread side-panel (Phase 13).
 *
 * Renders the events of a Matrix thread (m.thread relation per
 * MSC3440 / spec v1.4) plus its own composer scoped to the thread
 * root. Lives as an absolute-positioned right-side overlay inside
 * room-view so the main timeline stays mounted (no double-load when
 * the user closes the panel).
 *
 * Data model:
 *   - On open, we call the `loadThread` RPC once and seed
 *     `threadEvents` with the result (oldest-first; root included).
 *   - Live updates: room-view emits new RoomMessageEvents into this
 *     panel via the `liveEvents` prop. We append-if-thread-matches.
 *     This keeps the RPC as a cold-start fetch only and rides the
 *     existing sync delta path for incremental updates.
 *   - Send: the panel owns a small composer that calls
 *     `sendMessage` with `threadRoot` set. The optimistic-echo of
 *     the main timeline is unaffected — those events show in both
 *     the main timeline (as a thread reply) and the panel.
 *
 * Why a separate composer:
 *   The room composer carries edit/reply context for the main
 *   timeline. Threading is orthogonal — a user might be reading the
 *   main timeline at the bottom with a Cmd-K-style focus while the
 *   thread sits open in the corner. Giving threads their own
 *   composer means the two states don't interfere.
 */
import { createSignal, createEffect, For, Show, onCleanup, untrack } from 'solid-js';
import type { EventId, RoomId, TimelineEvent, RoomMessageEvent } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { initials, prettyName } from './message-bubble.js';

type Props = {
  roomId: RoomId;
  threadRootId: EventId;
  /** Live events from the parent room view — we filter for the thread. */
  liveEvents: () => TimelineEvent[];
  onClose: () => void;
  /** User's own MXID for the optimistic-send sender label. */
  myUserId: string | null;
};

export function ThreadPanel(props: Props) {
  const bridge = useBridge();
  const [events, setEvents] = createSignal<TimelineEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [draft, setDraft] = createSignal('');
  const [sending, setSending] = createSignal(false);
  let scrollEl: HTMLDivElement | undefined;

  // Cold-start fetch. Triggered on mount AND on threadRootId change
  // (in case the user closes one thread and opens another quickly).
  createEffect(() => {
    const rootId = props.threadRootId;
    const roomId = props.roomId;
    setLoading(true);
    setEvents([]);
    bridge
      .request({ kind: 'loadThread', roomId, threadRootId: rootId })
      .then((res) => {
        if (res.kind !== 'loadThread') return;
        setEvents(res.events);
      })
      .catch(() => {
        // Empty thread / network error / room not in store. We still
        // show the composer so the user can post; the relations
        // endpoint will accept a fresh m.thread reply even if the
        // root isn't fully indexed yet.
      })
      .finally(() => {
        setLoading(false);
        // Defer scroll-to-bottom past Solid's commit so the DOM has
        // actually grown.
        queueMicrotask(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
      });
  });

  // Live append: pick anything from the parent's event list whose
  // `threadRoot` matches our root and isn't already in `events`.
  // Using untrack() inside the merge prevents this effect from
  // re-firing on its own setEvents.
  createEffect(() => {
    const incoming = props.liveEvents();
    const rootId = props.threadRootId;
    untrack(() => {
      const have = new Set(events().map((e) => e.eventId));
      const additions: TimelineEvent[] = [];
      for (const e of incoming) {
        if (e.eventId === rootId && !have.has(rootId)) {
          additions.push(e);
          continue;
        }
        if (e.type === 'm.room.message' && e.threadRoot === rootId && !have.has(e.eventId)) {
          additions.push(e);
        }
      }
      if (additions.length === 0) return;
      const merged = [...events(), ...additions].sort((a, b) => a.originServerTs - b.originServerTs);
      setEvents(merged);
      queueMicrotask(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    });
  });

  // Esc closes the panel. Capture on document so it works regardless
  // of focus (the composer textarea swallows non-Esc keys, but Esc is
  // the universal close gesture).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));

  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setSending(true);
    const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      await bridge.request({
        kind: 'sendMessage',
        roomId: props.roomId,
        txnId,
        threadRoot: props.threadRootId,
        content: {
          msgtype: 'm.text',
          body: text,
          formattedBody: null,
        },
      });
      setDraft('');
    } catch {
      // The bridge already surfaces a sendStatus event for failures
      // — we don't double-report here.
    } finally {
      setSending(false);
    }
  };

  return (
    <aside
      class="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-full flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
      aria-label="Thread"
    >
      <header class="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span class="text-sm font-semibold">Thread</span>
        <button
          type="button"
          onClick={props.onClose}
          class="rounded p-1 text-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Close thread"
        >
          ×
        </button>
      </header>

      <div ref={scrollEl} class="flex-1 overflow-y-auto px-3 py-2">
        <Show when={!loading()} fallback={<div class="py-8 text-center text-xs text-neutral-500">Loading thread…</div>}>
          <Show when={events().length > 0} fallback={<div class="py-8 text-center text-xs text-neutral-500">No replies yet — start the thread below.</div>}>
            <ol class="space-y-2">
              <For each={events()}>{(ev) => <ThreadEventRow ev={ev} />}</For>
            </ol>
          </Show>
        </Show>
      </div>

      <form
        class="border-t border-neutral-200 p-2 dark:border-neutral-800"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div class="flex items-end gap-2">
          <textarea
            class="min-h-[36px] max-h-32 flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-mata-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="Reply in thread…"
            value={draft()}
            disabled={sending()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="submit"
            disabled={sending() || draft().trim().length === 0}
            class="rounded-lg bg-mata-500 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * Minimal event row tuned for the narrow thread panel. We don't
 * reuse `MessageBubble` here because the panel is intentionally
 * compact — no avatars beyond initials, no hover actions, no
 * reactions. Power users will read the main timeline for that; the
 * panel is the focused-conversation surface.
 */
function ThreadEventRow(props: { ev: TimelineEvent }) {
  const ev = props.ev;
  if (ev.type !== 'm.room.message') {
    return <li class="text-[11px] italic text-neutral-500">{describeNonMessage(ev)}</li>;
  }
  const m = ev;
  const sender = m.sender;
  const body = pickBody(m);
  return (
    <li class="flex items-start gap-2">
      <div class="h-7 w-7 shrink-0 rounded-full bg-neutral-300 text-center text-[11px] font-semibold leading-7 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
        {initials(prettyName(sender))}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-xs font-semibold">{prettyName(sender)}</span>
          <span class="text-[10px] text-neutral-500">{formatTs(m.originServerTs)}</span>
        </div>
        <div class="whitespace-pre-wrap break-words text-sm">{body}</div>
      </div>
    </li>
  );
}

function pickBody(m: RoomMessageEvent): string {
  const c = m.content;
  switch (c.msgtype) {
    case 'm.text':
    case 'm.notice':
    case 'm.emote':
      return c.body;
    case 'm.image':
      return '🖼 ' + (c.body || 'image');
    case 'm.file':
      return '📎 ' + (c.body || 'file');
    case 'm.video':
      return '🎬 ' + (c.body || 'video');
    case 'm.audio':
      return '🎤 ' + (c.body || 'audio');
    case 'm.location':
      return '📍 ' + c.body;
    default:
      return '(unsupported message)';
  }
}

function describeNonMessage(ev: Exclude<TimelineEvent, RoomMessageEvent>): string {
  switch (ev.type) {
    case 'm.room.member':
      return `${ev.target} ${ev.membership}`;
    case 'm.room.redaction':
      return 'A message was deleted';
    case 'm.room.encrypted':
      return '(encrypted — undecryptable in this view)';
    default:
      return '';
  }
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
