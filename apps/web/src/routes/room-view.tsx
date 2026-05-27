import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { produce } from 'solid-js/store';
import { useBridge } from '../bridge/context.js';
import { session } from '../stores/session.js';
import { showToast } from '../stores/toast.js';
import type {
  EventId,
  MessageBody,
  RoomId,
  RoomMessageEvent,
  RoomSummary,
  TimelineEvent,
  UserId,
} from '@mata/shared/matrix';
import { dayLabel, isSameDay } from '../lib/date-buckets.js';
import { MessageBubble, type MessageActions } from '../components/message-bubble.js';
import { Composer } from '../components/composer.js';
import { RoomHeader } from '../components/room-header.js';

/**
 * Per-room state held by the parent so re-opening a previously-loaded
 * room paints from cache instantly (Telegram rule).
 */
export interface RoomCache {
  roomId: RoomId;
  events: TimelineEvent[];
  pending: PendingEvent[];
  /** Token to fetch the NEXT older page. null once we've reached the start. */
  prevToken: string | null;
  loaded: boolean;
  loading: boolean;
  paginating: boolean;
  reachedStart: boolean;
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
    paginating: false,
    reachedStart: false,
  };
}

const PAGE_SIZE = 50;
const SCROLL_STICK_THRESHOLD = 80;
const PAGINATE_TRIGGER = 200;

