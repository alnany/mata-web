import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { EventId, TimelineEvent } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';

/**
 * Telegram-style tap-to-jump pinned bar. Sits between the room header and
 * the timeline. Shows the most-recent pin by default; tapping the body
 * jumps the timeline to the active pin and cycles to the next-older one
 * (wrapping), so repeated taps walk the full pin set. The right-side count
 * chip appears only when more than one message is pinned. Unpin (×) is
 * shown on hover and acts on the currently-displayed pin.
 *
 * Pinned events frequently live outside the loaded timeline window, so we
 * resolve each id lazily: cache lookup first, then a worker `fetchEvent`
 * (which falls back to a homeserver /event fetch + decrypt). Resolved
 * events are memoized for the bar's lifetime.
 */
export function PinnedBar(props: {
  /** Pinned event ids, oldest-first (spec order). */
  pinnedIds: EventId[];
  /** Live/cached events for fast in-window resolution. */
  liveEvents: () => TimelineEvent[];
  onJump: (eventId: EventId) => void;
  onUnpin: (eventId: EventId) => void;
}) {
  const bridge = useBridge();
  // Newest pin first for display (spec orders oldest-first).
  const ordered = createMemo(() => [...props.pinnedIds].reverse());
  const [activeIdx, setActiveIdx] = createSignal(0);
  const [resolved, setResolved] = createSignal<Map<EventId, TimelineEvent | null>>(new Map());

  // Clamp the active index whenever the pin set shrinks/changes.
  createEffect(() => {
    const n = ordered().length;
    if (n === 0) return;
    if (activeIdx() >= n) setActiveIdx(0);
  });

  const activeId = (): EventId | null => ordered()[activeIdx()] ?? null;

  // Resolve the active pin's content: cache hit is free; otherwise a
  // one-shot worker fetch (homeserver /event + decrypt), memoized so a
  // given pin is only fetched once per bar lifetime.
  createEffect(() => {
    const id = activeId();
    if (!id || resolved().has(id)) return;
    if (props.liveEvents().some((e) => e.eventId === id)) return; // served from cache in activeEvent()
    const roomId = props.liveEvents()[0]?.roomId;
    if (!roomId) return;
    void (async () => {
      try {
        const res = await bridge.request({ kind: 'fetchEvent', roomId, eventId: id });
        setResolved((m) => new Map(m).set(id, res.kind === 'fetchEvent' ? res.event : null));
      } catch {
        setResolved((m) => new Map(m).set(id, null));
      }
    })();
  });

  const activeEvent = (): TimelineEvent | null => {
    const id = activeId();
    if (!id) return null;
    return props.liveEvents().find((e) => e.eventId === id) ?? resolved().get(id) ?? null;
  };

  const preview = (): string => {
    const ev = activeEvent();
    if (!ev) return 'Pinned message';
    if (ev.type === 'm.room.redaction') return '(message deleted)';
    if (ev.type === 'm.room.encrypted') return '(encrypted message)';
    if (ev.type === 'm.room.member') return 'Membership update';
    if (ev.type === 'm.room.message') {
      const c = ev.content;
      if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
        return c.body.replace(/\n+/g, ' ').slice(0, 160) || 'Pinned message';
      }
      if (c.msgtype === 'm.image') return '📷 Photo';
      if (c.msgtype === 'm.video') return '🎬 Video';
      if (c.msgtype === 'm.audio') return '🎙 Voice message';
      if (c.msgtype === 'm.file') return '📎 File';
      if (c.msgtype === 'm.location') return '📍 Location';
    }
    return 'Pinned message';
  };

  const tap = () => {
    const id = activeId();
    if (!id) return;
    props.onJump(id);
    const n = ordered().length;
    if (n > 1) setActiveIdx((i) => (i + 1) % n);
  };

  return (
    <Show when={ordered().length > 0}>
      <div
        class="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-3"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        {/* Tap target: accent bar + label + preview. */}
        <button
          type="button"
          onClick={tap}
          class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pl-1 pr-2 text-left hover:bg-input"
          title={ordered().length > 1 ? 'Jump to pinned message (tap to cycle)' : 'Jump to pinned message'}
        >
          {/* Vertical pin-stack accent: one segment per pin (capped), the
              active one bright, others dimmed — mirrors Telegram. */}
          <div class="flex h-8 w-[3px] flex-none flex-col gap-[2px] overflow-hidden rounded-full">
            <For each={segments()}>
              {(seg) => (
                <div
                  class="w-full flex-1 rounded-full"
                  style={{
                    background: seg ? 'var(--accent)' : 'var(--accent-dim)',
                  }}
                />
              )}
            </For>
          </div>
          <div class="min-w-0 flex-1">
            <div
              class="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--accent)' }}
            >
              Pinned message
              <Show when={ordered().length > 1}>
                <span style={{ color: 'var(--color-fg-4)' }}>
                  {activeIdx() + 1}/{ordered().length}
                </span>
              </Show>
            </div>
            <div class="truncate text-[13px] text-fg-2">{preview()}</div>
          </div>
        </button>
        {/* Unpin the currently-displayed pin. */}
        <button
          type="button"
          onClick={() => {
            const id = activeId();
            if (id) props.onUnpin(id);
          }}
          class="grid h-8 w-8 flex-none place-items-center rounded-md text-fg-3 hover:bg-input hover:text-fg"
          aria-label="Unpin message"
          title="Unpin"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
        </button>
      </div>
    </Show>
  );

  // Up to 5 segments representing the pin stack; the active index lights up.
  function segments(): boolean[] {
    const n = Math.min(ordered().length, 5);
    const active = Math.min(activeIdx(), n - 1);
    return Array.from({ length: n }, (_, i) => i === active);
  }
}
