// =============================================================================
// notifications.ts — central notification dispatcher
//
// Responsibilities (UI-side, NOT in the worker):
//   1. Track browser Notification permission + a persisted user
//      enabled flag (localStorage).
//   2. Track window focus / visibility so we only fire desktop toasts
//      when the user isn't looking at the active room.
//   3. Receive aggregate unread/highlight totals via `setRoomCounts`
//      (home.tsx pushes the sum over rooms()). These are exposed via
//      `notifyTotals` for the tab title. Source of truth is the
//      server's per-room unreadCount/highlightCount — receipts sent
//      from room-view clear those on the next sync.
//   4. `dispatchSyncDeltas` runs on every syncUpdate and decides
//      whether to play the chime + show a desktop toast. Mute is
//      honored via RoomSummary.isMuted.
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

const loadEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const [enabled, setEnabledRaw] = createSignal(loadEnabled());
const [totalUnread, setTotalUnread] = createSignal(0);
const [totalHighlights, setTotalHighlights] = createSignal(0);
const [permission, setPermission] = createSignal<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
);
const [windowFocused, setWindowFocused] = createSignal(
  typeof document !== 'undefined' ? document.hasFocus() : true,
);

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => setWindowFocused(true));
  window.addEventListener('blur', () => setWindowFocused(false));
  document.addEventListener('visibilitychange', () => {
    setWindowFocused(!document.hidden);
  });
}

export const notifyEnabled = enabled;
export const notifyPermission = permission;
export const notifyTotals = { unread: totalUnread, highlights: totalHighlights };
export const isWindowFocused = windowFocused;

/**
 * Aggregate room unread + highlight counts pushed from home.tsx every
 * time the room list updates. Server-driven: receipts sent by the
 * room-view will, on the next sync delta, drop the per-room counts
 * for the active room. No focus-zeroes-everything hack anymore.
 */
export function setRoomCounts(input: { unread: number; highlights: number }): void {
  setTotalUnread(input.unread);
  setTotalHighlights(input.highlights);
}

export async function setNotifyEnabled(next: boolean): Promise<void> {
  // The browser denies any Notification.requestPermission() call that
  // lacks a user gesture in the synchronous call stack — so this
  // function MUST be invoked directly from a click handler.
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
  // Two-tone descending ping ~660→440Hz, 110ms total.
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

// ---- dispatch -----------------------------------------------------------

export interface NotifyDispatchInput {
  deltas: RoomDelta[];
  activeRoomId: RoomId | null;
  me: UserId | null;
  roomById: Map<RoomId, RoomSummary>;
  onClickRoom: (roomId: RoomId) => void;
}

export function dispatchSyncDeltas(input: NotifyDispatchInput): void {
  const me = input.me;
  let needChime = false;
  const notifiedRooms = new Set<RoomId>();

  for (const delta of input.deltas) {
    const room = input.roomById.get(delta.roomId);
    // Muted rooms never make noise — even for mentions, matching
    // Matrix push rule `notify:false` semantics.
    if (room?.isMuted) continue;
    const roomIsActive = input.activeRoomId === delta.roomId && windowFocused();
    for (const ev of delta.newEvents) {
      if (ev.type !== 'm.room.message') continue;
      if (me && ev.sender === me) continue;
      const msg = ev as RoomMessageEvent;
      const isMention = !!me && isMentionEvent(msg, me);
      if (roomIsActive && !isMention) continue;

      needChime = true;

      if (
        enabled()
        && permission() === 'granted'
        && (!windowFocused() || isMention)
        && !notifiedRooms.has(delta.roomId)
      ) {
        notifiedRooms.add(delta.roomId);
        showDesktopNotification(msg, room, () => input.onClickRoom(delta.roomId));
      }
    }
  }

  if (needChime && enabled()) playChime();
}

function isMentionEvent(msg: RoomMessageEvent, me: UserId): boolean {
  const c = msg.content;
  if (c.msgtype !== 'm.text' && c.msgtype !== 'm.emote' && c.msgtype !== 'm.notice') return false;
  if (c.mentions?.userIds.includes(me)) return true;
  if (c.mentions?.room) return true;
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
    setTimeout(() => {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }, 6000);
  } catch {
    /* swallow — never break sync */
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
