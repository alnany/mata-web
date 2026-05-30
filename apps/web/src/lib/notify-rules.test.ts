/**
 * Regression net for notification + read-receipt accuracy. These are the
 * rules behind "I got a chime but there's no new message", "it didn't
 * notify me when I was @mentioned", and double desktop toasts. All pure,
 * all deterministic (now is injected).
 */
import { describe, expect, it } from 'vitest';
import type { EventId, RoomId, RoomMessageEvent, UserId } from '@mata/shared/matrix';
import {
  aggregateReadReceipts,
  classifyNotification,
  isMentionEvent,
  type NotifyContext,
} from './notify-rules.js';

const ME = '@chris:hs' as UserId;
const ALICE = '@alice:hs' as UserId;
const ROOM = 'r1' as RoomId;
const NOW = 1_000_000;

function textMsg(
  body: string,
  opts: {
    sender?: UserId;
    ts?: number;
    mentions?: { userIds: UserId[]; room?: boolean };
    msgtype?: 'm.text' | 'm.emote' | 'm.notice';
  } = {},
): RoomMessageEvent {
  return {
    type: 'm.room.message',
    eventId: ('e' + Math.random()) as EventId,
    roomId: ROOM,
    sender: opts.sender ?? ALICE,
    originServerTs: opts.ts ?? NOW,
    txnId: null,
    content: { msgtype: opts.msgtype ?? 'm.text', body, formattedBody: null, mentions: opts.mentions },
    reactions: [],
    edits: [],
    inReplyTo: null,
    threadRoot: null,
  } as RoomMessageEvent;
}

const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({
  me: ME,
  isMuted: false,
  roomIsActive: false,
  windowFocused: false,
  now: NOW,
  freshWindowMs: 60_000,
  ...over,
});

describe('isMentionEvent', () => {
  it('matches the MSC3952 mention list', () => {
    expect(isMentionEvent(textMsg('hey', { mentions: { userIds: [ME] } }), ME)).toBe(true);
  });
  it('matches an @room broadcast', () => {
    expect(isMentionEvent(textMsg('all hands', { mentions: { userIds: [], room: true } }), ME)).toBe(true);
  });
  it('matches a textual @localpart on a word boundary', () => {
    expect(isMentionEvent(textMsg('ping @chris please'), ME)).toBe(true);
    expect(isMentionEvent(textMsg('@chris'), ME)).toBe(true);
  });
  it('does NOT match a longer name that merely starts with the localpart', () => {
    expect(isMentionEvent(textMsg('hi @christine'), ME)).toBe(false);
  });
  it('does NOT match the localpart embedded mid-token (email-like)', () => {
    expect(isMentionEvent(textMsg('mail chris@host.com'), ME)).toBe(false);
  });
  it('does NOT treat media/location as mentions', () => {
    const img = { ...textMsg('caption'), content: { msgtype: 'm.image', body: 'x' } } as unknown as RoomMessageEvent;
    expect(isMentionEvent(img, ME)).toBe(false);
  });
  it('matches in m.emote / m.notice bodies', () => {
    expect(isMentionEvent(textMsg('waves at @chris', { msgtype: 'm.emote' }), ME)).toBe(true);
    expect(isMentionEvent(textMsg('@chris build done', { msgtype: 'm.notice' }), ME)).toBe(true);
  });
});

describe('classifyNotification', () => {
  it('skips non-message events', () => {
    const d = classifyNotification({ type: 'm.room.redaction' }, ctx());
    expect(d).toMatchObject({ alert: false, reason: 'not_message' });
  });
  it('skips my own messages', () => {
    const d = classifyNotification(textMsg('hi', { sender: ME }), ctx());
    expect(d).toMatchObject({ alert: false, reason: 'own_message' });
  });
  it('skips muted rooms even for mentions', () => {
    const d = classifyNotification(textMsg('@chris urgent'), ctx({ isMuted: true }));
    expect(d).toMatchObject({ alert: false, reason: 'muted' });
  });
  it('skips stale events (reconcile tail / boot backlog)', () => {
    const d = classifyNotification(textMsg('old', { ts: NOW - 120_000 }), ctx());
    expect(d).toMatchObject({ alert: false, reason: 'stale' });
  });
  it('skips events with no timestamp', () => {
    const d = classifyNotification(textMsg('no ts', { ts: 0 }), ctx());
    expect(d).toMatchObject({ alert: false, reason: 'stale' });
  });
  it('skips a non-mention in the active, focused room (badge covers it)', () => {
    const d = classifyNotification(textMsg('hello'), ctx({ roomIsActive: true, windowFocused: true }));
    expect(d).toMatchObject({ alert: false, reason: 'active_room' });
  });
  it('ALERTS for a mention even in the active room, and is loud', () => {
    const d = classifyNotification(textMsg('@chris look'), ctx({ roomIsActive: true, windowFocused: true }));
    expect(d).toEqual({ alert: true, isMention: true, chime: true, desktopEligible: true });
  });
  it('unfocused window: any new message chimes + is desktop-eligible', () => {
    const d = classifyNotification(textMsg('hello'), ctx({ windowFocused: false }));
    expect(d).toEqual({ alert: true, isMention: false, chime: true, desktopEligible: true });
  });
  it('focused but a DIFFERENT (background) room: alerts silently — badge, no chime', () => {
    const d = classifyNotification(textMsg('hello'), ctx({ roomIsActive: false, windowFocused: true }));
    expect(d).toEqual({ alert: true, isMention: false, chime: false, desktopEligible: false });
  });
});

describe('aggregateReadReceipts', () => {
  it('groups userIds by eventId in first-seen order', () => {
    const m = aggregateReadReceipts([
      { eventId: 'e1', userId: ALICE },
      { eventId: 'e1', userId: ME },
      { eventId: 'e2', userId: ALICE },
    ]);
    expect(m.get('e1')).toEqual([ALICE, ME]);
    expect(m.get('e2')).toEqual([ALICE]);
    expect(m.size).toBe(2);
  });
  it('is empty for no receipts', () => {
    expect(aggregateReadReceipts([]).size).toBe(0);
  });
});
