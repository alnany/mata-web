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
import { dismissToast, showBootGuardedError, showToast } from '../stores/toast.js';
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
import { MessageBubble, type MessageActions, encryptedReasonCopy } from '../components/message-bubble.js';
import { ThreadPanel } from '../components/thread-panel.js';
import { Composer } from '../components/composer.js';
import { RoomHeader } from '../components/room-header.js';
import { MembersPanel } from '../components/members-panel.js';
import { SearchPanel } from '../components/search-panel.js';
import { ForwardModal } from '../components/forward-modal.js';
import { readRoomTimeline, writeRoomTimeline } from '../lib/persistent-cache.js';

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
  /**
   * Read-marker anchor for the "New messages" unread divider. Captured
   * ONCE from the first `loadRoomHistory` response (the user's own
   * read-receipt up-to event id at open time, before the post-load
   * markLatestRead advances it), then frozen for the room session so
   * the divider stays put while you read instead of chasing the
   * advancing receipt. `null` = resolved to "no unread anchor";
   * `undefined` (the initial state via `unreadResolved`) = not captured
   * yet.
   */
  unreadAnchorEventId: string | null;
  /** True once the unread anchor has been captured (freezes the value). */
  unreadResolved: boolean;
  /**
   * Last scroll offset (px from top) the user left this room at, saved
   * on scroll and restored on reopen so hopping between rooms doesn't
   * snap you back to the bottom — the Telegram "you were reading here"
   * behavior. `undefined` until the user has scrolled this room at
   * least once in the session.
   */
  scrollTop?: number;
  /**
   * Whether the saved `scrollTop` had the room pinned to the bottom.
   * When true we restore by re-pinning to the live bottom (which may
   * have grown since) instead of the stale pixel offset.
   */
  scrollAtBottom?: boolean;
}

interface PendingEvent {
  txnId: string;
  body: string;
  status: 'sending' | 'failed';
  errorReason?: string;
  /**
   * Full wire payload retained ONLY for the retry path — when the
   * homeserver rejects a send (transient network blip, ratelimit,
   * federation hiccup), the failed PendingRow shows a "Retry" button
   * that re-fires the same `sendMessage` RPC verbatim. Without this
   * we'd lose mentions / reply target on retry, which would be a
   * silent corruption rather than a recoverable fail.
   */
  wireBody?: MessageBody;
  replyToParam?: { eventId: EventId; sender: UserId; body: string };
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
    unreadAnchorEventId: null,
    unreadResolved: false,
  };
}

const PAGE_SIZE = 50;
const SCROLL_STICK_THRESHOLD = 80;
const PAGINATE_TRIGGER = 200;

// Module-scoped member-list cache (see loadMembersForComposer below).
// Survives across room-view remounts so room-hop doesn't refetch.
const MEMBERS_TTL_MS = 30_000;
const membersCache = new Map<
  RoomId,
  { promise: Promise<RoomMember[]>; expiresAt: number }
>();

