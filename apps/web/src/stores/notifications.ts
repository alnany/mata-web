// =============================================================================
// notifications.ts — central notification dispatcher
//
// Responsibilities (kept deliberately UI-side, NOT in the worker):
//   1. Track browser Notification permission and let the UI request it
//      lazily on the first user-meaningful gesture (settings toggle).
//   2. Maintain a single user preference flag (enabled / disabled),
//      persisted in localStorage so refresh preserves choice.
//   3. Maintain "window focused" state via document visibility +
//      window blur/focus listeners. Notifications only fire when the
//      window is NOT focused, OR when the user is focused but the
//      event is for a non-active room AND it's a mention.
//   4. Provide a `dispatchMessageEvent` helper that the home route
//      calls for every new event delta. The helper decides whether to:
//        - Play the chime (mentions / non-active room messages)
//        - Show a desktop Notification
//        - Update the unread/highlight tally exposed to the tab title
//   5. Provide derived unread/highlight totals that the App component
//      uses to mutate `document.title`.
//
// We intentionally do NOT use the Matrix-spec PushProcessor here: that
// would require running the rules engine on every event, including
// state events and reactions. Our notification surface only cares
// about message events; for the (current, small) feature set, the
// mention + non-active-room heuristic is the right tradeoff between
// signal and complexity. A worker-side PushProcessor pass is the next
// step when we want HA push (server-side notify decisions for offline
// delivery).
// =============================================================================

import { createSignal } from 'solid-js';
import type {
  RoomDelta,
  RoomId,
  RoomMessageEvent,
  RoomSummary,
  TimelineEvent,
  UserId,
} from '@mata/shared/matrix';

const STORAGE_KEY = 'mata.notify.enabled.v1';

// Default: opt-in. We require an explicit toggle so the first
// permission prompt happens from a user-initiated click, which is the
// only path that browsers reliably allow.
const loadEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const [enabled, setEnabledRaw] = createSignal(loadEnabled());

// totalUnread / totalHighlights are exposed so App can drive the tab
// title. Both reset to zero when the user clicks back into the tab
// (focus listener below) — we treat "user saw the tab again" as
// "they've seen the new messages". A more correct version would per-
// room mark-as-read; that ships later as part of read receipts work.
const [totalUnread, setTotalUnread] = createSignal(0);
const [totalHighlights, setTotalHighlights] = createSignal(0);
const [permission, setPermission] = createSignal<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
);
const [windowFocused, setWindowFocused] = createSignal(
  typeof document !== 'undefined' ? document.hasFocus() : true,
);

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    setWindowFocused(true);
    setTotalUnread(0);
    setTotalHighlights(0);
  });
  window.addEventListener('blur', () => setWindowFocused(false));
  document.addEventListener('visibilitychange', () => {
    setWindowFocused(!document.hidden);
    if (!document.hidden) {
      setTotalUnread(0);
      setTotalHighlights(0);
    }
  });
}

export const notifyEnabled = enabled;
export const notifyPermission = permission;
export const notifyTotals = { unread: totalUnread, highlights: totalHighlights };
export const isWindowFocused = windowFocused;

/**
 * Toggle the user preference, requesting Notification permission on
 * activation if it hasn't been granted yet. The browser denies
 * permission requests that come from anywhere except a user gesture,
 * so the caller must wire this to a click handler.
 */
export async function setNotifyEnabled(next: boolean): Promise<void> {
  if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== 'granted') {
        setEnabledRaw(false);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* storage may be disabled */
        }
        return;
      }
    } catch {
      // Permission API failure — bail without flipping the flag.
      return;
    }
  }
  setEnabledRaw(next);
  try {
    if (next) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ---- audio chime --------------------------------------------------------
// Tiny in-browser WebAudio ping. No asset to load, plays instantly. The
// node lives across calls because creating + tearing down an
// AudioContext per chime would prompt the user-gesture autoplay
// policy on every fire.
let audioCtx: AudioContext | null = null;
function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioCtx) return audioCtx;
  const AudioCtor = (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    audioCtx = new AudioCtor();
    return audioCtx;
  } catch {
    return null;
  }
}

function playChime() {
  const ctx = ensureAudio();
  if (!ctx) return;
  // Two-tone descending ping at ~660 Hz then ~440 Hz, ~110 ms total.
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(660, t0);
  o.frequency.exponentialRampToValueAtTime(440, t0 + 0.09);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + 0.12);
}

// ---- dispatch entrypoint ------------------------------------------------

export interface NotifyDispatchInput {
  deltas: RoomDelta[];
  /** Active room the user is currently viewing (null on rooms list). */
  activeRoomId: RoomId | null;
  /** Caller's own user id — required for mention detection. */
  me: UserId | null;
  /** Lookup so we can render "Sender · #Room: body" in the OS. */
  roomById: Map<RoomId, RoomSummary>;
  /** Click handler: receive the roomId so the app can focus that room. */
  onClickRoom: (roomId: RoomId) => void;
}

