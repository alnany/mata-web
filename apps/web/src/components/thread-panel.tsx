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

  // Root preview banner: surface the originating message at the top
  // so users always know what they're replying to. Element does this;
  // Telegram channels show "Reply to: [message]" the same way. Pulled
  // from the loaded events list (oldest = root by definition).
  const rootEvent = () => {
    const all = events();
    return all.find((e) => e.eventId === props.threadRootId) ?? null;
  };
  const replyCount = () =>
    events().filter((e) => e.eventId !== props.threadRootId && e.type === 'm.room.message').length;

  return (
    <aside
      class="absolute inset-y-0 right-0 z-20 flex w-[400px] max-w-full flex-col border-l bg-elev shadow-2xl"
      style={{ 'border-color': 'var(--color-line)' }}
      aria-label="Thread"
    >
      {/*
       * Header: title row + pinned root preview. The pinned card
       * keeps the thread's root visible no matter how far the user
       * scrolls — critical for long threads where the entry context
       * would otherwise scroll out of sight.
       */}
      <header
        class="border-b"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <div class="flex items-center justify-between px-4 py-2.5">
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-semibold">Thread</span>
            <Show when={!loading() && replyCount() > 0}>
              <span class="text-xs text-fg-3">
                {replyCount()} {replyCount() === 1 ? 'reply' : 'replies'}
              </span>
            </Show>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            class="-mr-1 flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-input hover:text-fg"
            aria-label="Close thread"
            title="Close (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <Show when={rootEvent()}>
          {(re) => {
            const ev = re();
            if (ev.type !== 'm.room.message') return null;
            const m = ev;
            return (
              <div class="border-t px-4 py-2" style={{ 'border-color': 'var(--color-line)' }}>
                <div class="flex items-start gap-2">
                  <div class="h-6 w-6 shrink-0 rounded-full bg-input text-center text-[10px] font-semibold leading-6 text-fg-2">
                    {initials(prettyName(m.sender))}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2">
                      <span class="truncate text-xs font-semibold">{prettyName(m.sender)}</span>
                      <span class="text-[10px] text-fg-3">{formatTs(m.originServerTs)}</span>
                    </div>
                    <div class="line-clamp-2 whitespace-pre-wrap break-words text-xs text-fg-2">
                      {pickBody(m)}
                    </div>
                  </div>
                </div>
              </div>
            );
          }}
        </Show>
      </header>

      <div ref={scrollEl} class="flex-1 overflow-y-auto px-3 py-2">
        <Show
          when={!loading()}
          fallback={
            <div class="flex h-full items-center justify-center text-xs text-fg-3">
              Loading thread…
            </div>
          }
        >
          <Show
            when={replyCount() > 0}
            fallback={
              <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div class="text-2xl">💬</div>
                <div class="text-xs text-fg-3">No replies yet</div>
                <div class="text-[11px] text-fg-3">Start the thread below.</div>
              </div>
            }
          >
            <ol class="space-y-2">
              <For each={events().filter((e) => e.eventId !== props.threadRootId)}>
                {(ev) => <ThreadEventRow ev={ev} />}
              </For>
            </ol>
          </Show>
        </Show>
      </div>

      <form
        class="border-t p-2.5"
        style={{ 'border-color': 'var(--color-line)' }}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div
          class="flex items-end gap-2 rounded-2xl border bg-base px-2.5 py-1.5 transition-colors focus-within:border-mata-500"
          style={{ 'border-color': 'var(--color-line)' }}
        >
          <textarea
            class="min-h-[28px] max-h-32 flex-1 resize-none bg-transparent text-sm placeholder:text-fg-3 focus:outline-none"
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
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-mata-500 text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-input disabled:text-fg-3"
            aria-label="Send reply"
            title="Send (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 8l11-5-3 12-3-5-5-2z" />
            </svg>
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
    return <li class="text-[11px] italic text-fg-3">{describeNonMessage(ev)}</li>;
  }
  const m = ev;
  const sender = m.sender;
  const body = pickBody(m);
  return (
    <li class="flex items-start gap-2">
      <div class="h-7 w-7 shrink-0 rounded-full bg-input text-center text-[11px] font-semibold leading-7 text-fg-2">
        {initials(prettyName(sender))}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="truncate text-xs font-semibold">{prettyName(sender)}</span>
          <span class="text-[10px] text-fg-3">{formatTs(m.originServerTs)}</span>
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