export function RoomView(props: {
  room: RoomSummary;
  cache: RoomCache;
  setCache: (roomId: RoomId, updater: (cache: RoomCache) => void) => void;
}) {
  const bridge = useBridge();
  const me = (): UserId | null => {
    const s = session();
    return s.phase === 'authenticated' ? s.userId : null;
  };

  let scrollerRef: HTMLDivElement | undefined;
  const [stickToBottom, setStickToBottom] = createSignal(true);
  const [typingUsers, setTypingUsers] = createSignal<UserId[]>([]);

  // Composer state lives here because reply/edit context is per-room view.
  const [draft, setDraft] = createSignal('');
  const [replyingTo, setReplyingTo] = createSignal<RoomMessageEvent | null>(null);
  const [editing, setEditing] = createSignal<RoomMessageEvent | null>(null);
  const [focusToken, setFocusToken] = createSignal(0);
  const bumpFocus = () => setFocusToken((v) => v + 1);

  // ---- Initial history load ----------------------------------------------
  const loadInitial = async () => {
    if (props.cache.loaded || props.cache.loading) return;
    props.setCache(props.room.roomId, (c) => {
      c.loading = true;
    });
    try {
      await bridge.request({ kind: 'subscribeRoom', roomId: props.room.roomId });
      const res = await bridge.request({
        kind: 'loadRoomHistory',
        roomId: props.room.roomId,
        fromToken: null,
        limit: PAGE_SIZE,
      });
      props.setCache(props.room.roomId, (c) => {
        c.events = res.events;
        c.prevToken = res.prevToken;
        c.reachedStart = res.prevToken === null;
        c.loaded = true;
        c.loading = false;
      });
      requestAnimationFrame(() => scrollToBottom('auto'));
    } catch (err) {
      props.setCache(props.room.roomId, (c) => {
        c.loading = false;
      });
      showToast('error', `Could not load messages: ${msgOf(err)}`);
    }
  };

  onMount(() => {
    loadInitial();
    bumpFocus();
  });

  createEffect(
    on(
      () => props.room.roomId,
      () => {
        loadInitial();
        setTypingUsers([]);
        setDraft('');
        setReplyingTo(null);
        setEditing(null);
        requestAnimationFrame(() => {
          if (stickToBottom()) scrollToBottom('auto');
          bumpFocus();
        });
      },
      { defer: true },
    ),
  );

  // ---- Live sync deltas ---------------------------------------------------
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
    // Read receipt at the bottom of the cache.
    const last = props.cache.events[props.cache.events.length - 1];
    if (last && stickToBottom() && document.hasFocus()) {
      void bridge
        .request({
          kind: 'sendReadReceipt',
          roomId: props.room.roomId,
          eventId: last.eventId,
        })
        .catch(() => {
          // ignore — best-effort
        });
    }
  });
  onCleanup(unsubSync);

  // ---- Send-confirmation handling ----------------------------------------
  const unsubSend = bridge.on('sendStatus', (e) => {
    props.setCache(
      props.room.roomId,
      produce((c: RoomCache) => {
        const idx = c.pending.findIndex((p) => p.txnId === e.txnId);
        if (idx < 0) return;
        if (e.status === 'sent') {
          c.pending.splice(idx, 1);
        } else if (e.status === 'failed') {
          c.pending[idx].status = 'failed';
          c.pending[idx].errorReason = e.error?.message ?? 'send failed';
          showToast('error', `Send failed: ${c.pending[idx].errorReason}`);
        }
      }),
    );
  });
  onCleanup(unsubSend);

  // ---- Typing indicator --------------------------------------------------
  const unsubTyping = bridge.on('typing', (e) => {
    if (e.roomId !== props.room.roomId) return;
    setTypingUsers(e.userIds.filter((u) => u !== me()));
  });
  onCleanup(unsubTyping);

  // ---- Outgoing typing ---------------------------------------------------
  let typingTimeout: number | undefined;
  const sendTyping = () => {
    if (typingTimeout) return;
    void bridge
      .request({ kind: 'sendTyping', roomId: props.room.roomId, timeoutMs: 4000 })
      .catch(() => undefined);
    typingTimeout = window.setTimeout(() => {
      typingTimeout = undefined;
    }, 3500);
  };

  // ---- Scroll tracking + pagination --------------------------------------
  const onScroll = () => {
    if (!scrollerRef) return;
    const distFromBottom =
      scrollerRef.scrollHeight - scrollerRef.scrollTop - scrollerRef.clientHeight;
    setStickToBottom(distFromBottom < SCROLL_STICK_THRESHOLD);

    // Load older page when near the top.
    if (
      scrollerRef.scrollTop < PAGINATE_TRIGGER &&
      props.cache.loaded &&
      !props.cache.paginating &&
      !props.cache.reachedStart &&
      props.cache.prevToken
    ) {
      void paginateOlder();
    }
  };

  const paginateOlder = async () => {
    if (!scrollerRef) return;
    const token = props.cache.prevToken;
    if (!token) return;
    props.setCache(props.room.roomId, (c) => {
      c.paginating = true;
    });
    const prevHeight = scrollerRef.scrollHeight;
    const prevTop = scrollerRef.scrollTop;
    try {
      const res = await bridge.request({
        kind: 'loadRoomHistory',
        roomId: props.room.roomId,
        fromToken: token,
        limit: PAGE_SIZE,
      });
      props.setCache(
        props.room.roomId,
        produce((c: RoomCache) => {
          const known = new Set(c.events.map((ev) => ev.eventId));
          const older = res.events.filter((ev) => !known.has(ev.eventId));
          // unshift is a mutating array op that Solid's store proxy
          // intercepts cleanly. The previous `c.events = [...older, ...c.events]`
          // reassignment spread the already-proxied existing events into a
          // new array, which triggered Solid 1.9's proxy-invariant check
          // ("Symbol(solid-proxy) is read-only and non-configurable") because
          // it tried to re-wrap targets that already had a cached proxy.
          if (older.length > 0) c.events.unshift(...older);
          c.prevToken = res.prevToken;
          c.reachedStart = res.prevToken === null;
          c.paginating = false;
        }),
      );
      // Preserve scroll position after older messages prepended.
      requestAnimationFrame(() => {
        if (!scrollerRef) return;
        const newHeight = scrollerRef.scrollHeight;
        scrollerRef.scrollTop = prevTop + (newHeight - prevHeight);
      });
    } catch (err) {
      // Mark this room's history as un-paginatable so onScroll stops
      // re-triggering the same failure on every wheel event (the old
      // behavior spammed 5+ identical toasts when the user opened a room).
      props.setCache(props.room.roomId, (c) => {
        c.paginating = false;
        c.reachedStart = true;
      });
      showToast('error', `Could not load older messages: ${msgOf(err)}`);
    }
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    if (!scrollerRef) return;
    scrollerRef.scrollTo({ top: scrollerRef.scrollHeight, behavior });
  };

  // ---- Composer submission -----------------------------------------------
  const submit = () => {
    const text = draft().trim();
    if (!text) return;

    if (editing()) {
      const target = editing();
      if (!target) return;
      const newContent: MessageBody = { msgtype: 'm.text', body: text, formattedBody: null };
      const txnId = mkTxn();
      void bridge
        .request({
          kind: 'editMessage',
          roomId: props.room.roomId,
          eventId: target.eventId,
          content: newContent,
          txnId,
        })
        .catch((err) => showToast('error', `Edit failed: ${msgOf(err)}`));
      setDraft('');
      setEditing(null);
      return;
    }

    const replyTarget = replyingTo();
    const body: MessageBody = { msgtype: 'm.text', body: text, formattedBody: null };
    const txnId = mkTxn();

    props.setCache(
      props.room.roomId,
      produce((c: RoomCache) => {
        c.pending.push({ txnId, body: text, status: 'sending' });
      }),
    );
    setDraft('');
    setReplyingTo(null);
    requestAnimationFrame(() => scrollToBottom('smooth'));

    // The worker enriches the wire-format with the m.relates_to → in_reply_to
    // reference when we pass it; for v1, we send the plain body. Reply
    // metadata wiring through the RPC contract is a Phase 4B improvement;
    // the reply context is preserved here as a UI hint until then.
    void bridge
      .request({ kind: 'sendMessage', roomId: props.room.roomId, content: body, txnId })
      .catch((err) => {
        props.setCache(
          props.room.roomId,
          produce((c: RoomCache) => {
            const p = c.pending.find((x) => x.txnId === txnId);
            if (p) {
              p.status = 'failed';
              p.errorReason = msgOf(err);
            }
          }),
        );
        showToast('error', `Send failed: ${msgOf(err)}`);
      });

    // Note: replyTarget currently used only for UX; full wire support tracked in 4B.
    void replyTarget;
  };

  const cancelContext = () => {
    setReplyingTo(null);
    setEditing(null);
    setDraft('');
  };

  // ---- Message action wiring ---------------------------------------------
  const actions: MessageActions = {
    onReply: (ev) => {
      setEditing(null);
      setReplyingTo(ev);
      bumpFocus();
    },
    onReact: (eventId, key) => {
      void bridge
        .request({ kind: 'sendReaction', roomId: props.room.roomId, eventId, key })
        .catch((err) => showToast('error', `Reaction failed: ${msgOf(err)}`));
    },
    onEdit: (ev) => {
      if (ev.content.msgtype !== 'm.text') return;
      setReplyingTo(null);
      setEditing(ev);
      setDraft(ev.content.body);
      bumpFocus();
    },
    onDelete: (eventId) => {
      if (!confirm('Delete this message?')) return;
      void bridge
        .request({
          kind: 'redactMessage',
          roomId: props.room.roomId,
          eventId,
          reason: null,
        })
        .catch((err) => showToast('error', `Delete failed: ${msgOf(err)}`));
    },
    onJumpTo: (eventId) => {
      const target = document.querySelector(`[data-event-id="${cssEsc(eventId)}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('ring-2', 'ring-mata-500/60', 'rounded-2xl');
        setTimeout(() => {
          target.classList.remove('ring-2', 'ring-mata-500/60', 'rounded-2xl');
        }, 1200);
      } else {
        showToast(
          'info',
          'Message not loaded yet — scroll up to load older history.',
          3000,
        );
      }
    },
  };

  // ---- Render list with day separators + grouping ------------------------
  type Row =
    | { kind: 'day'; ts: number; key: string }
    | { kind: 'msg'; ev: TimelineEvent; showHeader: boolean; key: string };

  const eventById = createMemo(() => {
    const map = new Map<EventId, TimelineEvent>();
    for (const ev of props.cache.events) map.set(ev.eventId, ev);
    return map;
  });

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const evs = props.cache.events;
    let lastSender: UserId | null = null;
    let lastTs = 0;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (i === 0 || !isSameDay(lastTs, ev.originServerTs)) {
        out.push({ kind: 'day', ts: ev.originServerTs, key: `d-${ev.eventId}` });
        lastSender = null;
      }
      const showHeader =
        ev.sender !== lastSender ||
        ev.originServerTs - lastTs > 2 * 60 * 1000; // >2 min gap re-shows header
      out.push({ kind: 'msg', ev, showHeader, key: ev.eventId });
      lastSender = ev.sender;
      lastTs = ev.originServerTs;
    }
    return out;
  });

  return (
    <section class="grid h-full min-h-0 grid-rows-[auto_1fr_auto] bg-white dark:bg-neutral-950">
      <RoomHeader room={props.room} typingUserIds={typingUsers()} />

      {/* Timeline */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        class="min-h-0 overflow-y-auto px-4 py-4"
        data-mata-timeline
      >
        <Show when={props.cache.loaded} fallback={<LoadingStub />}>
          <Show when={props.cache.paginating}>
            <div class="mb-2 text-center text-[11px] text-neutral-500">Loading older…</div>
          </Show>
          <Show
            when={rows().length > 0 || props.cache.pending.length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-xs text-neutral-500">
                No messages yet — say hi.
              </div>
            }
          >
            <ul class="flex flex-col">
              <For each={rows()}>
                {(row) =>
                  row.kind === 'day' ? (
                    <DayDivider ts={row.ts} />
                  ) : (
                    <MessageBubble
                      ev={row.ev}
                      me={me()}
                      showHeader={row.showHeader}
                      inReplyToEvent={
                        row.ev.type === 'm.room.message' && row.ev.inReplyTo
                          ? eventById().get(row.ev.inReplyTo)
                          : undefined
                      }
                      actions={actions}
                    />
                  )
                }
              </For>
              <For each={props.cache.pending}>{(p) => <PendingRow pending={p} />}</For>
            </ul>
          </Show>
        </Show>
      </div>

      <Composer
        draft={draft}
        setDraft={setDraft}
        replyingTo={replyingTo()}
        editing={editing()}
        onCancelContext={cancelContext}
        onSubmit={submit}
        onTyping={sendTyping}
        focusToken={focusToken}
      />
    </section>
  );
}

// ---- Sub-components --------------------------------------------------------

function DayDivider(props: { ts: number }) {
  return (
    <li class="my-3 flex justify-center">
      <span class="rounded-full bg-neutral-100 px-3 py-0.5 text-[11px] font-medium text-neutral-500 dark:bg-neutral-900">
        {dayLabel(props.ts)}
      </span>
    </li>
  );
}

function LoadingStub() {
  return (
    <div class="flex h-full items-center justify-center text-xs text-neutral-500">
      Loading messages…
    </div>
  );
}

function PendingRow(props: { pending: PendingEvent }) {
  return (
    <li class="msg-enter mt-0.5 flex justify-end">
      <div
        class={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-5 text-white ${
          props.pending.status === 'failed' ? 'bg-red-500' : 'bg-mata-500/70'
        }`}
      >
        <span class="whitespace-pre-wrap break-words">{props.pending.body}</span>
        <div class="mt-1 text-right text-[10px] opacity-80">
          {props.pending.status === 'failed'
            ? `failed: ${props.pending.errorReason}`
            : 'sending…'}
        </div>
      </div>
    </li>
  );
}

function mkTxn(): string {
  return `m${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cssEsc(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  return s.replace(/(["\\])/g, '\\$1');
}
