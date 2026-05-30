import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { Portal } from 'solid-js/web';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { session, setSession } from '../stores/session.js';
import {
  markBootSettled,
  showBootGuardedError,
  showToast,
} from '../stores/toast.js';
import { activeCall } from '../stores/call.js';
import { mountPresence } from '../stores/presence.js';
import type { EventId, RoomId, RoomSummary, SearchHit, UserId } from '@mata/shared/matrix';
import { RoomView, createRoomCache, type RoomCache } from './room-view.js';
import { applySendStatus, mergeEvents, reconcilePending } from '../lib/timeline-merge.js';
import { SettingsDrawer } from '../components/settings-drawer.js';
import { dispatchSyncDeltas, setRoomCounts } from '../stores/notifications.js';
import { NewRoomModal } from '../components/new-room-modal.js';
import { readRoomList, writeRoomList } from '../lib/persistent-cache.js';
import { listTime } from '../lib/date-buckets.js';
import { initials, gradientForUser, prettyName } from '../components/message-bubble.js';
import { Mark } from '../components/logo.js';
import { updateAvailable } from '../main.js';

/**
 * Floating "new version available" banner. Rendered fixed at the top so it
 * overlays the grid without reflowing the two-column layout. Visible only
 * when a new service worker is waiting to activate (updateAvailable signal,
 * driven from main.tsx). Clicking "Update" tells the waiting SW to skip its
 * wait and reloads the page onto the fresh bundle.
 */
function UpdateBanner() {
  const refresh = () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
        // Reload shortly after; the new SW takes control on next load.
        setTimeout(() => window.location.reload(), 150);
      });
    } else {
      window.location.reload();
    }
  };
  return (
    <Show when={updateAvailable()}>
      <div
        role="status"
        class="fixed left-1/2 top-3 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-[10px] px-3.5 py-2 text-[12.5px] shadow-lg"
        style={{
          background: 'var(--color-accent)',
          color: 'var(--color-accent-ink)',
        }}
      >
        <span class="font-medium">A new version of Mata is available.</span>
        <button
          type="button"
          onClick={refresh}
          class="rounded-[6px] px-2.5 py-1 text-[12px] font-semibold transition-opacity hover:opacity-80"
          style={{
            background: 'color-mix(in oklab, var(--color-accent-ink) 18%, transparent)',
          }}
        >
          Update
        </button>
      </div>
    </Show>
  );
}

/**
 * Three-column shell: rail (64) · room list (296) · conversation (flex).
 *
 * Side panel is NOT a permanent fourth column — it slides in on demand
 * via thread-panel / members-panel components owned by RoomView. Per the
 * user's directive (msg-cGZsaJps5Lj4T7hG): only apply the design style to
 * features we ship today. Workspace squares (multi-workspace switcher),
 * fake titlebar chrome, and Files/Pinned tabs are intentionally absent.
 */
