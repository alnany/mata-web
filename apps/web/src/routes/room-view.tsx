import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { useBridge } from '../bridge/context.js';
import { session } from '../stores/session.js';
import type {
  EventId,
  MessageBody,
  RoomId,
  RoomSummary,
  TimelineEvent,
} from '@mata/shared/matrix';

/**
 * RoomView — right pane for the active room.
 *
 * Design notes (Telegram-silk targets):
 * - The parent (`HomePage`) hands us a per-room cached state object. Switching
 *   rooms therefore shows whatever was already paged in instantly — no flicker,
 *   no spinner — and the freshest page is requested in the background.
 * - Optimistic sends are appended to the same timeline immediately with a local
 *   `pending` flag. `sendStatus` events replace them in-place once the homeserver
 *   confirms (matched by txnId → eventId), so the bubble never jumps.
 * - Auto-scroll only sticks if the user is already near the bottom. If they
 *   scrolled up to read older messages we DO NOT yank them to the bottom on
 *   each new event — same rule Telegram Web uses.
 */
export interface RoomCache {
  roomId: RoomId;
  events: TimelineEvent[];
  pending: PendingEvent[];
  prevToken: string | null;
  loaded: boolean;
  loading: boolean;
}

interface PendingEvent {
  txnId: string;
  body: string;
  status: 'sending' | 'failed';
  errorReason?: string;
}

export function createRoomCache(roomId: RoomId): RoomCache {
  return {
    roomId,
    events: [],
    pending: [],
    prevToken: null,
    loaded: false,
    loading: false,
  };
}

