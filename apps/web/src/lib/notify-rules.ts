// =============================================================================
// notify-rules.ts — PURE notification + receipt decision logic.
//
// Extracted from notifications.ts / room-view.tsx so the bug-prone parts —
// "did this message mention me?", "should this fire a chime / desktop
// toast?", "who has read this event?" — are unit-tested in isolation,
// with no DOM, audio, or Notification side effects. The store keeps the
// stateful dedup (notifiedIds) and the actual side effects; this module
// owns the decisions.
// =============================================================================
import type { RoomMessageEvent, UserId } from '@mata/shared/matrix';

/**
 * True when `msg` mentions `me`. Three independent signals, OR'd:
 *   1. MSC3952 intentional mention list (`mentions.userIds`).
 *   2. `@room` broadcast mention (`mentions.room`).
 *   3. Legacy textual `@localpart` with a word boundary — so "@chris"
 *      matches but "@christine" and an email "chris@host" do NOT.
 * Only text-bearing msgtypes can mention; media/location cannot.
 */
export function isMentionEvent(msg: RoomMessageEvent, me: UserId): boolean {
  const c = msg.content;
  if (c.msgtype !== 'm.text' && c.msgtype !== 'm.emote' && c.msgtype !== 'm.notice') {
    return false;
  }
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

export type NotifySkipReason =
  | 'not_message'
  | 'own_message'
  | 'muted'
  | 'stale'
  | 'active_room';

export interface NotifyContext {
  me: UserId | null;
  /** The room is muted (Matrix push rule notify:false). */
  isMuted: boolean;
  /** The room is on screen AND the window is focused. */
  roomIsActive: boolean;
  /** Window currently has focus. */
  windowFocused: boolean;
  /** Wall-clock now (ms) — injected for deterministic tests. */
  now: number;
  /** Events older than this are backlog/reconcile re-emits, never alerts. */
  freshWindowMs: number;
}

export type NotifyDecision =
  | { alert: false; reason: NotifySkipReason; isMention: boolean }
  | { alert: true; isMention: boolean; chime: boolean; desktopEligible: boolean };

/**
 * Decide whether a single timeline event should produce a chime and/or a
 * desktop notification. PURE — identity-dedup (notify-once-per-eventId),
 * the enabled/permission checks, and the per-room desktop cap stay in the
 * caller; this answers only "is this event alert-worthy, and how loud?".
 *
 * Gates, in order (first match wins):
 *   - non-message event            → skip 'not_message'
 *   - my own message               → skip 'own_message'
 *   - muted room                   → skip 'muted'
 *   - not recent (backlog/tail)    → skip 'stale'
 *   - active room & not a mention  → skip 'active_room'
 * Surviving events alert. Loudness: a focused window with a non-mention
 * stays silent-but-eligible only when it's a mention; otherwise an
 * unfocused window or a mention chimes and is desktop-eligible.
 */
export function classifyNotification(
  event: { type: string; sender?: UserId; originServerTs?: number; content?: unknown },
  ctx: NotifyContext,
): NotifyDecision {
  if (event.type !== 'm.room.message') {
    return { alert: false, reason: 'not_message', isMention: false };
  }
  const msg = event as RoomMessageEvent;
  if (ctx.me && msg.sender === ctx.me) {
    return { alert: false, reason: 'own_message', isMention: false };
  }
  if (ctx.isMuted) {
    return { alert: false, reason: 'muted', isMention: false };
  }
  const ts = msg.originServerTs ?? 0;
  if (!ts || ctx.now - ts > ctx.freshWindowMs) {
    return { alert: false, reason: 'stale', isMention: false };
  }
  const isMention = ctx.me ? isMentionEvent(msg, ctx.me) : false;
  if (ctx.roomIsActive && !isMention) {
    return { alert: false, reason: 'active_room', isMention };
  }
  // Focused + non-mention = the user is already here; tab badge covers it,
  // so no chime. Unfocused, or a mention, is loud.
  const loud = !ctx.windowFocused || isMention;
  return { alert: true, isMention, chime: loud, desktopEligible: loud };
}

/**
 * Group read receipts by the event they mark as read. Returns
 * eventId → [userId, …] in first-seen order. Pure mirror of the
 * readByMap memo so "X read up to here" rendering is testable.
 */
export function aggregateReadReceipts<R extends { eventId: string; userId: UserId }>(
  receipts: readonly R[],
): Map<string, UserId[]> {
  const m = new Map<string, UserId[]>();
  for (const r of receipts) {
    const arr = m.get(r.eventId);
    if (arr) arr.push(r.userId);
    else m.set(r.eventId, [r.userId]);
  }
  return m;
}