export function HomePage() {
  const bridge = useBridge();
  const navigate = useNavigate();

  // -------- Room list ----------------------------------------------------
  const [rooms, setRooms] = createSignal<RoomSummary[] | null>(null);
  const [filter, setFilter] = createSignal('');
  // Room-list scope tabs. 'all' = everything joined, 'unread' = rooms with
  // a non-zero unread count, 'people' = direct messages only. Persisted so
  // the user's preferred lens survives a reload (Telegram-style folders).
  const [listScope, setListScope] = createSignal<'all' | 'unread' | 'people'>(
    (() => {
      try {
        const v = localStorage.getItem('mata:listScope');
        if (v === 'unread' || v === 'people') return v;
      } catch {
        /* private mode */
      }
      return 'all';
    })(),
  );
  const setScope = (s: 'all' | 'unread' | 'people') => {
    setListScope(s);
    try {
      localStorage.setItem('mata:listScope', s);
    } catch {
      /* private mode; non-fatal */
    }
  };
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Reactive per-room draft registry for the room-list "Draft:" preview.
  // localStorage itself isn't reactive and its native `storage` event
  // only fires cross-tab, so the room-view composer dispatches a
  // same-tab `mata:draft-change` CustomEvent on every write. We seed
  // from a one-time localStorage scan, then keep it live from both the
  // custom event (this tab) and the storage event (other tabs).
  const DRAFT_PREFIX = 'mata.draft.';
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const seedDrafts = () => {
    const next: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
        const text = localStorage.getItem(key) ?? '';
        if (text.trim()) next[key.slice(DRAFT_PREFIX.length)] = text;
      }
    } catch {
      /* localStorage unavailable */
    }
    setDrafts(next);
  };
  const applyDraft = (roomId: string, text: string) => {
    setDrafts((prev) => {
      const trimmed = (text ?? '').trim();
      if (!trimmed) {
        if (!(roomId in prev)) return prev;
        const { [roomId]: _drop, ...rest } = prev;
        return rest;
      }
      if (prev[roomId] === text) return prev;
      return { ...prev, [roomId]: text };
    });
  };
  // When the timeline's "Restore from backup" CTA opens settings, we
  // jump straight to the Encryption tab instead of the default Profile
  // tab — otherwise the user lands on the wrong panel and the click
  // feels like a no-op. Reset back to null when the drawer closes so a
  // subsequent manual ⚙️ open lands on Profile again.
  const [settingsInitialTab, setSettingsInitialTab] = createSignal<
    'profile' | 'appearance' | 'encryption' | 'devices' | null
  >(null);
  const [newRoomOpen, setNewRoomOpen] = createSignal(false);

  // ---- Invite accept/decline -------------------------------------------
  const [acting, setActing] = createSignal<Record<string, 'join' | 'leave'>>({});
  const respondToInvite = async (roomId: RoomId, action: 'join' | 'leave') => {
    if (acting()[roomId]) return;
    setActing({ ...acting(), [roomId]: action });
    try {
      if (action === 'join') {
        await bridge.request({ kind: 'joinRoom', roomId });
        showToast('success', 'Joined room');
      } else {
        await bridge.request({ kind: 'leaveRoom', roomId });
        showToast('info', 'Invite declined');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `${action === 'join' ? 'Join' : 'Decline'} failed: ${msg}`);
    } finally {
      const next = { ...acting() };
      delete next[roomId];
      setActing(next);
    }
  };

  // Sync state — surfaced as the rail's brand-square underline accent.
  const [syncState, setSyncState] = createSignal<string>('connecting');
  const [syncReason, setSyncReason] = createSignal<string>('');

  // ── Network-aware offline banner ──────────────────────────────────
  // Two independent signals compose the banner visibility:
  //   isNetworkOnline — browser's navigator.onLine, updated instantly
  //     by the window 'online'/'offline' events. This catches the pure
  //     "no network" case before the Matrix sync even retries.
  //   showOfflineBanner — true when the network is down OR when the
  //     sync worker reports 'reconnecting'/'error' after having been
  //     live (i.e. after first 'syncing' tick). We suppress during
  //     the initial boot window so transient DNS / crypto-init errors
  //     don't flash the strip while the app is still loading.
  const [isNetworkOnline, setIsNetworkOnline] = createSignal(navigator.onLine);
  const onlineHandler = () => setIsNetworkOnline(true);
  const offlineHandler = () => setIsNetworkOnline(false);
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', offlineHandler);
  onCleanup(() => {
    window.removeEventListener('online', onlineHandler);
    window.removeEventListener('offline', offlineHandler);
  });
  // Boot-settled signal local to the banner: flips true when we've
  // seen at least one 'syncing' tick, same gate as bootSettled toast
  // guard. Reuses the shared markBootSettled() call below.
  const [bannerBootSettled, setBannerBootSettled] = createSignal(false);
  const [showOfflineBanner, setShowOfflineBanner] = createSignal(false);

  onCleanup(
    bridge.on('syncStatus', (e) => {
      setSyncState(e.status);
      setSyncReason(e.reason ?? '');
      if (e.status === 'syncing') {
        markBootSettled();
        setBannerBootSettled(true);
        setShowOfflineBanner(false); // auto-dismiss on reconnect
      } else if (e.status === 'error' && e.reason) {
        showBootGuardedError(`Sync error: ${e.reason}`, 8000);
      }
    }),
  );
  // Show the banner when network goes offline or sync enters a
  // degraded state AFTER the app has successfully connected once.
  createEffect(() => {
    if (!isNetworkOnline()) {
      setShowOfflineBanner(true);
      return;
    }
    const st = syncState();
    if (bannerBootSettled() && (st === 'reconnecting' || st === 'error')) {
      setShowOfflineBanner(true);
    }
  });

  // Boot is split into TWO independent phases so the user sees their
  // familiar room list immediately, not after the worker finishes
  // rehydrating crypto + SQLite.
  //
  //   Phase 1 (cache paint) — fires on the very first effect run,
  //     regardless of session.phase. Reads the IndexedDB cache
  //     synchronously-ish (single keyval read) and paints whatever
  //     was there last time. No bridge calls. The worker can still
  //     be in 'restoring' while this happens — that's the point.
  //
  //   Phase 2 (live refetch) — only runs once the worker reports
  //     phase === 'authenticated'. This is where we hit the bridge,
  //     reconcile against live state, and start the syncUpdate
  //     listener taking over for incremental updates.
  //
  // This shape is what Element does and is the source of its
  // "chats appear instantly on reload" feel — the cached UI is
  // already on screen before the homeserver has even responded.
  let cachePainted = false;
  let liveBooted = false;
  createEffect(() => {
    const s = session();
    if (s.phase === 'anonymous') {
      navigate('/login', { replace: true });
      return;
    }
    if (!cachePainted) {
      cachePainted = true;
      void (async () => {
        const cached = await readRoomList();
        if (cached && !rooms()) setRooms(sortRooms(cached.rooms));
      })();
    }
    if (s.phase === 'authenticated' && !liveBooted) {
      liveBooted = true;
      void refetchRooms();
    }
  });

  const refetchRooms = async () => {
    try {
      const res = await bridge.request({ kind: 'loadRoomList' });
      const prev = rooms() ?? [];
      const merged = mergeRooms(prev, res.rooms);
      setRooms(merged);
      let u = 0, h = 0;
      for (const r of merged) {
        if (r.membership === 'join') {
          u += r.unreadCount;
          h += r.highlightCount;
        }
      }
      setRoomCounts({ unread: u, highlights: h });
      void writeRoomList(merged);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // `Not logged in` here is a transient race between the
      // auto-refetch effect (gated on session.phase ===
      // 'authenticated') and SdkSession finishing its restore.
      // The next syncUpdate or syncStatus tick will refetch
      // successfully. Showing a red pill in that window felt like
      // a logout/error to users. After boot settles, every
      // failure surfaces normally.
      showBootGuardedError(`Failed to load rooms: ${m}`);
    }
  };

  // Debounced room-list refresh: we only need to re-order the list when
  // a sync delta carries room metadata (name, unread, lastActivity). The
  // previous approach called refetchRooms() on EVERY syncUpdate — even
  // single-event live-message deltas — which flooded the worker with a
  // `loadRoomList` RPC for every new message, creating unnecessary
  // contention on busy rooms. 300ms is well within human-perceptible
  // latency for the room-list order updating, and far below the rate at
  // which individual messages arrive in normal chat.
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefetch = () => {
    if (refetchTimer !== null) return; // coalesce concurrent deltas
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void refetchRooms();
    }, 300);
  };
  onCleanup(() => {
    if (refetchTimer !== null) clearTimeout(refetchTimer);
  });

  // Live presence (online dot + "last seen") — latch every m.presence
  // ephemeral the worker forwards into the global presence store.
  onCleanup(mountPresence(bridge));

  onCleanup(
    bridge.on('syncUpdate', (e) => {
      scheduleRefetch();
      // ---- Room-correct live cache merge (data layer) ----------------
      // Merge every delta into ITS OWN room cache, not just the room
      // currently on screen. This is the fix for the "messages don't
      // show until refresh / appear in the wrong chat / duplicate on
      // send" class: events and send-echoes that arrive AFTER the user
      // switches rooms used to be written against the active room
      // (wrong cache) or dropped. We only touch caches that already
      // exist — a room the user has never opened loads fresh on open,
      // so there's nothing to keep live yet. The merge is idempotent
      // (dedupe by eventId, content-equality guard), so the reconcile
      // tail re-emitting the same events every tick is a no-op.
      for (const d of e.deltas) {
        if (d.newEvents.length === 0) continue;
        if (!caches[d.roomId]) continue;
        updateCache(d.roomId, (c) => {
          const merged = mergeEvents(c.events, d.newEvents);
          if (merged.mutated) c.events = merged.events;
          const keptPending = reconcilePending(c.pending, d.newEvents);
          if (keptPending !== c.pending) c.pending = keptPending;
        });
      }
      const me = (() => {
        const s = session();
        return s.phase === 'authenticated' ? s.userId : null;
      })();
      const roomById = new Map<RoomId, RoomSummary>();
      for (const r of rooms() ?? []) roomById.set(r.roomId, r);
      dispatchSyncDeltas({
        deltas: e.deltas,
        activeRoomId: activeId(),
        me,
        roomById,
        onClickRoom: (rid) => {
          const r = roomById.get(rid);
          if (r) openRoom(r);
        },
      });
    }),
  );

  // ---- Send-echo reconcile (data layer) --------------------------------
  // sendStatus now carries the target roomId, so we resolve the pending
  // bubble against the CORRECT room cache even when the user has
  // switched rooms before the echo lands. 'sent' records the canonical
  // eventId (the syncUpdate merge above then splices the pending entry
  // the moment the real event arrives — single-frame swap, no flash).
  // 'failed' flips the bubble to a retryable error state + toast.
  onCleanup(
    bridge.on('sendStatus', (e) => {
      if (!caches[e.roomId]) return;
      updateCache(e.roomId, (c) => {
        const { pending, failedReason } = applySendStatus(c.pending, e);
        if (pending !== c.pending) c.pending = pending;
        if (failedReason) showToast('error', `Send failed: ${failedReason}`);
      });
    }),
  );

  // -------- Active room + per-room cache --------------------------------
  // The activeId is persisted to localStorage so a hard refresh restores
  // the room the user was last looking at — the alternative (empty pane
  // after every refresh, "click your room again") is a friction point
  // even on a 60-room account. We also auto-select the top room on
  // first paint when nothing is persisted (matches Telegram Web /
  // Element web: app boots straight into a conversation).
  const LAST_ROOM_KEY = 'mata:lastRoomId';
  const [activeId, setActiveId] = createSignal<RoomId | null>(
    (() => {
      // A notification-click cold start lands on /?room=<id>. That target
      // wins over the persisted last room; we strip the param afterwards
      // so a later refresh doesn't keep re-forcing it.
      try {
        const fromUrl = new URLSearchParams(location.search).get('room');
        if (fromUrl) {
          try {
            localStorage.setItem(LAST_ROOM_KEY, fromUrl);
          } catch {
            /* private mode — non-fatal */
          }
          try {
            history.replaceState(null, '', location.pathname);
          } catch {
            /* ignore */
          }
          return fromUrl as RoomId;
        }
      } catch {
        /* no URL access — fall through to persisted room */
      }
      try {
        return (localStorage.getItem(LAST_ROOM_KEY) || null) as RoomId | null;
      } catch {
        return null;
      }
    })(),
  );

  // Warm-tab deep link: the SW posts `mata:navigate` when the user clicks
  // a push notification while a tab is already open. Switch to that room.
  onMount(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; roomId?: RoomId } | null;
      if (!d || d.type !== 'mata:navigate' || !d.roomId) return;
      const target = (rooms() ?? []).find((r) => r.roomId === d.roomId);
      if (target) openRoom(target);
      else setActiveId(d.roomId);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    onCleanup(() => navigator.serviceWorker.removeEventListener('message', onMsg));
  });
  const [caches, setCaches] = createStore<Record<string, RoomCache>>({});
  const updateCache = (roomId: RoomId, updater: (c: RoomCache) => void) => {
    setCaches(
      produce((state: Record<string, RoomCache>) => {
        if (!state[roomId]) state[roomId] = createRoomCache(roomId);
        updater(state[roomId]);
      }),
    );
  };

  const openRoom = (room: RoomSummary) => {
    if (!caches[room.roomId]) setCaches(room.roomId, createRoomCache(room.roomId));
    setActiveId(room.roomId);
    try {
      localStorage.setItem(LAST_ROOM_KEY, room.roomId);
    } catch {
      /* private mode; non-fatal */
    }
  };

  // Cross-room jump from global search: switch to the target room and
  // stash the event so the freshly-mounted RoomView scrolls to it.
  const [pendingJump, setPendingJump] = createSignal<EventId | null>(null);
  const jumpToRoom = (roomId: RoomId, eventId: EventId) => {
    const target = (rooms() ?? []).find((r) => r.roomId === roomId);
    if (target) openRoom(target);
    else setActiveId(roomId);
    navigate(`/rooms/${encodeURIComponent(roomId)}`);
    setPendingJump(eventId);
  };

  // Mark a room read straight from the list — no need to open it.
  // The worker resolves the room's newest live event, posts the read
  // receipt, and emits a zeroed-count delta so the badge clears at once.
  const markRoomRead = (roomId: RoomId) => {
    void bridge.request({ kind: 'markRoomRead', roomId }).catch(() => {
      /* best-effort — the badge will reconcile on the next sync */
    });
  };

  // ---- Room context menu (right-click on a room row) --------------------
  // Standard list affordances: mark read, mute/unmute, leave. Position is
  // captured from the pointer; RoomContextMenu clamps it into the viewport
  // and closes on outside-click / Escape / scroll.
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; room: RoomSummary } | null>(
    null,
  );
  const openRoomMenu = (e: MouseEvent, room: RoomSummary) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, room });
  };
  const toggleRoomMuted = (room: RoomSummary) => {
    const next = !room.isMuted;
    void bridge
      .request({ kind: 'setRoomMuted', roomId: room.roomId, muted: next })
      .then(() => showToast('info', next ? 'Muted' : 'Unmuted'))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        showToast('error', `Couldn't ${next ? 'mute' : 'unmute'}: ${msg}`);
      });
  };
  // Leave/delete flow uses a styled in-app confirm dialog (not the browser's
  // window.confirm) so the destructive action reads on-brand and the spinner
  // state is visible. `leaveTarget` drives the dialog; `leaving` guards the
  // button against double-fire while the RPC is in flight.
  const [leaveTarget, setLeaveTarget] = createSignal<RoomSummary | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  const leaveRoomConfirmed = (room: RoomSummary) => setLeaveTarget(room);
  const performLeave = () => {
    const room = leaveTarget();
    if (!room || leaving()) return;
    setLeaving(true);
    void bridge
      .request({ kind: 'leaveRoom', roomId: room.roomId })
      .then(() => {
        showToast('info', `Left "${room.name}"`);
        if (activeId() === room.roomId) {
          setActiveId(null);
          navigate('/');
        }
        setLeaveTarget(null);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        showToast('error', `Couldn't leave: ${msg}`);
      })
      .finally(() => setLeaving(false));
  };

  // Auto-select the top room on first paint. Two scenarios:
  //   (a) persisted activeId points at a room that's still in the list →
  //       just make sure it has a cache entry (already handled below
  //       via the activeRoom memo).
  //   (b) no activeId, or persisted id no longer exists (left room,
  //       account switch) → fall back to the top room by lastActivityTs
  //       so the app opens straight into the latest conversation, like
  //       Telegram Web does.
  let autoSelected = false;
  createEffect(() => {
    const list = rooms();
    if (!list || list.length === 0 || autoSelected) return;
    const joined = list.filter((r) => r.membership === 'join');
    if (joined.length === 0) return;
    const current = activeId();
    const stillThere = current && joined.some((r) => r.roomId === current);
    if (!stillThere) {
      // `joined` is pre-sorted by lastActivityTs desc via sortRooms.
      openRoom(joined[0]);
    } else if (current && !caches[current]) {
      setCaches(current, createRoomCache(current));
    }
    autoSelected = true;
  });

  const activeRoom = createMemo<RoomSummary | null>(() => {
    const id = activeId();
    if (!id) return null;
    return (rooms() ?? []).find((r) => r.roomId === id) ?? null;
  });

  // -------- Filtered & grouped list -------------------------------------
  const joinedRooms = (): RoomSummary[] =>
    (rooms() ?? []).filter((r) => r.membership === 'join');
  const invitedRooms = (): RoomSummary[] =>
    (rooms() ?? []).filter((r) => r.membership === 'invite');

  const filteredRooms = (): RoomSummary[] => {
    const q = filter().trim().toLowerCase();
    const scope = listScope();
    let list = joinedRooms();
    // Scope tab narrows the set before the text query is applied, so a
    // search inside "Unread" stays inside the unread subset.
    if (scope === 'unread') list = list.filter((r) => r.unreadCount > 0);
    else if (scope === 'people') list = list.filter((r) => r.type === 'direct');
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.topic ?? '').toLowerCase().includes(q) ||
        r.roomId.toLowerCase().includes(q),
    );
  };

  // -------- Top-bar message-content search ------------------------------
  // The search box doubles as a global message search (Telegram-style):
  // room-name matches render in the normal list, and message-body hits
  // across every room surface in a "Messages" section below. Same query,
  // two answers. The RPC is debounced and sequence-guarded so fast typing
  // doesn't fire a request per keystroke or let a stale response win.
  const [msgHits, setMsgHits] = createSignal<SearchHit[]>([]);
  const [msgSearching, setMsgSearching] = createSignal(false);
  let msgSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let msgSearchSeq = 0;

  createEffect(() => {
    const q = filter().trim();
    if (msgSearchTimer) clearTimeout(msgSearchTimer);
    if (q.length < 2) {
      setMsgHits([]);
      setMsgSearching(false);
      return;
    }
    setMsgSearching(true);
    const seq = ++msgSearchSeq;
    msgSearchTimer = setTimeout(() => {
      void bridge
        .request({ kind: 'searchMessages', query: q, roomId: null })
        .then((res) => {
          if (seq !== msgSearchSeq) return; // a newer query superseded us
          if (res.kind === 'searchMessages') setMsgHits(res.results.slice(0, 25));
        })
        .catch(() => {
          if (seq === msgSearchSeq) setMsgHits([]);
        })
        .finally(() => {
          if (seq === msgSearchSeq) setMsgSearching(false);
        });
    }, 280);
  });
  onCleanup(() => {
    if (msgSearchTimer) clearTimeout(msgSearchTimer);
  });

  // Human-readable room label for a message hit's room chip.
  const roomLabelFor = (id: RoomId): string =>
    (rooms() ?? []).find((r) => r.roomId === id)?.name || prettyName(id as never);

  // Total unread room count drives the badge on the "Unread" tab.
  const unreadRoomCount = createMemo(
    () => joinedRooms().filter((r) => r.unreadCount > 0).length,
  );

  // Direct/Rooms partition — DMs first, then named rooms.
  const directList = createMemo(() => filteredRooms().filter((r) => r.type === 'direct'));
  const roomsList = createMemo(() => filteredRooms().filter((r) => r.type !== 'direct'));

  // -------- Keyboard shortcuts ------------------------------------------
  // Flat, in-display-order room list (DMs first, then rooms) used for
  // keyboard navigation so Alt+↑/↓ walks exactly what the user sees,
  // honoring the active scope tab + search filter.
  const orderedRooms = createMemo(() => [...directList(), ...roomsList()]);

  // Step the selection by `delta` (-1 = up/prev, +1 = down/next) and
  // open the resulting room. Clamps at both ends; if nothing is active
  // yet, ↓ lands on the first room and ↑ on the last.
  const stepRoom = (delta: number) => {
    const list = orderedRooms();
    if (list.length === 0) return;
    const cur = activeId();
    const idx = cur ? list.findIndex((r) => r.roomId === cur) : -1;
    let next: number;
    if (idx === -1) {
      next = delta > 0 ? 0 : list.length - 1;
    } else {
      next = Math.min(list.length - 1, Math.max(0, idx + delta));
    }
    const target = list[next];
    if (target && target.roomId !== cur) {
      openRoom(target);
      // Keep the newly selected row in view within the scroller.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-room-id="${target.roomId}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const input = document.getElementById('mata-room-search') as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return;
    }
    // Alt+↑/↓ — previous / next chat (matches Telegram Web). Alt is a
    // chord so it never steals plain arrow keys from the composer or
    // the search box.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      stepRoom(e.key === 'ArrowDown' ? 1 : -1);
    }
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // Draft-preview registry: seed once, then track same-tab composer
  // writes and cross-tab storage changes.
  onMount(() => {
    seedDrafts();
    const onDraftChange = (e: Event) => {
      const detail = (e as CustomEvent<{ roomId: string; text: string }>).detail;
      if (detail?.roomId) applyDraft(detail.roomId, detail.text);
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith(DRAFT_PREFIX)) return;
      applyDraft(e.key.slice(DRAFT_PREFIX.length), e.newValue ?? '');
    };
    window.addEventListener('mata:draft-change', onDraftChange);
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('mata:draft-change', onDraftChange);
      window.removeEventListener('storage', onStorage);
    });
  });

  // -------- Derived bits for the me-bar ---------------------------------
  const myId = () => {
    const s = session();
    return s.phase === 'authenticated' ? s.userId : '';
  };
  const myHandle = () => {
    const id = myId();
    return id;
  };
  const myName = () => {
    const id = myId();
    if (!id) return '';
    const m = id.match(/^@([^:]+):/);
    return m ? m[1] : id;
  };
  const homeserverLabel = () => {
    const id = myId();
    const m = id.match(/^@[^:]+:(.+)$/);
    return m ? m[1] : 'matrix.org';
  };

  return (
    <>
    <UpdateBanner />
    <div class="grid h-full min-h-0 w-full grid-cols-[296px_1fr] bg-app">
      {/* -------- Room list column (296px) ----------------------------
          The decorative 64px workspace rail was removed in 21:53 push —
          Mata is single-account by scope (msg-Fq9gvzU1xNzXw55k). The
          rail's only functional control (Settings) now lives in MeBar.
          Brand mark + sync state were already mirrored in the list
          header ("mata /personal" wordmark) and MeBar avatar dot, so
          nothing user-facing was lost. ------------------------------ */}
      <aside
        class="flex h-full min-h-0 flex-col border-r bg-list"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        {/* Header */}
        <header
          class="flex items-center justify-between px-[18px] pb-[12px] pt-[18px]"
        >
          <div class="flex items-baseline gap-1">
            <span
              class="text-[19px] leading-none text-fg"
              style={{ 'font-weight': 500, 'letter-spacing': '-0.025em' }}
            >
              mata
            </span>
            <span class="mono text-[10.5px] text-fg-4" style={{ position: 'relative', top: '-1px' }}>
              /secure chat
            </span>
          </div>
          <span
            class="mono rounded-[4px] border px-1.5 py-[3px] text-[10px] text-fg-3"
            style={{ 'border-color': 'var(--color-line)' }}
            title="Home server"
          >
            {homeserverLabel()}
          </span>
        </header>

        {/* Search */}
        <div class="px-[14px] pb-2">
          <div
            class="relative flex items-center gap-2 rounded-[8px] border bg-input px-[10px] py-[7px]"
            style={{ 'border-color': 'var(--color-line)' }}
          >
            <IconSearch class="h-[13px] w-[13px] text-fg-3" />
            <input
              id="mata-room-search"
              type="text"
              placeholder="Search chats & messages…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-3 focus:outline-none"
            />
            <span
              class="mono rounded-[4px] border px-1 py-[1px] text-[10px] text-fg-4"
              style={{ 'border-color': 'var(--color-line)' }}
            >
              ⌘K
            </span>
          </div>
        </div>

        {/* Scope tabs — All / Unread / People. Telegram-style chat lens. */}
        <div class="flex items-center gap-1 px-[14px] pb-2">
          <For
            each={
              [
                { key: 'all', label: 'All' },
                { key: 'unread', label: 'Unread' },
                { key: 'people', label: 'People' },
              ] as { key: 'all' | 'unread' | 'people'; label: string }[]
            }
          >
            {(tab) => {
              const isActive = () => listScope() === tab.key;
              return (
                <button
                  type="button"
                  onClick={() => setScope(tab.key)}
                  class="flex items-center gap-1.5 rounded-[7px] px-2.5 py-[5px] text-[12px] transition-colors"
                  style={{
                    background: isActive() ? 'var(--color-elev)' : 'transparent',
                    color: isActive() ? 'var(--color-fg)' : 'var(--color-fg-3)',
                    'font-weight': isActive() ? 500 : 400,
                  }}
                >
                  {tab.label}
                  <Show when={tab.key === 'unread' && unreadRoomCount() > 0}>
                    <span
                      class="mono inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] leading-[15px]"
                      style={{
                        background: 'var(--color-accent)',
                        color: 'var(--color-accent-ink)',
                      }}
                    >
                      {unreadRoomCount() > 99 ? '99+' : unreadRoomCount()}
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>

        {/* Pending invites — minimal sleeve, sized to count */}
        <Show when={invitedRooms().length > 0}>
          <section class="px-[14px] pt-2">
            <SectionLabel
              label="Invites"
              count={invitedRooms().length}
              tone="warn"
            />
            <ul class="space-y-1.5">
              <For each={invitedRooms()}>
                {(r) => (
                  <InviteRow
                    room={r}
                    pending={acting()[r.roomId]}
                    onAction={(action) => respondToInvite(r.roomId, action)}
                  />
                )}
              </For>
            </ul>
          </section>
        </Show>

        {/* Joined rooms — partitioned by type */}
        <Show
          when={joinedRooms().length > 0}
          fallback={
            <Show
              when={rooms() !== null}
              fallback={<RoomListSkeleton />}
            >
              <div class="flex flex-1 items-center justify-center p-6 text-center">
                <span class="mono text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
                  No rooms yet
                </span>
              </div>
            </Show>
          }
        >
          <div class="flex-1 overflow-y-auto pb-2">
            <Show when={directList().length > 0}>
              <SectionLabel label="Direct" count={directList().length} class="mt-3" />
              <ul class="px-[10px]">
                <For each={directList()}>
                  {(room) => (
                    <RoomRow
                      room={room}
                      active={activeId() === room.roomId}
                      onSelect={() => openRoom(room)}
                      onMarkRead={() => markRoomRead(room.roomId)}
                      onContextMenu={(e) => openRoomMenu(e, room)}
                      callBusyHere={activeCall()?.roomId === room.roomId}
                      draftText={drafts()[room.roomId]}
                      myId={myId()}
                    />
                  )}
                </For>
              </ul>
            </Show>
            <Show when={roomsList().length > 0}>
              <SectionLabel label="Rooms" count={roomsList().length} class="mt-4" />
              <ul class="px-[10px]">
                <For
                  each={roomsList()}
                  fallback={
                    <li class="px-3 py-2 text-[12px] text-fg-4">No rooms match</li>
                  }
                >
                  {(room) => (
                    <RoomRow
                      room={room}
                      active={activeId() === room.roomId}
                      onSelect={() => openRoom(room)}
                      onMarkRead={() => markRoomRead(room.roomId)}
                      onContextMenu={(e) => openRoomMenu(e, room)}
                      callBusyHere={activeCall()?.roomId === room.roomId}
                      draftText={drafts()[room.roomId]}
                      myId={myId()}
                    />
                  )}
                </For>
              </ul>
            </Show>
            {/* Empty result — a scope tab or search filtered everything out
                even though the account does have joined rooms. Suppressed
                when a search is active and message hits exist, so the
                "Messages" section below stands on its own. */}
            <Show
              when={
                directList().length === 0 &&
                roomsList().length === 0 &&
                !(filter().trim().length >= 2 && msgHits().length > 0)
              }
            >
              <div class="px-4 py-8 text-center">
                <span class="mono text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
                  {listScope() === 'unread'
                    ? 'All caught up'
                    : filter().trim()
                      ? 'No rooms match'
                      : 'Nothing here'}
                </span>
              </div>
            </Show>

            {/* Messages — global message-content search results. Only
                while a query is active. Clicking a hit jumps to that
                room and scrolls to the event, then clears the search. */}
            <Show when={filter().trim().length >= 2}>
              <div class="mt-3">
                <SectionLabel label="Messages" count={msgHits().length} />
                <Show
                  when={msgHits().length > 0}
                  fallback={
                    <div class="px-4 py-3 text-[11.5px] text-fg-4">
                      {msgSearching() ? 'Searching messages…' : 'No messages found'}
                    </div>
                  }
                >
                  <ul class="px-[10px]">
                    <For each={msgHits()}>
                      {(hit) => (
                        <li>
                          <button
                            type="button"
                            onClick={() => {
                              jumpToRoom(hit.roomId, hit.eventId);
                              setFilter('');
                            }}
                            class="flex w-full items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-elev"
                          >
                            <span
                              class="mt-[1px] flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
                              style={{ background: gradientForUser(hit.sender) }}
                            >
                              {initials(hit.sender)}
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="flex items-baseline justify-between gap-2">
                                <span class="truncate text-[12px] font-medium text-fg">
                                  {prettyName(hit.sender)}
                                </span>
                                <span class="shrink-0 truncate text-[10px] text-fg-4">
                                  {roomLabelFor(hit.roomId)}
                                </span>
                              </span>
                              <span class="mt-0.5 block truncate text-[11.5px] text-fg-3">
                                {hit.body}
                              </span>
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

        {/* Me-bar (sticky bottom) */}
        <MeBar
          name={myName()}
          handle={myHandle()}
          syncState={syncState()}
          syncReason={syncReason()}
          onNewRoom={() => setNewRoomOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      </aside>

      {/* -------- Conversation column ---------------------------------- */}
      <div class="flex min-h-0 flex-col bg-conv">
        {/* Offline / reconnecting banner — spans full conv column,
            auto-hides when sync returns to 'syncing'. Only shown
            after the app has successfully connected at least once so
            the initial boot connecting state doesn't trigger it. */}
        <Show when={showOfflineBanner()}>
          <OfflineBanner
            online={isNetworkOnline()}
            syncState={syncState()}
            onDismiss={() => setShowOfflineBanner(false)}
          />
        </Show>
        <Show
          when={activeRoom()}
          fallback={<EmptyConv />}
        >
          {(room) => {
            if (!caches[room().roomId]) {
              setCaches(room().roomId, createRoomCache(room().roomId));
            }
            return (
              <RoomView
                room={room()}
                cache={caches[room().roomId]}
                setCache={updateCache}
                rooms={joinedRooms()}
                onOpenEncryptionSettings={() => {
                  setSettingsInitialTab('encryption');
                  setSettingsOpen(true);
                }}
                onJumpToRoom={jumpToRoom}
                pendingJumpEventId={pendingJump()}
                onPendingJumpConsumed={() => setPendingJump(null)}
                onRoomUnavailable={(rid) => {
                  // Drop the stale list entry locally so the user
                  // doesn't immediately click it again, then refetch
                  // against live SDK state — that pass authoritatively
                  // reconciles what actually exists server-side.
                  setRooms((rs) => (rs ?? []).filter((r) => r.roomId !== rid));
                  setActiveId(null);
                  void refetchRooms();
                }}
              />
            );
          }}
        </Show>
      </div>

      <SettingsDrawer
        open={settingsOpen()}
        initialTab={settingsInitialTab()}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsInitialTab(null);
        }}
      />
      <NewRoomModal
        open={newRoomOpen()}
        onClose={() => setNewRoomOpen(false)}
        rooms={rooms()}
        myUserId={(myId() || null) as UserId | null}
        onCreated={(roomId) => {
          navigate(`/rooms/${encodeURIComponent(roomId)}`);
          setActiveId(roomId);
        }}
      />
      <RoomContextMenu
        state={ctxMenu()}
        onClose={() => setCtxMenu(null)}
        onMarkRead={(room) => markRoomRead(room.roomId)}
        onToggleMute={toggleRoomMuted}
        onLeave={leaveRoomConfirmed}
      />
      <Show when={leaveTarget()}>
        {(room) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => !leaving() && setLeaveTarget(null)}
            role="presentation"
          >
            <div
              role="dialog"
              aria-label="Leave room"
              class="w-full max-w-sm rounded-xl border border-line bg-elev p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 class="text-base font-semibold text-fg-1">Leave “{room().name}”?</h2>
              <p class="mt-2 text-[13px] leading-relaxed text-fg-2">
                You'll stop receiving messages from this conversation and it will be
                removed from your chat list. You can rejoin later if you're invited or
                the room is public.
              </p>
              <div class="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={leaving()}
                  onClick={() => setLeaveTarget(null)}
                  class="rounded-lg border border-line px-3.5 py-1.5 text-sm font-medium text-fg-2 transition-colors hover:bg-input disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={leaving()}
                  onClick={performLeave}
                  class="rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                >
                  {leaving() ? 'Leaving…' : 'Leave room'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
    </>
  );
}

/* =========================================================================
   Section label
   ========================================================================= */

function SectionLabel(props: { label: string; count?: number; tone?: 'warn'; class?: string }) {
  return (
    <div
      class={`flex items-baseline justify-between px-[14px] pb-[6px] pt-[14px] ${props.class ?? ''}`}
    >
      <span
        class="mono text-[10.5px] uppercase tracking-[0.08em]"
        style={{ color: props.tone === 'warn' ? 'var(--color-warn)' : 'var(--color-fg-4)' }}
      >
        {props.label}
      </span>
      <Show when={props.count !== undefined}>
        <span class="mono text-[10.5px] text-fg-4">{props.count}</span>
      </Show>
    </div>
  );
}

/* =========================================================================
   Room list skeleton — boot-time placeholder while we wait for the worker
   to come up and first /sync to land. Mirrors the RoomRow grid geometry
   (22px leader · 1fr name · auto meta, py-[7px]) so the real rows slot in
   at identical positions when they arrive — no layout shift, no flash.

   Per design motion rule (global.css §Motion: "only the composer e2ee dot
   pulses"), this is STATIC — no shimmer, no opacity animation. We fake
   depth with a per-row opacity falloff so the list visually "trails off"
   the way Telegram's loading list does, without breaking the motion
   contract.
   ========================================================================= */
function RoomListSkeleton() {
  // Pseudo-random but deterministic width variance so the bars don't all
  // line up to the same edge — looks like real names of varying length.
  const rows = [0, 1, 2, 3, 4, 5, 6, 7];
  const widthFor = (i: number) => 48 + ((i * 19 + 7) % 38); // 48–86%
  return (
    <div class="flex-1 overflow-hidden pt-[14px]" aria-hidden="true">
      <ul class="px-[10px]">
        <For each={rows}>
          {(i) => (
            <li
              class="grid grid-cols-[22px_1fr_auto] items-center gap-[10px] rounded-[7px] px-[10px] py-[7px]"
              style={{ opacity: Math.max(0.18, 1 - i * 0.11) }}
            >
              <span
                class="h-[10px] w-[10px] rounded-full"
                style={{ background: 'var(--color-elev)' }}
              />
              <span
                class="h-[10px] rounded-[3px]"
                style={{
                  width: `${widthFor(i)}%`,
                  background: 'var(--color-elev)',
                }}
              />
              <span
                class="h-[8px] w-[26px] rounded-[3px]"
                style={{ background: 'var(--color-elev)' }}
              />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/* =========================================================================
   Room context menu — right-click on a room row
   ========================================================================= */

function RoomContextMenu(props: {
  state: { x: number; y: number; room: RoomSummary } | null;
  onClose: () => void;
  onMarkRead: (room: RoomSummary) => void;
  onToggleMute: (room: RoomSummary) => void;
  onLeave: (room: RoomSummary) => void;
}) {
  const MENU_W = 196;
  const MENU_H = 150;
  // Clamp the pointer position so the menu never overflows the viewport.
  const pos = () => {
    const s = props.state;
    if (!s) return { left: 8, top: 8 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: Math.max(8, Math.min(s.x, vw - MENU_W - 8)),
      top: Math.max(8, Math.min(s.y, vh - MENU_H - 8)),
    };
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <Show when={props.state}>
      {(s) => (
        <Portal>
          {/* Full-screen catcher: any click / right-click / scroll dismisses. */}
          <div
            class="fixed inset-0 z-[200]"
            onClick={props.onClose}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onClose();
            }}
            onWheel={props.onClose}
          >
            <div
              class="absolute min-w-[196px] overflow-hidden rounded-[10px] border py-1 shadow-xl"
              style={{
                left: `${pos().left}px`,
                top: `${pos().top}px`,
                'border-color': 'var(--color-line)',
                background: 'var(--color-elev)',
                'box-shadow': '0 8px 28px rgba(0,0,0,0.32)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="truncate px-3 py-1.5 text-[11px] text-fg-4">{s().room.name}</div>
              <div class="mb-1 h-px" style={{ background: 'var(--color-line)' }} />
              <button
                type="button"
                disabled={s().room.unreadCount === 0}
                onClick={() => {
                  props.onMarkRead(s().room);
                  props.onClose();
                }}
                class="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] text-fg-2 transition-colors hover:bg-[var(--color-list)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13.5 4.5L6 12L2.5 8.5" />
                </svg>
                Mark as read
              </button>
              <button
                type="button"
                onClick={() => {
                  props.onToggleMute(s().room);
                  props.onClose();
                }}
                class="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] text-fg-2 transition-colors hover:bg-[var(--color-list)]"
              >
                <Show
                  when={s().room.isMuted}
                  fallback={
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M5 6a3 3 0 0 1 6 0c0 3 1.2 4 1.2 4H3.8S5 9 5 6Z" />
                      <path d="M6.6 12.5a1.6 1.6 0 0 0 2.8 0" />
                    </svg>
                  }
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 6a3 3 0 0 1 6 0c0 3 1.2 4 1.2 4H3.8S5 9 5 6Z" />
                    <path d="M6.6 12.5a1.6 1.6 0 0 0 2.8 0" />
                    <path d="M2 2l12 12" />
                  </svg>
                </Show>
                {s().room.isMuted ? 'Unmute' : 'Mute notifications'}
              </button>
              <div class="my-1 h-px" style={{ background: 'var(--color-line)' }} />
              <button
                type="button"
                onClick={() => {
                  props.onLeave(s().room);
                  props.onClose();
                }}
                class="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] transition-colors hover:bg-[var(--color-list)]"
                style={{ color: 'var(--color-danger)' }}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6" />
                  <path d="M10.5 11L14 7.5L10.5 4" />
                  <path d="M14 7.5H6" />
                </svg>
                Leave room
              </button>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/* =========================================================================
   Room row — design-spec layout: leader glyph · name (+ federated suffix) · meta
   ========================================================================= */

function RoomRow(props: {
  room: RoomSummary;
  active: boolean;
  onSelect: () => void;
  onMarkRead: () => void;
  onContextMenu: (e: MouseEvent) => void;
  callBusyHere: boolean;
  draftText?: string;
  myId: string;
}) {
  const r = props.room;
  const isUnread = () => r.unreadCount > 0;
  const isHighlight = () => r.highlightCount > 0;
  const isMuted = () => r.isMuted;
  // Collapse newlines so a multi-line draft stays a single tidy row.
  const draftPreview = () => (props.draftText ?? '').replace(/\s+/g, ' ').trim();
  const hasDraft = () => draftPreview().length > 0;

  return (
    <li class="group relative" data-room-id={r.roomId} onContextMenu={props.onContextMenu}>
      {/* Active rail */}
      <Show when={props.active}>
        <span
          class="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-r-[2px]"
          style={{ background: 'var(--color-accent)' }}
        />
      </Show>
      {/* Mark-as-read affordance — revealed on row hover, only for rooms
          that actually have unread messages. Sits above the meta column
          (absolute, outside the row button so we don't nest buttons).
          Clicking clears the room without opening it. */}
      <Show when={isUnread() && !isMuted()}>
        <button
          type="button"
          title="Mark as read"
          aria-label="Mark as read"
          onClick={(e) => {
            // Don't let the click bubble to the row's onSelect.
            e.stopPropagation();
            props.onMarkRead();
          }}
          class="absolute right-[8px] top-1/2 z-10 hidden h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-[6px] text-fg-3 opacity-0 transition-opacity hover:bg-elev hover:text-fg group-hover:flex group-hover:opacity-100"
          style={{ background: 'var(--color-list)' }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13.5 4.5L6 12L2.5 8.5" />
          </svg>
        </button>
      </Show>
      <button
        type="button"
        onClick={props.onSelect}
        class="row-vis grid w-full grid-cols-[22px_1fr_auto] items-center gap-[10px] rounded-[7px] px-[10px] py-[7px] text-left transition-colors hover:bg-elev"
        style={{
          background: props.active ? 'var(--color-elev)' : 'transparent',
        }}
      >
        {/* Leader column */}
        <span class="flex h-[22px] w-[22px] items-center justify-center">
          <Show
            when={r.type === 'direct'}
            fallback={
              <span
                class="text-[14px] leading-none"
                style={{
                  color: props.active || isUnread() ? 'var(--color-fg)' : 'var(--color-fg-4)',
                  'font-weight': 400,
                }}
              >
                #
              </span>
            }
          >
            <span class="dot-accent" style={{ opacity: 0.85 }} title="DM" />
          </Show>
        </span>

        {/* Name (+ draft preview line) */}
        <span class="flex min-w-0 flex-col">
          <span
            class="min-w-0 truncate text-[13.5px]"
            style={{
              color: isMuted()
                ? 'var(--color-fg-4)'
                : props.active || isUnread()
                  ? 'var(--color-fg)'
                  : 'var(--color-fg-2)',
              'font-weight': isUnread() && !isMuted() ? 500 : 400,
            }}
          >
            {r.name}
            <Show when={isMuted()}>
              <span class="ml-1 text-fg-4" title="Muted">
                🔕
              </span>
            </Show>
            <Show when={props.callBusyHere}>
              <span class="ml-1.5 inline-flex items-center text-[10px] text-accent" title="Call in progress">
                ●
              </span>
            </Show>
          </span>
          {/* Unsent draft — Telegram-style red "Draft:" prefix. */}
          <Show when={hasDraft()}>
            <span class="min-w-0 truncate text-[11px] leading-[15px]">
              <span style={{ color: 'var(--color-danger)' }}>Draft: </span>
              <span class="text-fg-3">{draftPreview()}</span>
            </span>
          </Show>
        </span>

        {/* Meta */}
        <span
          class="mono shrink-0 text-[10.5px]"
          style={{
            color: isMuted()
              ? 'var(--color-fg-4)'
              : isUnread() && !isMuted()
                ? 'var(--color-accent)'
                : 'var(--color-fg-4)',
          }}
        >
          <Show
            when={isUnread() && !isMuted()}
            fallback={listTime(r.lastActivityTs)}
          >
            <Show
              when={isHighlight()}
              fallback={`${r.unreadCount > 99 ? '99+' : r.unreadCount} new`}
            >
              <span style={{ color: 'var(--color-danger)' }}>
                {r.unreadCount > 99 ? '99+' : r.unreadCount} new
              </span>
            </Show>
          </Show>
        </span>
      </button>
    </li>
  );
}

/* =========================================================================
   Invite row
   ========================================================================= */

function InviteRow(props: {
  room: RoomSummary;
  pending: 'join' | 'leave' | undefined;
  onAction: (action: 'join' | 'leave') => void;
}) {
  const r = props.room;
  return (
    <li
      class="flex items-center gap-2 rounded-[8px] border px-[10px] py-[7px]"
      style={{ 'border-color': 'var(--color-line)', background: 'var(--color-elev)' }}
    >
      <div
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[10px]"
        style={{
          background: gradientForUser(r.roomId).background,
          color: gradientForUser(r.roomId).color,
          'font-weight': 600,
        }}
      >
        {initials(r.name || r.roomId)}
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[12.5px] text-fg" style={{ 'font-weight': 500 }}>
          {r.name || r.roomId}
        </div>
        <Show when={r.topic}>
          <div class="truncate text-[10.5px] text-fg-3">{r.topic}</div>
        </Show>
      </div>
      <button
        type="button"
        onClick={() => props.onAction('join')}
        disabled={!!props.pending}
        class="mono rounded-[5px] bg-accent px-2 py-[3px] text-[10px] text-accent-ink hover:brightness-95 disabled:opacity-50"
        style={{ 'font-weight': 600 }}
      >
        {props.pending === 'join' ? '…' : 'Accept'}
      </button>
      <button
        type="button"
        onClick={() => props.onAction('leave')}
        disabled={!!props.pending}
        class="mono rounded-[5px] border px-2 py-[3px] text-[10px] text-fg-2 hover:bg-elev disabled:opacity-50"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        {props.pending === 'leave' ? '…' : 'Decline'}
      </button>
    </li>
  );
}

/* =========================================================================
   Me-bar
   ========================================================================= */

function MeBar(props: {
  name: string;
  handle: string;
  syncState: string;
  syncReason?: string;
  onNewRoom: () => void;
  onSettings: () => void;
}) {
  // Map raw sync state → user-readable status + visible color. The MeBar
  // status dot is now the ONLY sync surface (the rail's SyncDot was
  // removed in the 21:53 push). We previously hardcoded the accent color
  // regardless of state, which silently hid disconnected/error/reconnect
  // signals from the user.
  const status = () => {
    switch (props.syncState) {
      case 'syncing':
        return { color: 'var(--color-accent)', pulse: false, label: 'Synced' };
      case 'error':
        return { color: 'var(--color-danger)', pulse: false, label: 'Sync error' };
      case 'reconnecting':
      case 'connecting':
        return { color: 'var(--color-warn)', pulse: true, label: props.syncState };
      default:
        return { color: 'var(--color-fg-4)', pulse: false, label: 'Idle' };
    }
  };
  return (
    <footer
      class="grid grid-cols-[28px_1fr_auto_auto] items-center gap-[8px] border-t bg-list px-[14px] py-[10px]"
      style={{ 'border-color': 'var(--color-line)' }}
    >
      <div class="relative">
        <div
          class="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] text-[11px]"
          style={{
            background: 'linear-gradient(135deg, #c8f64d, #98c233)',
            color: '#0a0a0b',
            'font-weight': 600,
          }}
        >
          {initials(props.name || '?')}
        </div>
        <span
          class={`absolute -bottom-0.5 -right-0.5 h-[9px] w-[9px] rounded-full ${status().pulse ? 'mata-pulse' : ''}`}
          style={{
            background: status().color,
            'box-shadow': '0 0 0 2px var(--color-list)',
          }}
          title={`${status().label}${props.syncReason ? ` · ${props.syncReason}` : ''}`}
          aria-label={status().label}
        />
      </div>
      <div class="min-w-0">
        <div class="truncate text-[13px] text-fg" style={{ 'font-weight': 500 }}>
          {props.name || 'You'}
        </div>
        <div class="mono truncate text-[10.5px] text-fg-4">{props.handle}</div>
      </div>
      <button
        type="button"
        onClick={props.onSettings}
        class="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-3 hover:bg-elev hover:text-fg"
        aria-label="Settings"
        title="Settings"
      >
        <IconSettings class="h-[14px] w-[14px]" />
      </button>
      <button
        type="button"
        onClick={props.onNewRoom}
        class="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-fg-3 hover:bg-elev hover:text-fg"
        aria-label="New conversation"
        title="New conversation"
      >
        <IconPlus class="h-[14px] w-[14px]" />
      </button>
    </footer>
  );
}

/* =========================================================================
   Empty state
   ========================================================================= */

function EmptyConv() {
  return (
    <section class="flex flex-1 items-center justify-center p-12 text-center">
      <div class="space-y-3">
        <div class="mx-auto h-10 w-10 text-fg-3">
          <Mark size="display" />
        </div>
        <div class="text-[14px] text-fg" style={{ 'font-weight': 500 }}>
          Pick a conversation
        </div>
        <div class="mono text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
          ⌘K to jump · click any room
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   Icons — small, stroked, currentColor (Lucide-equivalent paths)
   ========================================================================= */

function IconSearch(props: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={props.class}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function IconSettings(props: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={props.class}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconPlus(props: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={props.class}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/* =========================================================================
   Helpers
   ========================================================================= */

function sortRooms(list: RoomSummary[]): RoomSummary[] {
  return [...list].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
}

function mergeRooms(prev: RoomSummary[], next: RoomSummary[]): RoomSummary[] {
  const byId = new Map(prev.map((r) => [r.roomId, r]));
  const out = next.map((nr) => {
    const old = byId.get(nr.roomId);
    return old && shallowRoomEqual(old, nr) ? old : nr;
  });
  return sortRooms(out);
}

function shallowRoomEqual(a: RoomSummary, b: RoomSummary): boolean {
  return (
    a.roomId === b.roomId &&
    a.name === b.name &&
    a.topic === b.topic &&
    a.type === b.type &&
    a.isEncrypted === b.isEncrypted &&
    // Membership + mute must be in the equality gate — see commit 102e341
    // for the long form. Invite→join transitions otherwise leave the old
    // object reference in place and the membership filter keeps showing
    // a stale invite even after Accept succeeded.
    a.membership === b.membership &&
    a.isMuted === b.isMuted &&
    a.unreadCount === b.unreadCount &&
    a.highlightCount === b.highlightCount &&
    a.lastActivityTs === b.lastActivityTs &&
    a.lastEventPreview === b.lastEventPreview
  );
}

// ── OfflineBanner ────────────────────────────────────────────────────────────
/**
 * Non-intrusive strip shown at the top of the conversation column when
 * the network drops or the Matrix sync enters a degraded state after
 * having been live at least once. Auto-dismisses on reconnect (when
 * syncState returns to 'syncing' the Show gate is cleared by the parent).
 * Manual dismiss via the × keeps it hidden for the rest of the session
 * (the parent's showOfflineBanner signal gates the Show).
 *
 * Design: amber-toned so it reads as "warning but not fatal", 8px
 * rounded corners, dismissible ×. Uses --color-warn token from the
 * Mata design system.
 */
function OfflineBanner(props: {
  online: boolean;
  syncState: string;
  onDismiss: () => void;
}) {
  const message = () => {
    if (!props.online) return 'No internet connection — messages won\'t send or arrive.';
    if (props.syncState === 'reconnecting') return 'Reconnecting to your server…';
    return 'Connection lost — retrying…';
  };

  const isReconnecting = () =>
    props.syncState === 'reconnecting' || !props.online;

  return (
    <div
      role="status"
      aria-live="polite"
      class="flex items-center gap-2 border-b px-4 py-2 text-[12px]"
      style={{
        background: 'color-mix(in oklab, var(--color-warn) 12%, var(--color-conv))',
        'border-color': 'color-mix(in oklab, var(--color-warn) 30%, transparent)',
        color: 'var(--color-fg)',
      }}
    >
      {/* Animated dot — pulsing while reconnecting, steady while offline */}
      <span
        class={`inline-block h-[7px] w-[7px] rounded-full flex-shrink-0 ${isReconnecting() ? 'mata-pulse' : ''}`}
        style={{ background: 'var(--color-warn)' }}
        aria-hidden="true"
      />
      <span class="flex-1">{message()}</span>
      <button
        type="button"
        onClick={props.onDismiss}
        class="ml-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" />
        </svg>
      </button>
    </div>
  );
}