export function RoomView(props: {
  room: RoomSummary;
  cache: RoomCache;
  setCache: (
    roomId: RoomId,
    updater: (cache: RoomCache) => void,
  ) => void;
}) {
  const bridge = useBridge();
  const me = () => {
    const s = session();
    return s.phase === 'authenticated' ? s.userId : null;
  };

  let scrollerRef: HTMLDivElement | undefined;
  let composerRef: HTMLTextAreaElement | undefined;
  const [stickToBottom, setStickToBottom] = createSignal(true);

  // ---- Initial history load (idempotent — guarded by cache.loaded). -------
  const loadInitial = async () => {
    if (props.cache.loaded || props.cache.loading) return;
    props.setCache(props.room.roomId, (c) => {
      c.loading = true;
    });
    try {
      // Subscribe so the worker keeps a hot reference + decrypts new events
      // promptly. Subscribe is idempotent in the worker.
      await bridge.request({ kind: 'subscribeRoom', roomId: props.room.roomId });
      const res = await bridge.request({
        kind: 'loadRoomHistory',
        roomId: props.room.roomId,
        fromToken: null,
        limit: 50,
      });
      props.setCache(props.room.roomId, (c) => {
        c.events = res.events;
        c.prevToken = res.prevToken;
        c.loaded = true;
        c.loading = false;
      });
      requestAnimationFrame(() => scrollToBottom('auto'));
    } catch (err) {
      props.setCache(props.room.roomId, (c) => {
        c.loading = false;
      });
      console.error('[room] history load failed', err);
    }
  };

  onMount(() => {
    loadInitial();
    composerRef?.focus();
  });

  // If the parent swaps `props.room` to a different room while this component
  // stays mounted, re-trigger load + focus.
  createEffect(
    on(
      () => props.room.roomId,
      () => {
        loadInitial();
        requestAnimationFrame(() => {
          if (stickToBottom()) scrollToBottom('auto');
          composerRef?.focus();
        });
      },
      { defer: true },
    ),
  );

  // ---- Live updates from sync ---------------------------------------------
  const unsubSync = bridge.on('syncUpdate', (e) => {
    const delta = e.deltas.find((d) => d.roomId === props.room.roomId);
    if (!delta || delta.newEvents.length === 0) return;
    props.setCache(
      props.room.roomId,
      produce((c: RoomCache) => {
        const known = new Set(c.events.map((ev) => ev.eventId));
        for (const ev of delta.newEvents) {
          if (!known.has(ev.eventId)) c.events.push(ev);
        }
      }),
    );
    if (stickToBottom()) {
      requestAnimationFrame(() => scrollToBottom('smooth'));
    }
    // Read receipt for whatever is now at the bottom, but only if we're
    // actually looking at it.
    const last = props.cache.events[props.cache.events.length - 1];
    if (last && stickToBottom() && document.hasFocus()) {
      void bridge.request({
        kind: 'sendReadReceipt',
        roomId: props.room.roomId,
        eventId: last.eventId,
      });
    }
  });
  onCleanup(unsubSync);

  // ---- Send-confirmation handling -----------------------------------------
  const unsubSend = bridge.on('sendStatus', (e) => {
    props.setCache(
      props.room.roomId,
      produce((c: RoomCache) => {
        const idx = c.pending.findIndex((p) => p.txnId === e.txnId);
        if (idx < 0) return;
        if (e.status === 'sent') {
          // Drop the optimistic bubble — the real event will arrive via
          // syncUpdate. If it already did (race), the de-dup in syncUpdate
          // already kept it.
          c.pending.splice(idx, 1);
        } else if (e.status === 'failed') {
          const p = c.pending[idx];
          p.status = 'failed';
          p.errorReason = e.error?.message ?? 'send failed';
        }
      }),
    );
  });
  onCleanup(unsubSend);

  // ---- Composer -----------------------------------------------------------
  const [draft, setDraft] = createSignal('');
  let typingTimeout: number | undefined;

  const sendTyping = () => {
    if (typingTimeout) return;
    void bridge.request({
      kind: 'sendTyping',
      roomId: props.room.roomId,
      timeoutMs: 4000,
    });
    typingTimeout = window.setTimeout(() => {
      typingTimeout = undefined;
    }, 3500);
  };

  const submit = () => {
    const text = draft().trim();
    if (!text) return;
    const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const body: MessageBody = { msgtype: 'm.text', body: text, formattedBody: null };

    props.setCache(
      props.room.roomId,
      produce((c: RoomCache) => {
        c.pending.push({ txnId, body: text, status: 'sending' });
      }),
    );
    setDraft('');
    composerRef && (composerRef.style.height = 'auto');
    requestAnimationFrame(() => scrollToBottom('smooth'));

    void bridge
      .request({ kind: 'sendMessage', roomId: props.room.roomId, content: body, txnId })
      .catch((err) => {
        // Bridge-level failure (not just a homeserver reject). Mark failed.
        props.setCache(
          props.room.roomId,
          produce((c: RoomCache) => {
            const p = c.pending.find((x) => x.txnId === txnId);
            if (p) {
              p.status = 'failed';
              p.errorReason = err instanceof Error ? err.message : String(err);
            }
          }),
        );
      });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const autosize = () => {
    if (!composerRef) return;
    composerRef.style.height = 'auto';
    composerRef.style.height = `${Math.min(composerRef.scrollHeight, 180)}px`;
  };

  // ---- Scroll tracking ----------------------------------------------------
  const onScroll = () => {
    if (!scrollerRef) return;
    const distFromBottom =
      scrollerRef.scrollHeight - scrollerRef.scrollTop - scrollerRef.clientHeight;
    setStickToBottom(distFromBottom < 80);
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    if (!scrollerRef) return;
    scrollerRef.scrollTo({ top: scrollerRef.scrollHeight, behavior });
  };

  // ---- Render -------------------------------------------------------------
  // Combine confirmed timeline events + optimistic pending bubbles for the
  // render list. They're already in chronological order because we append.
  const renderList = () => {
    untrack(() => {}); // keep Solid happy when called inside JSX
    return [...props.cache.events, ...props.cache.pending] as Array<
      TimelineEvent | (PendingEvent & { __pending: true })
    >;
  };

  return (
    <section class="grid h-full grid-rows-[auto_1fr_auto] bg-white dark:bg-neutral-950">
      {/* Header */}
      <header class="flex items-center gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
        <div class="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          {props.room.name.slice(0, 1).toUpperCase()}
        </div>
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold">{props.room.name}</div>
          <div class="truncate text-[11px] text-neutral-500 dark:text-neutral-500">
            {props.room.roomId}
          </div>
        </div>
      </header>

      {/* Timeline */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        class="overflow-y-auto px-4 py-4"
        data-mata-timeline
      >
        <Show
          when={props.cache.loaded}
          fallback={
            <div class="flex h-full items-center justify-center text-xs text-neutral-500">
              Loading messages…
            </div>
          }
        >
          <Show
            when={props.cache.events.length > 0 || props.cache.pending.length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-xs text-neutral-500">
                No messages yet — say hi.
              </div>
            }
          >
            <ul class="flex flex-col gap-1">
              <For each={props.cache.events}>
                {(ev) => <TimelineRow ev={ev} me={me()} />}
              </For>
              <For each={props.cache.pending}>
                {(p) => <PendingRow pending={p} me={me()} />}
              </For>
            </ul>
          </Show>
        </Show>
      </div>

      {/* Composer */}
      <div class="border-t border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div class="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={draft()}
            placeholder="Message"
            rows={1}
            class="flex-1 resize-none rounded-2xl border border-neutral-300 bg-white px-4 py-2 text-sm leading-5 outline-none focus:border-mata-500 focus:ring-2 focus:ring-mata-500/30 dark:border-neutral-700 dark:bg-neutral-950"
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              autosize();
              if (e.currentTarget.value) sendTyping();
            }}
            onKeyDown={onKey}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft().trim()}
            class="h-9 shrink-0 rounded-full bg-mata-500 px-4 text-sm font-semibold text-white shadow-sm transition-opacity hover:bg-mata-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- Sub-components --------------------------------------------------------

function TimelineRow(props: { ev: TimelineEvent; me: string | null }) {
  const isMine = () => props.ev.sender === props.me;

  return (
    <li class={`flex ${isMine() ? 'justify-end' : 'justify-start'}`}>
      <div
        class={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-5 ${
          isMine()
            ? 'bg-mata-500 text-white'
            : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
        }`}
      >
        <Show when={!isMine()}>
          <div class="mb-0.5 text-[11px] font-medium opacity-70">{props.ev.sender}</div>
        </Show>
        <EventBody ev={props.ev} />
        <div class="mt-1 text-right text-[10px] opacity-60">
          {formatTime(props.ev.originServerTs)}
        </div>
      </div>
    </li>
  );
}

function EventBody(props: { ev: TimelineEvent }) {
  const ev = props.ev;
  if (ev.type === 'm.room.message') {
    const c = ev.content;
    if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
      return <span class="whitespace-pre-wrap break-words">{c.body}</span>;
    }
    return (
      <span class="italic opacity-80">
        [{c.msgtype}] {c.body}
      </span>
    );
  }
  if (ev.type === 'm.room.encrypted') {
    return <span class="italic opacity-70">🔒 Encrypted (E2EE not enabled in this build)</span>;
  }
  if (ev.type === 'm.room.member') {
    return <span class="italic opacity-70">membership change</span>;
  }
  if (ev.type === 'm.room.redaction') {
    return <span class="italic opacity-70">message removed</span>;
  }
  return <span class="italic opacity-70">unknown event</span>;
}

function PendingRow(props: { pending: PendingEvent; me: string | null }) {
  return (
    <li class="flex justify-end">
      <div
        class={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-5 ${
          props.pending.status === 'failed' ? 'bg-red-500 text-white' : 'bg-mata-500/70 text-white'
        }`}
      >
        <span class="whitespace-pre-wrap break-words">{props.pending.body}</span>
        <div class="mt-1 text-right text-[10px] opacity-80">
          {props.pending.status === 'failed' ? `failed: ${props.pending.errorReason}` : 'sending…'}
        </div>
      </div>
    </li>
  );
}

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Re-export for HomePage convenience.
export { createStore };
