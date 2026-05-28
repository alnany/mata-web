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
import { useBridge } from '../bridge/context.js';
import { session } from '../stores/session.js';
import { dismissToast, showToast } from '../stores/toast.js';
import type {
  EventId,
  MessageBody,
  RoomId,
  RoomMessageEvent,
  RoomSummary,
  TimelineEvent,
  UserId,
  RoomMember,
} from '@mata/shared/matrix';
import { dayLabel, isSameDay, shortTime } from '../lib/date-buckets.js';
import { MessageBubble, type MessageActions } from '../components/message-bubble.js';
import { ThreadPanel } from '../components/thread-panel.js';
import { Composer } from '../components/composer.js';
import { RoomHeader } from '../components/room-header.js';
import { MembersPanel } from '../components/members-panel.js';

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
  /**
   * Set once the server has confirmed the send (sendStatus 'sent'
   * fires) and we know which event id will arrive from /sync. The
   * pending bubble keeps rendering until the sync delivery for this
   * id arrives — at which point the pending entry is spliced and the
   * real `m.room.message` is appended to `events` in the SAME
   * setCache transaction. That single-frame swap is the difference
   * between "silky like Telegram" and the flash-and-jump symptom.
   */
  expectedEventId?: EventId;
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
  // Thread side-panel (Phase 13). null = panel closed. When set,
  // ThreadPanel mounts with this event id as the thread root; the
  // panel calls `loadThread` once and rides `props.cache.events` for
  // live append. Switching rooms closes any open thread (see the
  // room-change createEffect below).
  const [openThread, setOpenThread] = createSignal<EventId | null>(null);
  const [focusToken, setFocusToken] = createSignal(0);
  const [membersOpen, setMembersOpen] = createSignal(false);

  // Pending intentional mentions for the next send. Composer pushes
  // here when the user picks from the @autocomplete dropdown; we drain
  // it on submit and only keep entries whose @handle still survives in
  // the final text (see submit()). Reset on room change.
  let pendingMentions: UserId[] = [];
  const addMention = (u: UserId) => {
    if (!pendingMentions.includes(u)) pendingMentions.push(u);
  };
  const drainMentions = (): UserId[] => {
    const out = pendingMentions;
    pendingMentions = [];
    return out;
  };

  // Lazy-load room members for the @autocomplete. Cached per
  // room-view instance; the parent remounts us on room switch so the
  // cache lifetime is naturally bounded.
  let membersPromise: Promise<RoomMember[]> | null = null;
  const loadMembersForComposer = (): Promise<RoomMember[]> => {
    if (!membersPromise) {
      membersPromise = bridge
        .request({ kind: 'loadRoomMembers', roomId: props.room.roomId })
        .then((r) => r.members)
        .catch(() => []);
    }
    return membersPromise;
  };
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

  /**
   * Mark the latest event as read whenever the user has the room in
   * view. Called from the initial-load completion, on room switch, on
   * window focus, and on every new sync delta — covering all the
   * paths the previous code didn't (no live sync after opening a room
   * with existing unread messages → badge stayed at "1 new" forever).
   */
  const markLatestRead = () => {
    if (!document.hasFocus()) return;
    const evs = props.cache.events;
    const last = evs[evs.length - 1];
    if (!last) return;
    void bridge
      .request({
        kind: 'sendReadReceipt',
        roomId: props.room.roomId,
        eventId: last.eventId,
      })
      .catch(() => {
        // best-effort
      });
  };

  onMount(() => {
    loadInitial().then(markLatestRead);
    bumpFocus();
    const onFocus = () => markLatestRead();
    window.addEventListener('focus', onFocus);
    onCleanup(() => window.removeEventListener('focus', onFocus));
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
        setOpenThread(null);
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
    // Collect the set of eventIds about to land so we can spot pending
    // entries the user has already optimistically rendered and splice
    // them in the SAME setCache transaction the events grow in. Doing
    // both halves of the swap in one Solid update is what removes the
    // flash: Solid commits "pending shrinks by 1, events grows by 1"
    // as a single render — no frame where both bubbles coexist and no
    // frame where neither exists.
    const incomingIds = new Set<string>();
    for (const ev of delta.newEvents) incomingIds.add(ev.eventId);

    props.setCache(props.room.roomId, (c: RoomCache) => {
      // Replace-or-push by eventId on the events array, assigning a
      // FRESH array reference. Worker emits the same eventId twice for
      // E2EE messages: once with type 'm.room.encrypted'
      // decryptionStatus:'pending' from RoomEvent.Timeline (live insert
      // placeholder), then again as 'm.room.message' from
      // MatrixEventEvent.Decrypted once the wasm decrypt finishes.
      // Skipping on known-id (the old behavior) left the placeholder
      // pinned and made live replies invisible until a page refresh.
      //
      // We assign `c.events = next` instead of mutating in place with
      // .push() / index assignment because Solid stores nested inside
      // a parent produce() don't always wake the downstream
      // createMemo(rows) on bare-array mutations — the symptom is
      // "inbound message never shows until reload". Full-array
      // assignment is the same path loadInitial uses and that one
      // demonstrably propagates.
      const indexById = new Map<string, number>();
      const next = c.events.slice();
      for (let i = 0; i < next.length; i++) {
        indexById.set(next[i].eventId, i);
      }
      for (const ev of delta.newEvents) {
        const existing = indexById.get(ev.eventId);
        if (existing !== undefined) {
          next[existing] = ev;
        } else {
          indexById.set(ev.eventId, next.length);
          next.push(ev);
        }
      }
      c.events = next;

      // Atomic pending-bubble lock-in. For every pending entry whose
      // expectedEventId just arrived in this delta, drop the pending
      // entry now — the real event is already present in `events`
      // above, so the swap is a single-frame transition. Same fresh
      // array semantics as events above to guarantee reactivity.
      if (c.pending.length > 0) {
        const nextPending = c.pending.filter(
          (p) => !(p.expectedEventId && incomingIds.has(p.expectedEventId)),
        );
        if (nextPending.length !== c.pending.length) {
          c.pending = nextPending;
        }
      }
    });
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
    props.setCache(props.room.roomId, (c: RoomCache) => {
      const idx = c.pending.findIndex((p) => p.txnId === e.txnId);
      if (idx < 0) return;
      if (e.status === 'sent') {
        // DON'T splice yet. The server confirmed the send and gave us
        // the canonical eventId, but the /sync delivery for that event
        // hasn't necessarily landed in `c.events` yet. If we splice
        // now, the bubble disappears until sync arrives (visible flash
        // / "message vanished" symptom). Instead, record the expected
        // eventId — the syncUpdate handler above splices the pending
        // entry in the same setCache transaction it appends the real
        // event, producing a single-frame swap.
        //
        // Fresh array reference so Solid's pending For() rerenders.
        const nextPending = c.pending.slice();
        nextPending[idx] = { ...nextPending[idx], expectedEventId: e.eventId };
        c.pending = nextPending;
      } else if (e.status === 'failed') {
        const nextPending = c.pending.slice();
        nextPending[idx] = {
          ...nextPending[idx],
          status: 'failed',
          errorReason: e.error?.message ?? 'send failed',
        };
        c.pending = nextPending;
        showToast('error', `Send failed: ${nextPending[idx].errorReason}`);
      }
    });
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
      props.setCache(props.room.roomId, (c: RoomCache) => {
        const known = new Set(c.events.map((ev) => ev.eventId));
        const older = res.events.filter((ev) => !known.has(ev.eventId));
        // unshift is a mutating array op that Solid's store proxy
        // intercepts cleanly. The previous `c.events = [...older, ...c.events]`
        // reassignment spread the already-proxied existing events into a
        // new array, which triggered Solid 1.9's proxy-invariant check
        // ("Symbol(solid-proxy) is read-only and non-configurable") because
        // it tried to re-wrap targets that already had a cached proxy.
        // (Updater is also no longer wrapped in `produce(...)` — the parent
        // updateCache already wraps; double-wrapping created the same
        // invariant violation by colliding setter markers across layers.)
        if (older.length > 0) c.events.unshift(...older);
        c.prevToken = res.prevToken;
        c.reachedStart = res.prevToken === null;
        c.paginating = false;
      });
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
  // INSTRUMENTATION (send-pipeline trace, UI half).
  // Send pipeline lives across three boundaries: composer (this file),
  // RPC bridge, and worker SDK. When the user reported "no bubble,
  // non-responsive" with no /send PUT and refused console access, we
  // routed phase markers from each boundary into the visible sync log
  // (via worker.diagLog RPC). UI-side markers ('send-UI[txn]'):
  //   1) submit-entered      — submit() ran at all (keyboard/button worked)
  //   2) edit-branch         — early-exit because we're editing
  //   3) empty-or-noop       — early-exit because draft was empty
  //   4) before-cache-push   — about to mutate pending bubbles
  //   5) cache-pushed        — optimistic bubble in store
  //   6) before-rpc          — about to fire bridge.request
  //   7) rpc-dispatched      — bridge.request returned its promise
  //   8) rpc-resolved        — promise resolved (worker said OK)
  //   9) rpc-rejected        — promise rejected (error path)
  //  10) sync-threw          — synchronous error during setup
  // If marker 1 never appears, the keyboard/submit handler is the bug.
  // If 6 appears but no worker 'send-RPC: handler entered' follows, the
  // bridge is the bug. Etc.
  const diag = (msg: string): void => {
    // Fire-and-forget. We don't await; we don't surface failures here
    // either, because the diagnostic must NOT add new failure modes to
    // the very flow it's instrumenting.
    void bridge.request({ kind: 'diagLog', note: msg }).catch(() => {});
  };

  const submit = () => {
    const text = draft().trim();
    diag(`send-UI: submit-entered chars=${text.length} editing=${editing() !== null}`);
    if (!text) {
      diag('send-UI: empty-or-noop — exit');
      return;
    }

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
    // Drain the pending-mentions set: only userIds whose handle still
    // textually appears in the body survive the deletion-tolerant
    // filter below. This makes the @mention pills consistent — if the
    // user typed @alice then deleted the word, the wire payload
    // shouldn't still claim a mention.
    const collected = drainMentions();
    const stillReferenced = collected.filter((u) =>
      // The composer inserted `@displayname `. Display names may collide;
      // we can't perfectly recover them from text. Conservative rule:
      // keep the userId if EITHER its localpart or any whitespace-bounded
      // @token survives in the body. Worst case is a spurious mention,
      // which the server tolerates.
      text.includes(`@${u.slice(1).split(':')[0]}`) || /\B@\w/.test(text),
    );
    const body: MessageBody = {
      msgtype: 'm.text',
      body: text,
      formattedBody: null,
      ...(stillReferenced.length > 0 ? { mentions: { userIds: stillReferenced } } : {}),
    };
    const txnId = mkTxn();
    const shortTxn = txnId.slice(-6);

    // Synchronous setup (cache mutation, draft clear) MUST be guarded.
    // Earlier "silent send failure" bug (L2 fix log) was exactly this:
    // setCache threw because the room cache wasn't initialized, and
    // because nothing wrapped the throw, the composer cleared and no
    // bubble appeared. We don't want to be blind to that class of bug
    // again — surface it as a toast AND a diag line.
    try {
      diag(`send-UI[${shortTxn}]: before-cache-push room=${props.room.roomId.slice(0, 24)}`);
      // updateCache (parent) already wraps in `produce(...)`. Passing a
      // bare callback is REQUIRED — wrapping again with produce() here
      // returns a Solid setter-marked function that, when invoked inside
      // the outer produce, mutates state through the proxy setter
      // protocol and trips the "Symbol(solid-proxy) is read-only and
      // non-configurable" Proxy invariant. That was the bug behind the
      // initial "silent send failure" — composer disabled, no bubble, no
      // /send PUT — caught only after end-to-end instrumentation routed
      // the throw into the visible sync log.
      props.setCache(props.room.roomId, (c: RoomCache) => {
        c.pending.push({ txnId, body: text, status: 'sending' });
      });
      diag(`send-UI[${shortTxn}]: cache-pushed pendingCount=${props.cache.pending.length}`);
      setDraft('');
      setReplyingTo(null);
      requestAnimationFrame(() => scrollToBottom('smooth'));
    } catch (err) {
      diag(`send-UI[${shortTxn}]: sync-threw err=${msgOf(err).slice(0, 160)}`);
      showToast('error', `Send setup failed: ${msgOf(err)}`);
      return;
    }

    // The worker enriches the wire-format with the m.relates_to → in_reply_to
    // reference when we pass it; for v1, we send the plain body. Reply
    // metadata wiring through the RPC contract is a Phase 4B improvement;
    // the reply context is preserved here as a UI hint until then.
    diag(`send-UI[${shortTxn}]: before-rpc dispatching bridge.request`);
    const sendCall = bridge.request({
      kind: 'sendMessage',
      roomId: props.room.roomId,
      content: body,
      txnId,
    });
    diag(`send-UI[${shortTxn}]: rpc-dispatched awaiting worker`);
    void sendCall
      .then(() => {
        diag(`send-UI[${shortTxn}]: rpc-resolved`);
      })
      .catch((err) => {
        diag(`send-UI[${shortTxn}]: rpc-rejected err=${msgOf(err).slice(0, 160)}`);
        props.setCache(props.room.roomId, (c: RoomCache) => {
          const p = c.pending.find((x) => x.txnId === txnId);
          if (p) {
            p.status = 'failed';
            p.errorReason = msgOf(err);
          }
        });
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

  // ---- Attachment send ---------------------------------------------------
  //
  // Decode dimensions for images client-side so the event info is
  // accurate (other clients trust it for layout). Skip the optimistic
  // pending row for now — a real file blob doesn't compress well into a
  // PendingMessage, and the event ID comes back fast enough that the
  // toast carries the user through the gap.
  const handleAttach = (file: File) => {
    const shortName = file.name.length > 32 ? `${file.name.slice(0, 30)}…` : file.name;
    const toastId = showToast('info', `Uploading ${shortName}…`);
    void (async () => {
      try {
        const data = await file.arrayBuffer();
        const info: {
          mimetype: string;
          size: number;
          w?: number;
          h?: number;
        } = { mimetype: file.type || 'application/octet-stream', size: file.size };
        if (file.type.startsWith('image/')) {
          const dims = await readImageDimensions(file);
          if (dims) {
            info.w = dims.w;
            info.h = dims.h;
          }
        }
        await bridge.request({
          kind: 'sendFileMessage',
          roomId: props.room.roomId,
          data,
          filename: file.name,
          info,
          txnId: mkTxn(),
        });
        dismissToast(toastId);
      } catch (err) {
        dismissToast(toastId);
        showToast('error', `Upload failed: ${msgOf(err)}`);
      }
    })();
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
    onOpenThread: (rootEventId) => {
      // Toggle: clicking the same root closes the panel. The panel
      // itself renders a Close button; this is the keyboard-friendly
      // way to dismiss from the message menu without reopening.
      setOpenThread((cur) => (cur === rootEventId ? null : rootEventId));
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

  // `<For>` keys items by REFERENCE, not by some extracted id. If the
  // rows() memo returns a fresh `{ kind: 'msg', ev, ... }` object on
  // every recomputation, every existing message looks like a new item
  // to <For>, which then remounts every <li>. Each remount re-fires
  // the `msg-enter` 120 ms fade-in animation — that is the "all
  // messages flash" symptom the user reported on send (one syncUpdate
  // → new `c.events` array reference → rows() reruns → every Row
  // identity changes → every bubble flashes).
  //
  // We cache Row objects by their stable identity key (eventId for
  // messages, day-bucket key for separators) and only mint a new
  // object when the underlying inputs that drive its render actually
  // change. `<For>` then sees referential equality for unchanged
  // rows and keeps the DOM (and the animation) untouched.
  const rowCache = new Map<string, Row>();
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const evs = props.cache.events;
    const seen = new Set<string>();
    let lastSender: UserId | null = null;
    let lastTs = 0;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (i === 0 || !isSameDay(lastTs, ev.originServerTs)) {
        const dayKey = `d-${ev.eventId}`;
        let dayRow = rowCache.get(dayKey);
        if (!dayRow || dayRow.kind !== 'day' || dayRow.ts !== ev.originServerTs) {
          dayRow = { kind: 'day', ts: ev.originServerTs, key: dayKey };
          rowCache.set(dayKey, dayRow);
        }
        seen.add(dayKey);
        out.push(dayRow);
        lastSender = null;
      }
      const showHeader =
        ev.sender !== lastSender ||
        ev.originServerTs - lastTs > 2 * 60 * 1000; // >2 min gap re-shows header
      const msgKey = ev.eventId;
      let msgRow = rowCache.get(msgKey);
      if (
        !msgRow ||
        msgRow.kind !== 'msg' ||
        msgRow.ev !== ev ||
        msgRow.showHeader !== showHeader
      ) {
        msgRow = { kind: 'msg', ev, showHeader, key: msgKey };
        rowCache.set(msgKey, msgRow);
      }
      seen.add(msgKey);
      out.push(msgRow);
      lastSender = ev.sender;
      lastTs = ev.originServerTs;
    }
    // Evict cache entries for rows that disappeared (e.g., redacted
    // message). Leaving them around would slowly leak memory.
    for (const k of rowCache.keys()) {
      if (!seen.has(k)) rowCache.delete(k);
    }
    return out;
  });

  return (
    <section class="relative grid h-full min-h-0 grid-rows-[auto_1fr_auto] bg-white dark:bg-neutral-950">
      <RoomHeader
        room={props.room}
        typingUserIds={typingUsers()}
        membersOpen={membersOpen()}
        onShowMembers={() => setMembersOpen((v) => !v)}
      />

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
        onAttach={handleAttach}
        focusToken={focusToken}
        loadMembers={loadMembersForComposer}
        onMention={addMention}
      />
      <MembersPanel
        room={props.room}
        open={membersOpen()}
        myUserId={me()}
        onClose={() => setMembersOpen(false)}
      />
      <Show when={openThread()}>
        {(rootId) => (
          <ThreadPanel
            roomId={props.room.roomId}
            threadRootId={rootId()}
            liveEvents={() => props.cache.events}
            myUserId={me()}
            onClose={() => setOpenThread(null)}
          />
        )}
      </Show>
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

/**
 * Pending (optimistic) own-message bubble. Visually IDENTICAL to a
 * confirmed own MessageBubble (`bg-accent text-accent-ink`, same
 * radius / padding / type scale) so that when the sync delivery lands
 * and the pending entry is spliced in favour of the real event, the
 * user sees no visual jump — same rectangle, same position, same ink.
 * The only differences are a faint pulse while we wait for the
 * homeserver to ack and a failed-state recolouring.
 */
function PendingRow(props: { pending: PendingEvent }) {
  const confirmed = () => Boolean(props.pending.expectedEventId);
  const failed = () => props.pending.status === 'failed';
  return (
    <li class="mt-0.5 flex justify-end">
      <div class="relative max-w-[78%]">
        <div
          class={`relative rounded-2xl px-3 py-2 text-sm leading-5 transition-opacity ${
            failed()
              ? 'bg-red-500 text-white'
              : 'bg-accent text-accent-ink'
          } ${confirmed() || failed() ? 'opacity-100' : 'opacity-90'}`}
        >
          <span class="whitespace-pre-wrap break-words">{props.pending.body}</span>
          <div
            class={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              failed() ? 'text-white/80' : 'text-accent-ink/70'
            }`}
          >
            {failed() ? (
              <span>failed: {props.pending.errorReason}</span>
            ) : (
              <span>{shortTime(Date.now())}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function mkTxn(): string {
  return `m${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read an image's intrinsic dimensions by loading it into an
 * HTMLImageElement off-DOM. Resolves to null for non-image files or
 * decode errors — caller treats that as "no dims, send anyway" rather
 * than blocking the upload.
 */
function readImageDimensions(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
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