export function RoomView(props: {
  room: RoomSummary;
  cache: RoomCache;
  setCache: (roomId: RoomId, updater: (cache: RoomCache) => void) => void;
  /**
   * Full joined-rooms list, threaded through from `home.tsx`. The
   * ForwardModal needs it to render the target picker; we accept
   * the entire list (not just a callback) so the modal can do
   * client-side filtering on every keystroke without an extra
   * round-trip.
   */
  rooms: RoomSummary[];
  /**
   * Open the Settings → Encryption panel. Wired through `home.tsx` so
   * the timeline's "Restore from backup" CTA on a collapsed run of
   * undecryptable events can jump straight to the recovery flow
   * without the user hunting through settings.
   */
  onOpenEncryptionSettings?: () => void;
  /**
   * Called when the SDK reports this room is unknown (left, forgotten,
   * or never made it to local state) after we've already exhausted the
   * cold-start retry window inside the worker. The home view uses this
   * to close the column and trigger a room-list refetch — the stale
   * IndexedDB cache entry that lit up the click will be dropped on the
   * next /sync delta merge.
   */
  onRoomUnavailable?: (roomId: RoomId) => void;
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
  // The draft is persisted to localStorage keyed by roomId so it
  // survives both room-switching and full reloads. We hydrate from
  // storage on first mount and write-through on every setDraft.
  const draftStorageKey = (): string => `mata.draft.${props.room.roomId}`;
  const loadStoredDraft = (): string => {
    try {
      return localStorage.getItem(draftStorageKey()) ?? '';
    } catch {
      return '';
    }
  };
  const [draftValue, setDraftValueRaw] = createSignal<string>(loadStoredDraft());
  const draft = draftValue;
  const setDraft = (v: string) => {
    setDraftValueRaw(v);
    try {
      if (v) localStorage.setItem(draftStorageKey(), v);
      else localStorage.removeItem(draftStorageKey());
    } catch {
      /* localStorage may be disabled */
    }
    // Notify the room list (same tab) so it can show / clear a draft
    // preview. The native `storage` event only fires in OTHER tabs, so
    // a custom event is required for the in-tab room-list update.
    try {
      window.dispatchEvent(
        new CustomEvent('mata:draft-change', {
          detail: { roomId: props.room.roomId, text: v },
        }),
      );
    } catch {
      /* CustomEvent unsupported — list just won't live-update */
    }
  };
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
  // Staged attachments — the user has pasted / dropped a file but
  // hasn't pressed Send yet. Pre-staging fixes the worst paste-image
  // friction: previously the file uploaded and sent immediately, so
  // a "let me paste that screenshot" reflex was instant exfiltration
  // with no chance to crop, caption, or back out. Each entry owns an
  // ObjectURL for preview that we revoke on remove / send / unmount.
  type StagedAttachment = { id: string; file: File; previewUrl: string | null };
  const [staged, setStaged] = createSignal<StagedAttachment[]>([]);
  const revokeStaged = (s: StagedAttachment): void => {
    if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
  };
  const stageAttachment = (file: File): void => {
    const isImage = file.type.startsWith('image/');
    const entry: StagedAttachment = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: isImage ? URL.createObjectURL(file) : null,
    };
    setStaged((prev) => [...prev, entry]);
    // Pull focus into the composer so the user can immediately add
    // a caption / hit Enter to send.
    setFocusToken((n) => n + 1);
  };
  const unstage = (id: string): void => {
    setStaged((prev) => {
      const drop = prev.find((s) => s.id === id);
      if (drop) revokeStaged(drop);
      return prev.filter((s) => s.id !== id);
    });
  };
  onCleanup(() => {
    for (const s of staged()) revokeStaged(s);
  });
  // Forward-target picker. Holds the source message until the user
  // either picks a target (modal closes via its own success path) or
  // dismisses (we clear via onClose).
  const [forwardSource, setForwardSource] = createSignal<RoomMessageEvent | null>(null);
  const [searchOpen, setSearchOpen] = createSignal(false);

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

  // Lazy-load room members for the @autocomplete. Cached at module
  // scope with a 30s TTL so room-switch-and-back doesn't re-fetch a
  // members list that almost never changes within that window. The
  // earlier per-instance cache was wiped on every room-switch
  // remount; for power users hopping between 3-4 rooms repeatedly,
  // that meant a fresh members fetch per hop.
  const loadMembersForComposer = (): Promise<RoomMember[]> => {
    const cached = membersCache.get(props.room.roomId);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = bridge
      .request({ kind: 'loadRoomMembers', roomId: props.room.roomId })
      .then((r) => r.members)
      .catch(() => []);
    membersCache.set(props.room.roomId, {
      promise,
      expiresAt: Date.now() + MEMBERS_TTL_MS,
    });
    return promise;
  };
  const bumpFocus = () => setFocusToken((v) => v + 1);

  // ---- Initial history load ----------------------------------------------
  const loadInitial = async () => {
    if (props.cache.loaded || props.cache.loading) return;
    props.setCache(props.room.roomId, (c) => {
      c.loading = true;
    });

    // Fast-paint from the persisted timeline tail. This is where the
    // "Telegram silk" feel comes from on cold refresh: paint a
    // believable view before the loadRoomHistory round-trip returns,
    // then the live result replaces it below. Best-effort — failed
    // reads or empty caches just fall through to the network path.
    void readRoomTimeline(props.room.roomId)
      .then((snap) => {
        if (!snap) return;
        props.setCache(props.room.roomId, (c) => {
          // Don't clobber a live update that already landed first
          // (fast network beats IDB read on warm hardware).
          if (c.loaded || c.events.length > 0) return;
          c.events = snap.events;
          c.prevToken = snap.prevToken;
          c.reachedStart = snap.reachedStart;
        });
        requestAnimationFrame(() => scrollToBottom('auto'));
      })
      .catch(() => {});

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
        // Freeze the unread-divider anchor on the first real load only.
        // Subsequent reopens of the same room short-circuit before this
        // block (c.loaded guard at the top of loadInitial), so the
        // divider position stays stable for the whole session.
        if (!c.unreadResolved) {
          c.unreadAnchorEventId = res.readUpToEventId;
          c.unreadResolved = true;
        }
      });
      // Persist tail for next-boot fast paint. Debounced inside
      // writeRoomTimeline so it's safe to fire on every successful load.
      void writeRoomTimeline(
        props.room.roomId,
        res.events,
        res.prevToken,
        res.prevToken === null,
      ).catch(() => {});
      // Land on the unread divider if there is one, else bottom. Two
      // rAFs: first lets the rows memo + <For> commit the divider node,
      // second runs after layout so offsetTop is real.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          // A remembered position wins (room reopened mid-session);
          // otherwise land on the unread divider or the bottom.
          if (!restoreScroll()) scrollToUnreadOrBottom();
        }),
      );
    } catch (err) {
      props.setCache(props.room.roomId, (c) => {
        c.loading = false;
      });
      const m = msgOf(err);
      if (/Unknown room/i.test(m)) {
        // Stale cache row pointing at a room the SDK does not have
        // (left/forgotten/never-synced). Don't ship the raw error to
        // the user — close the column and let home.tsx drop the row.
        showToast(
          'error',
          'This room is not available. It may have been left, or sync is still catching up.',
        );
        props.onRoomUnavailable?.(props.room.roomId);
      } else {
        // Boot-gate: if the initial-history fetch fires while
        // SdkSession is still restoring (auto-open the last room
        // races the worker), it rejects with `Not logged in`. The
        // syncUpdate that lands a moment later re-triggers the
        // load. No need to alarm the user in that window — the
        // skeleton/loading state already communicates "we're
        // catching up".
        showBootGuardedError(`Could not load messages: ${m}`);
      }
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
    // Cmd/Ctrl+F toggles the search panel. We swallow the browser's
    // native find dialog because in-room search is the more useful
    // affordance — the conversation rarely lives entirely in the DOM
    // (virtualized off-screen messages won't match a native find).
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      // Esc cancels an active reply or edit without consuming the key
      // for other handlers (search close, lightbox close, etc. have
      // their own listeners and run first via capture — none of them
      // call stopPropagation, so we don't interfere with them).
      if (e.key === 'Escape') {
        if (editing()) {
          setEditing(null);
          return; // don't preventDefault — let the composer keep focus
        }
        if (replyingTo()) {
          setReplyingTo(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey);
      if (scrollPersistTimer) clearTimeout(scrollPersistTimer);
    });
  });

  createEffect(
    on(
      () => props.room.roomId,
      () => {
        loadInitial();
        setTypingUsers([]);
        // Reload the destination room's draft from localStorage. We
        // MUST NOT call setDraft('') here: setDraft writes through
        // to localStorage, and `draftStorageKey()` reactively reads
        // props.room.roomId — which at this point is already the
        // NEW room. So setDraft('') would DELETE the destination
        // room's saved draft (the exact "I typed a message, switched
        // chats, came back, it's gone" bug). Use setDraftValueRaw
        // to update only the in-memory signal; per-room localStorage
        // stays intact until the user actually types or sends.
        setDraftValueRaw(loadStoredDraft());
        setReplyingTo(null);
        setEditing(null);
        setOpenThread(null);
        requestAnimationFrame(() => {
          // Restore the destination room's remembered scroll position.
          // If the room was already loaded earlier this session and the
          // user had scrolled it, this lands them back where they left
          // off; a never-visited / caught-up room falls through to the
          // unread-divider-or-bottom heuristic. Reset stick state from
          // the restored position so the jump-to-bottom pill is correct.
          if (!restoreScroll()) scrollToUnreadOrBottom();
          if (scrollerRef) {
            const dist =
              scrollerRef.scrollHeight - scrollerRef.scrollTop - scrollerRef.clientHeight;
            setStickToBottom(dist < SCROLL_STICK_THRESHOLD);
          }
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
    const atBottom = distFromBottom < SCROLL_STICK_THRESHOLD;
    setStickToBottom(atBottom);

    // Remember where the user is so reopening the room restores it.
    // Debounced so we don't thrash the store on every scroll frame.
    persistScrollSoon(scrollerRef.scrollTop, atBottom);

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
      // Same boot-gate as loadInitial: a scroll-to-top firing while
      // the worker is still restoring rejects with `Not logged in`.
      // Boot-settled rejections (genuine pagination failures) still
      // toast.
      showBootGuardedError(`Could not load older messages: ${msgOf(err)}`);
    }
  };

  // Debounced write-through of the live scroll offset into the room
  // cache. The room id is captured at call time so a write that fires
  // after a fast room-switch still lands on the room it belongs to.
  let scrollPersistTimer: ReturnType<typeof setTimeout> | undefined;
  const persistScrollSoon = (top: number, atBottom: boolean) => {
    const roomId = props.room.roomId;
    if (scrollPersistTimer) clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(() => {
      props.setCache(roomId, (c) => {
        c.scrollTop = top;
        c.scrollAtBottom = atBottom;
      });
    }, 200);
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    if (!scrollerRef) return;
    scrollerRef.scrollTo({ top: scrollerRef.scrollHeight, behavior });
  };

  /**
   * Restore scroll on (re)open. Priority:
   *   1. A remembered offset from a previous visit this session — the
   *      "you were reading here" restore. If it was pinned to bottom,
   *      re-pin to the (possibly grown) live bottom instead.
   *   2. Otherwise the unread divider / bottom heuristic for a first
   *      open.
   * Returns true if a remembered position was applied.
   */
  const restoreScroll = (): boolean => {
    if (!scrollerRef) return false;
    const { scrollTop, scrollAtBottom } = props.cache;
    if (scrollAtBottom) {
      scrollToBottom('auto');
      return true;
    }
    if (typeof scrollTop === 'number') {
      // Clamp to the current scrollable range in case the timeline
      // shrank (e.g. old undecryptable events were filtered out).
      const max = scrollerRef.scrollHeight - scrollerRef.clientHeight;
      scrollerRef.scrollTo({ top: Math.min(scrollTop, Math.max(0, max)), behavior: 'auto' });
      return true;
    }
    return false;
  };

  /**
   * On room open, land on the "New messages" divider if one was drawn,
   * positioning it a little below the top so the last-read message is
   * still visible for context. Falls back to the bottom when there's
   * no unread divider in the DOM (all caught up, or anchor outside the
   * loaded window). Only used for the initial paint — live updates and
   * the jump pill keep using scrollToBottom.
   */
  const scrollToUnreadOrBottom = () => {
    if (!scrollerRef) {
      return;
    }
    const divider = scrollerRef.querySelector<HTMLElement>(
      '[data-unread-divider]',
    );
    if (divider) {
      // ~72px of breathing room above the line so the previous message
      // peeks in — matches Telegram's "you were here" framing.
      const top = Math.max(0, divider.offsetTop - 72);
      scrollerRef.scrollTo({ top, behavior: 'auto' });
      return;
    }
    scrollToBottom('auto');
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
    const stagedNow = staged();
    diag(
      `send-UI: submit-entered chars=${text.length} editing=${
        editing() !== null
      } staged=${stagedNow.length}`,
    );

    // Edit mode does NOT accept attachments — Matrix edits replace a
    // text event's body and can't morph a text into a file message.
    // If the user staged something while in edit mode, prioritize the
    // edit and leave the staged list alone for them to send after.
    if (editing()) {
      if (!text) return; // can't submit an empty edit
      // falls through to edit branch below
    } else {
      // Drain staged attachments first so files render in the timeline
      // BEFORE any caption text — same order Telegram / iMessage use.
      if (stagedNow.length > 0) {
        for (const s of stagedNow) {
          // Revoke preview URL: the worker owns the data now and we
          // no longer need the browser-side blob mapping.
          if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
          void uploadAndSendFile(s.file);
        }
        setStaged([]);
      }
    }

    if (!text) {
      // Pure attachment send is legal — staged files were drained
      // above; nothing else to do.
      if (stagedNow.length === 0) {
        diag('send-UI: empty-or-noop — exit');
      }
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

    // Reply wire-up. When the user clicked Reply on a message, attach
    // the in-reply-to relation so the worker emits a proper Matrix
    // rich-reply (`m.relates_to.m.in_reply_to` + quote-prefix fallback).
    // The worker handles the fallback body construction and HTML
    // wrapping; we just hand it the parent's eventId / sender / body.
    //
    // This MUST be declared before the cache-push try-block: the
    // pending entry retains `replyToParam` so a Retry can replay the
    // same reply target, and referencing it from inside the try-block
    // before it's bound is a temporal-dead-zone violation (manifests
    // post-bundle as "Cannot access 'te' before initialization" and
    // surfaces to the user as the "Send setup failed" toast).
    const replyToParam =
      replyTarget && replyTarget.content.msgtype === 'm.text'
        ? {
            eventId: replyTarget.eventId,
            sender: replyTarget.sender,
            body: replyTarget.content.body,
          }
        : replyTarget
          ? {
              eventId: replyTarget.eventId,
              sender: replyTarget.sender,
              body: replyTarget.content.body || '',
            }
          : undefined;

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
        c.pending.push({
          txnId,
          body: text,
          status: 'sending',
          wireBody: body,
          ...(replyToParam ? { replyToParam } : {}),
        });
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

    diag(`send-UI[${shortTxn}]: before-rpc dispatching bridge.request`);
    const sendCall = bridge.request({
      kind: 'sendMessage',
      roomId: props.room.roomId,
      content: body,
      txnId,
      ...(replyToParam ? { replyTo: replyToParam } : {}),
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

  };

  /**
   * Retry a previously failed pending send. Resets status to
   * 'sending', re-fires the same RPC payload, and on success the
   * usual sync delivery splices it as normal. We reuse the original
   * txnId because matrix-js-sdk's idempotency table is keyed on
   * (roomId, txnId) — re-using the same id means a delayed-success
   * from the original attempt is recognized as the SAME message
   * rather than a duplicate, preventing the "send twice, see two
   * bubbles" hazard if the network just stalled.
   */
  const retryPending = (txnId: string) => {
    const p = props.cache.pending.find((x) => x.txnId === txnId);
    if (!p || p.status !== 'failed' || !p.wireBody) return;
    props.setCache(props.room.roomId, (c: RoomCache) => {
      const idx = c.pending.findIndex((x) => x.txnId === txnId);
      if (idx < 0) return;
      const nextPending = c.pending.slice();
      nextPending[idx] = { ...nextPending[idx], status: 'sending', errorReason: undefined };
      c.pending = nextPending;
    });
    void bridge
      .request({
        kind: 'sendMessage',
        roomId: props.room.roomId,
        content: p.wireBody,
        txnId,
        ...(p.replyToParam ? { replyTo: p.replyToParam } : {}),
      })
      .catch((err) => {
        props.setCache(props.room.roomId, (c: RoomCache) => {
          const idx = c.pending.findIndex((x) => x.txnId === txnId);
          if (idx < 0) return;
          const nextPending = c.pending.slice();
          nextPending[idx] = { ...nextPending[idx], status: 'failed', errorReason: msgOf(err) };
          c.pending = nextPending;
        });
        showToast('error', `Retry failed: ${msgOf(err)}`);
      });
  };

  /**
   * Drop a failed pending send entirely. There's no homeserver call
   * — the message was never accepted, so removing the local pending
   * entry is the whole operation.
   */
  const dismissPending = (txnId: string) => {
    props.setCache(props.room.roomId, (c: RoomCache) => {
      c.pending = c.pending.filter((x) => x.txnId !== txnId);
    });
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
  /**
   * Drains the staged attachment list to the worker (encrypt + upload
   * + send file event per file). Runs in parallel — file uploads are
   * independent and the worker queues them onto its own sender. We
   * intentionally do NOT await this from the caller; the submit path
   * fires-and-forgets so the composer clears immediately and the
   * optimistic UI from sendStatus drives the timeline.
   */
  const uploadAndSendFile = async (file: File): Promise<void> => {
    const shortName = file.name.length > 32 ? `${file.name.slice(0, 30)}…` : file.name;
    const toastId = showToast('info', `Uploading ${shortName}…`);
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
  };

  /**
   * Public entry point for the attach button and drop/paste handlers.
   * Stages the file for preview instead of sending immediately — the
   * user must press Send (or Enter) to commit. This is the single
   * biggest UX safety net for "I pasted the wrong screenshot."
   */
  const handleAttach = (file: File): void => {
    stageAttachment(file);
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
    onForward: (ev) => {
      setForwardSource(ev);
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
    | { kind: 'unread'; key: string }
    | { kind: 'msg'; ev: TimelineEvent; showHeader: boolean; key: string }
    | {
        // Collapsed run of consecutive undecryptable events. Renders as
        // one muted marker instead of N gravestones. Most common after
        // login on a fresh device, when the timeline backfills past
        // messages we don't have keys for.
        kind: 'utdGroup';
        count: number;
        dominantReason: string | null;
        recoverable: boolean;
        startEventId: EventId;
        endEventId: EventId;
        key: string;
      };

  const eventById = createMemo(() => {
    const map = new Map<EventId, TimelineEvent>();
    for (const ev of props.cache.events) map.set(ev.eventId, ev);
    return map;
  });

  /**
   * Aggregate thread reply counts per root event in one pass over
   * the cached timeline. Used by MessageBubble to render the
   * Element-style "💬 N replies · last reply Xm ago" pill below
   * thread roots — the clickable affordance that turns threads
   * from a buried More-menu feature into a first-class surface.
   *
   * Why a Map keyed by root id (not by index): the bubble looks
   * up by its OWN eventId, not by position in the list, so we
   * need O(1) access. Recomputes on cache.events change.
   */
  type ThreadSummary = { count: number; lastTs: number; lastSender: UserId | null };
  const threadSummaries = createMemo(() => {
    const map = new Map<EventId, ThreadSummary>();
    for (const ev of props.cache.events) {
      if (ev.type !== 'm.room.message') continue;
      const root = ev.threadRoot;
      if (!root) continue;
      const cur = map.get(root);
      if (!cur) {
        map.set(root, { count: 1, lastTs: ev.originServerTs, lastSender: ev.sender });
      } else {
        cur.count += 1;
        if (ev.originServerTs > cur.lastTs) {
          cur.lastTs = ev.originServerTs;
          cur.lastSender = ev.sender;
        }
      }
    }
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
  // Cutoff for "ancient" undecryptable events. matrix-js-sdk's live
  // timeline can have very old encrypted events appended at any time
  // (late backfill, federation catch-up, server replay). For events
  // older than this many days that we can't decrypt, we'll never get
  // a session — they're permanently unviewable, and they pollute the
  // active conversation view with floating "🔒 sent before you signed
  // in" markers inserted between today's messages. Drop them from the
  // render entirely; if backup-restore later decrypts them, they
  // reappear as normal messages.
  const UTD_STALE_DAYS = 30;
  const UTD_STALE_MS = UTD_STALE_DAYS * 24 * 60 * 60 * 1000;
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const evsRaw = props.cache.events;
    const seen = new Set<string>();
    let lastSender: UserId | null = null;
    let lastTs = 0;

    // ── Filter ancient UTDs + normalize chronological order ──────────
    // Two related pre-passes, both targeted at "old encrypted events
    // appearing inline with today's conversation":
    //   1. Drop UTDs older than UTD_STALE_DAYS — they have no recovery
    //      path beyond key backup, which is gated by a separate CTA.
    //   2. Sort by originServerTs. matrix-js-sdk preserves wire arrival
    //      order, which is mostly chronological but not strictly so —
    //      late-arriving backfill events get appended at the tail with
    //      a months-old ts, which is exactly what triggers the double
    //      day-divider symptom (today → Oct 2 → today → Jun 25 …).
    //      Sorting once here is O(n log n) on a 50–60-event tail and
    //      runs only when the array reference changes (memo); cheap.
    const nowTs = Date.now();
    const evs = evsRaw
      .filter((e) => {
        if (
          e.type === 'm.room.encrypted' &&
          (e as Extract<TimelineEvent, { type: 'm.room.encrypted' }>)
            .decryptionStatus === 'failed' &&
          nowTs - e.originServerTs > UTD_STALE_MS
        ) {
          return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => a.originServerTs - b.originServerTs);

    // ── Resolve the "New messages" divider position ─────────────────
    // The anchor is the user's read-receipt up-to event captured at
    // open time. The divider goes before the FIRST event newer than
    // that anchor, but only when:
    //   • the anchor event is actually inside the loaded window (so we
    //     don't slam the line to the very top when the marker is older
    //     than the 50-event tail — that would be misleading), and
    //   • there's at least one newer event, and
    //   • that first newer event isn't the user's own (no point telling
    //     you your own just-sent message is "new").
    // Computed once per memo run; cheap on a ~50-event tail.
    let firstUnreadEventId: string | null = null;
    const anchorId = props.cache.unreadAnchorEventId;
    if (anchorId) {
      const anchorIdx = evs.findIndex((e) => e.eventId === anchorId);
      if (anchorIdx >= 0 && anchorIdx < evs.length - 1) {
        const candidate = evs[anchorIdx + 1];
        if (candidate.sender !== me()) {
          firstUnreadEventId = candidate.eventId;
        }
      }
    }
    let unreadEmitted = false;

    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      // ---- collapse runs of undecryptable events ------------------------
      // A timeline backfilled from a fresh device often contains long
      // stretches of m.room.encrypted/failed events (we have no keys for
      // them). Rendering each one as its own marker is visual noise. If
      // 2+ failed events appear in a row, fold them into a single
      // `utdGroup` row. Day-divider logic still runs against the FIRST
      // event of the group so we don't lose the date boundary.
      if (ev.type === 'm.room.encrypted' && ev.decryptionStatus === 'failed') {
        let j = i;
        while (
          j < evs.length &&
          evs[j].type === 'm.room.encrypted' &&
          (evs[j] as Extract<TimelineEvent, { type: 'm.room.encrypted' }>)
            .decryptionStatus === 'failed' &&
          isSameDay(ev.originServerTs, evs[j].originServerTs)
        ) {
          j++;
        }
        const runLen = j - i;
        // Only the multi-event collapse path emits a day divider here.
        // Singletons fall through to the shared normal-row branch
        // below, which has its own divider logic; emitting one in
        // both places was the source of the duplicate "Thu, Oct 2 /
        // Thu, Oct 2" pair the user reported.
        if (runLen >= 2) {
          if (out.length === 0 || !isSameDay(lastTs, ev.originServerTs)) {
            const dayKey = `d-${ev.eventId}`;
            let dayRow = rowCache.get(dayKey);
            if (!dayRow || dayRow.kind !== 'day' || dayRow.ts !== ev.originServerTs) {
              dayRow = { kind: 'day', ts: ev.originServerTs, key: dayKey };
              rowCache.set(dayKey, dayRow);
            }
            seen.add(dayKey);
            out.push(dayRow);
          }
          // Pick the most common failure reason in the run for copy.
          const tally = new Map<string, number>();
          for (let k = i; k < j; k++) {
            const e = evs[k] as Extract<TimelineEvent, { type: 'm.room.encrypted' }>;
            const r = e.failureReason ?? 'unknown';
            tally.set(r, (tally.get(r) ?? 0) + 1);
          }
          let dominantReason: string | null = null;
          let best = 0;
          for (const [k, v] of tally) {
            if (v > best) {
              best = v;
              dominantReason = k;
            }
          }
          const startId = ev.eventId;
          const endId = evs[j - 1].eventId;
          // Treat historical / session_missing as potentially recoverable
          // via key backup restore. Withheld / verification failures are
          // policy-level and can't be fixed by restoring a backup.
          const recoverable =
            dominantReason === 'historical' || dominantReason === 'session_missing';
          const grpKey = `utd-${startId}-${endId}`;
          let grpRow = rowCache.get(grpKey);
          if (
            !grpRow ||
            grpRow.kind !== 'utdGroup' ||
            grpRow.count !== runLen ||
            grpRow.dominantReason !== dominantReason ||
            grpRow.recoverable !== recoverable
          ) {
            grpRow = {
              kind: 'utdGroup',
              count: runLen,
              dominantReason,
              recoverable,
              startEventId: startId,
              endEventId: endId,
              key: grpKey,
            };
            rowCache.set(grpKey, grpRow);
          }
          seen.add(grpKey);
          out.push(grpRow);
          lastSender = null;
          lastTs = evs[j - 1].originServerTs;
          i = j - 1;
          continue;
        }
        // Singleton UTD — fall through to normal msg-row rendering so
        // it still shows up; SystemRow inside MessageBubble handles it.
      }
      // ---- normal row path ----------------------------------------------
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
      // "New messages" divider — emitted once, immediately before the
      // first unread event (after any day divider for that event so the
      // chronological boundary still reads first). Stable key tied to
      // the anchored event so the row reconciles cleanly across memo
      // runs and survives until the room cache is dropped.
      if (firstUnreadEventId && !unreadEmitted && ev.eventId === firstUnreadEventId) {
        const unreadKey = `unread-${firstUnreadEventId}`;
        let unreadRow = rowCache.get(unreadKey);
        if (!unreadRow || unreadRow.kind !== 'unread') {
          unreadRow = { kind: 'unread', key: unreadKey };
          rowCache.set(unreadKey, unreadRow);
        }
        seen.add(unreadKey);
        out.push(unreadRow);
        unreadEmitted = true;
        // Force a header on the first unread message so the sender
        // avatar/name shows right under the divider, not merged into a
        // run that started above the line.
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

  // ---- Drag/drop + paste image ------------------------------------------
  // Both surfaces just hand the resulting File to `handleAttach` — the
  // existing pipeline already handles encryption + send. Paste lives
  // on the section (any focus in the room view), drag/drop reuses the
  // same section and shows a translucent overlay when active.
  const [isDragOver, setIsDragOver] = createSignal(false);
  const dragDepth = { count: 0 };
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth.count++;
    setIsDragOver(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth.count = Math.max(0, dragDepth.count - 1);
    if (dragDepth.count === 0) setIsDragOver(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.count = 0;
    setIsDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    // Stage every dropped file — multi-file drag (a folder of
    // screenshots, a batch of PDFs) is common and silently dropping
    // all but the first is the kind of small thing that erodes trust.
    for (const file of Array.from(files)) handleAttach(file);
  };
  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let staged = false;
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const file = it.getAsFile();
        if (file) {
          handleAttach(file);
          staged = true;
        }
      }
    }
    // Only swallow the paste event when we actually staged a file —
    // otherwise we'd block plain text paste into the composer.
    if (staged) e.preventDefault();
  };

  return (
    <section
      class="relative grid min-h-0 flex-1 grid-rows-[auto_1fr_auto] bg-conv"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <Show when={isDragOver()}>
        <div
          class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/15 backdrop-blur-sm"
          style={{ 'border': '2px dashed var(--color-accent)' }}
        >
          <div class="rounded-[10px] border bg-elev px-6 py-4 text-sm font-medium text-fg shadow-xl"
               style={{ 'border-color': 'var(--color-accent)' }}>
            Drop to send
          </div>
        </div>
      </Show>
      <RoomHeader
        room={props.room}
        typingUserIds={typingUsers()}
        membersOpen={membersOpen()}
        onShowMembers={() => setMembersOpen((v) => !v)}
        searchOpen={searchOpen()}
        onShowSearch={() => setSearchOpen((v) => !v)}
      />

      {/* Timeline */}
      <div class="relative min-h-0">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        class="h-full min-h-0 overflow-y-auto px-4 py-4"
        data-mata-timeline
      >
        <Show when={props.cache.loaded} fallback={<LoadingStub />}>
          <Show when={props.cache.paginating}>
            <div class="mb-2 text-center text-[11px] text-fg-3">Loading older…</div>
          </Show>
          <Show
            when={rows().length > 0 || props.cache.pending.length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-xs text-fg-3">
                No messages yet — say hi.
              </div>
            }
          >
            <ul class="flex flex-col">
              <For each={rows()}>
                {(row) =>
                  row.kind === 'day' ? (
                    <DayDivider ts={row.ts} />
                  ) : row.kind === 'unread' ? (
                    <UnreadDivider />
                  ) : row.kind === 'utdGroup' ? (
                    <UndecryptableGroupRow
                      count={row.count}
                      dominantReason={row.dominantReason}
                      recoverable={row.recoverable}
                      onRestore={() => props.onOpenEncryptionSettings?.()}
                    />
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
                      threadSummary={threadSummaries().get(row.ev.eventId)}
                      actions={actions}
                    />
                  )
                }
              </For>
              <For each={props.cache.pending}>
                {(p) => (
                  <PendingRow
                    pending={p}
                    onRetry={() => retryPending(p.txnId)}
                    onDismiss={() => dismissPending(p.txnId)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
        {/* Jump-to-bottom pill — only visible when scrolled away from
            the bottom. Clicking smooth-scrolls to the latest message
            and re-engages the stick-to-bottom behavior. */}
        <Show when={!stickToBottom()}>
          <button
            type="button"
            onClick={() => {
              scrollToBottom('smooth');
              setStickToBottom(true);
            }}
            class="absolute bottom-3 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-elev text-fg shadow-lg transition-transform hover:scale-110"
            style={{ 'border-color': 'var(--color-line)' }}
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7l4 4 4-4" />
            </svg>
          </button>
        </Show>
      </div>

      <Show when={staged().length > 0}>
        <div class="flex flex-wrap gap-[8px] border-t border-line-1 bg-elev px-[12px] py-[8px]">
          <For each={staged()}>
            {(s) => {
              const isImage = s.file.type.startsWith('image/');
              return (
                <div class="group relative flex items-center gap-[8px] rounded-[8px] border border-line-2 bg-app px-[8px] py-[6px] pr-[28px]">
                  {isImage && s.previewUrl ? (
                    <img
                      src={s.previewUrl}
                      alt=""
                      class="h-[40px] w-[40px] rounded-[5px] object-cover"
                    />
                  ) : (
                    <div class="flex h-[40px] w-[40px] items-center justify-center rounded-[5px] bg-elev text-fg-3">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                    </div>
                  )}
                  <div class="flex max-w-[160px] flex-col gap-[2px]">
                    <div class="truncate text-[12px] text-fg" style={{ 'font-weight': 500 }}>
                      {s.file.name}
                    </div>
                    <div class="mono text-[10px] uppercase tracking-[0.06em] text-fg-4">
                      {(s.file.size / 1024 < 1024
                        ? `${(s.file.size / 1024).toFixed(0)} KB`
                        : `${(s.file.size / 1024 / 1024).toFixed(1)} MB`)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => unstage(s.id)}
                    aria-label={`Remove ${s.file.name}`}
                    title="Remove"
                    class="absolute right-[4px] top-[4px] flex h-[20px] w-[20px] items-center justify-center rounded-full text-fg-4 hover:bg-elev hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/40"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Composer
        draft={draft}
        setDraft={setDraft}
        replyingTo={replyingTo()}
        editing={editing()}
        onCancelContext={cancelContext}
        onSubmit={submit}
        onTyping={sendTyping}
        onAttach={handleAttach}
        hasStagedAttachments={() => staged().length > 0}
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
      <SearchPanel
        room={props.room}
        open={searchOpen()}
        onClose={() => setSearchOpen(false)}
        onSelect={(eventId) => actions.onJumpTo(eventId)}
      />
      <ForwardModal
        open={forwardSource() !== null}
        source={forwardSource()}
        rooms={props.rooms}
        onClose={() => setForwardSource(null)}
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

/**
 * Collapsed marker for a run of consecutive undecryptable events.
 * Renders as ONE muted pill with the count and, when the failure
 * is recoverable (historical / session_missing), an inline
 * "Restore from backup" link that opens the encryption panel.
 *
 * Replaces what used to be N separate "** Unable to decrypt:
 * DecryptionError: ... **" gravestones on a fresh-login timeline
 * backfill.
 */
function UndecryptableGroupRow(props: {
  count: number;
  dominantReason: string | null;
  recoverable: boolean;
  onRestore?: () => void;
}) {
  return (
    <li class="my-2 flex justify-center px-1">
      <span class="inline-flex items-center gap-2 rounded-full border border-line bg-elev px-3 py-1 text-[11px] italic text-fg-3">
        <span aria-hidden="true">🔒</span>
        <span>
          {props.count} encrypted{' '}
          {props.count === 1 ? 'message' : 'messages'} —{' '}
          {encryptedReasonCopy(props.dominantReason).replace(/^Encrypted — /, '')}
        </span>
        <Show when={props.recoverable && props.onRestore}>
          <button
            type="button"
            onClick={() => props.onRestore?.()}
            class="ml-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium not-italic text-accent-ink transition-[filter] hover:brightness-95"
          >
            Restore from backup
          </button>
        </Show>
      </span>
    </li>
  );
}

function DayDivider(props: { ts: number }) {
  // Telegram-style: pill floats over a thin horizontal rule that spans
  // the full timeline width. The rule uses `--color-line` so it blends
  // into the conversation surface; the pill sits on top with `bg-elev`
  // so it's clearly readable against both light and dark backgrounds.
  return (
    <li class="my-4 flex items-center gap-3 px-1">
      <span
        class="h-px flex-1"
        style={{ 'background-color': 'var(--color-line)' }}
        aria-hidden="true"
      />
      <span
        class="mono rounded-full border bg-elev px-3 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-3"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        {dayLabel(props.ts)}
      </span>
      <span
        class="h-px flex-1"
        style={{ 'background-color': 'var(--color-line)' }}
        aria-hidden="true"
      />
    </li>
  );
}

/**
 * "New messages" divider. Same floating-pill-over-a-rule structure as
 * DayDivider, but tinted with the accent token so the eye snaps to it,
 * and carries `data-unread-divider` so the room-open scroll logic
 * (scrollToUnreadOrBottom) can find and land on it. Drawn once, before
 * the first event newer than the read marker captured at open time.
 */
function UnreadDivider() {
  return (
    <li
      data-unread-divider
      class="my-4 flex items-center gap-3 px-1"
    >
      <span
        class="h-px flex-1"
        style={{ 'background-color': 'var(--color-mata-300)' }}
        aria-hidden="true"
      />
      <span
        class="rounded-full px-3 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] bg-accent text-accent-ink"
      >
        New messages
      </span>
      <span
        class="h-px flex-1"
        style={{ 'background-color': 'var(--color-mata-300)' }}
        aria-hidden="true"
      />
    </li>
  );
}

function LoadingStub() {
  return (
    <div class="flex h-full items-center justify-center text-xs text-fg-3">
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
function PendingRow(props: {
  pending: PendingEvent;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const confirmed = () => Boolean(props.pending.expectedEventId);
  const failed = () => props.pending.status === 'failed';
  const canRetry = () => failed() && Boolean(props.pending.wireBody);
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
              <>
                <span class="mr-auto truncate max-w-[60%]">
                  failed: {props.pending.errorReason}
                </span>
                <Show when={canRetry()}>
                  <button
                    type="button"
                    onClick={props.onRetry}
                    class="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white hover:bg-white/30"
                    title="Retry sending"
                  >
                    Retry
                  </button>
                </Show>
                <button
                  type="button"
                  onClick={props.onDismiss}
                  class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/80 hover:bg-white/20"
                  title="Discard this failed message"
                >
                  Dismiss
                </button>
              </>
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