/**
 * Called from home.tsx on every syncUpdate. Mutates the unread /
 * highlight tallies and (when warranted) plays sound + shows desktop
 * notifications. Idempotent for empty inputs.
 */
export function dispatchSyncDeltas(input: NotifyDispatchInput): void {
  const me = input.me;
  let unreadInc = 0;
  let highlightInc = 0;
  // We only emit a single chime per dispatch even if many messages
  // arrived at once, to avoid the popcorn effect on first connect.
  let needChime = false;
  // Desktop notifications are capped at one per room per dispatch.
  // Without the cap, a backfill burst would launch 50 toasters.
  const notifiedRooms = new Set<RoomId>();

  for (const delta of input.deltas) {
    const roomIsActive = input.activeRoomId === delta.roomId && windowFocused();
    for (const ev of delta.newEvents) {
      if (ev.type !== 'm.room.message') continue;
      // Skip our own messages — we already saw them on send.
      if (me && ev.sender === me) continue;
      // Skip events that the cache replay layer fires for messages we
      // already counted (a server-side echo / re-sync). We don't have
      // an authoritative "is this new to me" flag at this layer, but
      // duplicated eventIds are dropped by the room-view cache merge
      // before they reach the UI; the dispatch path here runs against
      // the same delta stream so any duplicate would have to come from
      // an upstream replay. Acceptable false-positive rate for now.
      const msg = ev as RoomMessageEvent;
      const isMention = !!me && isMentionEvent(msg, me);
      if (roomIsActive && !isMention) continue;

      unreadInc += 1;
      if (isMention) highlightInc += 1;

      // Always chime for mentions; otherwise only when the room is
      // not active OR window not focused (the early-continue above
      // already filtered most of these out — what's left is the
      // non-active rooms whose unread count we want to bump audibly).
      needChime = true;

      // Desktop notification gating: must be enabled, granted, and
      // window not focused (OR mention while focused on a different
      // room).
      if (
        enabled()
        && permission() === 'granted'
        && (!windowFocused() || isMention)
        && !notifiedRooms.has(delta.roomId)
      ) {
        notifiedRooms.add(delta.roomId);
        showDesktopNotification(msg, input.roomById.get(delta.roomId), () => input.onClickRoom(delta.roomId));
      }
    }
  }

  if (unreadInc > 0) setTotalUnread((u) => u + unreadInc);
  if (highlightInc > 0) setTotalHighlights((h) => h + highlightInc);
  if (needChime && enabled()) playChime();
}

function isMentionEvent(msg: RoomMessageEvent, me: UserId): boolean {
  const c = msg.content;
  if (c.msgtype !== 'm.text' && c.msgtype !== 'm.emote' && c.msgtype !== 'm.notice') return false;
  if (c.mentions?.userIds.includes(me)) return true;
  if (c.mentions?.room) return true;
  // Heuristic fallback when MSC3952 mentions are absent (older clients,
  // older messages): match my localpart as a whitespace-bounded @token.
  const local = me.slice(1).split(':')[0];
  if (!local) return false;
  const re = new RegExp(`(^|[\\s,.;:!?\\n])@${escapeRe(local)}\\b`);
  return re.test(c.body);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function showDesktopNotification(
  msg: RoomMessageEvent,
  room: RoomSummary | undefined,
  onClick: () => void,
) {
  try {
    const title = room?.name ?? 'Mata';
    const sender = msg.sender.slice(1).split(':')[0] ?? msg.sender;
    const preview = previewFor(msg as TimelineEvent);
    const body = `${sender}: ${preview}`;
    // `renotify` is a non-standard Chromium option that TS's lib.dom
    // doesn't declare. We pass it via a permissive cast so re-firing
    // for the same tag still pops the toaster (without stacking) on
    // browsers that support it; others ignore the unknown field.
    const opts: NotificationOptions = { body, tag: `mata-${room?.roomId ?? msg.sender}`, silent: false };
    (opts as NotificationOptions & { renotify?: boolean }).renotify = true;
    const n = new Notification(title, opts);
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      onClick();
      n.close();
    };
    // Best-effort auto-close after 6s; user may have OS-level overrides.
    setTimeout(() => {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }, 6000);
  } catch {
    // Notification constructor can throw if the page lost focus
    // permission mid-flight; we swallow so dispatchSyncDeltas never
    // hard-fails the sync loop.
  }
}

function previewFor(ev: TimelineEvent): string {
  if (ev.type !== 'm.room.message') return 'New event';
  const c = ev.content;
  if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
    return c.body.length > 140 ? c.body.slice(0, 137) + '…' : c.body;
  }
  if (c.msgtype === 'm.image') return '📷 Image';
  if (c.msgtype === 'm.video') return '🎬 Video';
  if (c.msgtype === 'm.audio') return '🎙 Audio';
  if (c.msgtype === 'm.file') return '📎 File';
  return 'New message';
}
