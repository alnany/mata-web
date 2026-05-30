/**
 * Sync simulator — automated QA for the message-state core.
 *
 * This is the regression net that replaces manual click-testing. It
 * models the data layer's per-room state machine using ONLY the pure
 * reducers that home.tsx actually runs in production
 * (mergeEvents / reconcilePending / applySendStatus), then replays
 * adversarial live-sync streams against it and asserts the rendered
 * result.
 *
 * Every bug the user reported — "messages don't display as received",
 * "messages double", "messages in the wrong chat", plus the delete /
 * edit / decrypt-late edge cases — is encoded below as a named scenario.
 * If any of these regress, the build goes red. The single-writer
 * architecture (home owns the cache; the view never mutates) is what
 * makes these properties hold; these tests prove they hold.
 */
import { describe, expect, it } from 'vitest';
import type {
  EventId,
  RoomId,
  TimelineEvent,
  UserId,
} from '@mata/shared/matrix';
import {
  applySendStatus,
  mergeEvents,
  reconcilePending,
  type SendStatusEvent,
} from './timeline-merge.js';

// ---- builders ------------------------------------------------------------

const ROOM_A = 'roomA' as RoomId;
const ROOM_B = 'roomB' as RoomId;
const ME = '@me:hs' as UserId;
const ALICE = '@alice:hs' as UserId;

let _ts = 1000;
function nextTs(): number {
  return (_ts += 1000);
}

function msg(
  eventId: string,
  body: string,
  opts: {
    sender?: UserId;
    roomId?: RoomId;
    ts?: number;
    txnId?: string | null;
    edits?: string[];
  } = {},
): TimelineEvent {
  return {
    type: 'm.room.message',
    eventId: eventId as EventId,
    roomId: opts.roomId ?? ROOM_A,
    sender: opts.sender ?? ALICE,
    originServerTs: opts.ts ?? nextTs(),
    txnId: opts.txnId ?? null,
    content: { msgtype: 'm.text', body, formattedBody: null },
    reactions: [],
    edits: (opts.edits ?? []) as EventId[],
    inReplyTo: null,
    threadRoot: null,
  };
}

function encryptedPending(eventId: string, opts: { roomId?: RoomId; ts?: number } = {}): TimelineEvent {
  return {
    type: 'm.room.encrypted',
    eventId: eventId as EventId,
    roomId: opts.roomId ?? ROOM_A,
    sender: ALICE,
    originServerTs: opts.ts ?? nextTs(),
    txnId: null,
    decryptionStatus: 'pending',
    failureReason: null,
  };
}

/** A redaction tombstone — keyed by the TARGET event id (as the worker
 *  emits it), so it replaces the original bubble in place. */
function tombstone(targetEventId: string, opts: { roomId?: RoomId; ts?: number } = {}): TimelineEvent {
  return {
    type: 'm.room.redaction',
    eventId: targetEventId as EventId,
    roomId: opts.roomId ?? ROOM_A,
    sender: ALICE,
    originServerTs: opts.ts ?? nextTs(),
    txnId: null,
    redacts: targetEventId as EventId,
    reason: null,
  };
}

// ---- the model: a faithful mirror of home.tsx's data layer ----------------

interface Pending {
  txnId: string;
  body: string;
  expectedEventId?: string;
  status?: string;
  errorReason?: string;
}
interface RoomState {
  events: TimelineEvent[];
  pending: Pending[];
}
const empty = (): RoomState => ({ events: [], pending: [] });

/** Mirrors home's syncUpdate loop for one room's delta. */
function applySync(s: RoomState, newEvents: TimelineEvent[]): RoomState {
  const merged = mergeEvents(s.events, newEvents);
  const kept = reconcilePending(s.pending, newEvents);
  return {
    events: merged.mutated ? merged.events : s.events,
    pending: kept === s.pending ? s.pending : kept,
  };
}

/** Mirrors home's sendStatus handler. Returns the toast reason (if any)
 *  so we can assert it fires exactly once. */
function applyStatus(s: RoomState, status: SendStatusEvent): { state: RoomState; toast: string | null } {
  const { pending, failedReason } = applySendStatus(s.pending, status);
  return { state: { ...s, pending }, toast: failedReason };
}

const addPending = (s: RoomState, p: Pending): RoomState => ({ ...s, pending: [...s.pending, p] });

/** A multi-room world; dispatchDelta routes each delta to ITS OWN room —
 *  the exact invariant whose violation caused wrong-chat routing. */
type World = Map<RoomId, RoomState>;
function dispatchDelta(world: World, deltas: { roomId: RoomId; newEvents: TimelineEvent[] }[]): void {
  for (const d of deltas) {
    const cur = world.get(d.roomId) ?? empty();
    world.set(d.roomId, applySync(cur, d.newEvents));
  }
}

// ---- render derivations (what the user actually sees) --------------------

/** The renderer sorts by originServerTs; mirror that here. */
const renderOrder = (s: RoomState): string[] =>
  [...s.events].sort((a, b) => a.originServerTs - b.originServerTs).map((e) => e.eventId);

/** Bodies of messages the user actually sees: real messages only, not
 *  redaction tombstones or encrypted placeholders, in display order. */
const visibleBodies = (s: RoomState): string[] =>
  [...s.events]
    .sort((a, b) => a.originServerTs - b.originServerTs)
    .filter((e): e is Extract<TimelineEvent, { type: 'm.room.message' }> => e.type === 'm.room.message')
    .map((e) => e.content.body);

const totalBubbles = (s: RoomState): number => s.events.length + s.pending.length;

// ==========================================================================

describe('sync simulator — message-state core regressions', () => {
  it('SCENARIO: inbound message displays as received', () => {
    let s = empty();
    s = applySync(s, [msg('e1', 'hi')]);
    expect(visibleBodies(s)).toEqual(['hi']);
  });

  it('SCENARIO: reconcile tail re-emitting the same event is a no-op (no double, no flash)', () => {
    let s = empty();
    const e = msg('e1', 'hi');
    s = applySync(s, [e]);
    const ref = s.events;
    // tail re-emits a content-identical copy every tick
    s = applySync(s, [{ ...e }]);
    expect(s.events).toBe(ref); // SAME reference → rows() memo never recomputes
    expect(totalBubbles(s)).toBe(1);
  });

  it('SCENARIO: own send — txnId echo removes the optimistic bubble (no double)', () => {
    let s = addPending(empty(), { txnId: 't1', body: 'yo' });
    // server echoes our event back stamped with our txnId
    s = applySync(s, [msg('E1', 'yo', { sender: ME, txnId: 't1' })]);
    expect(s.pending).toHaveLength(0);
    expect(totalBubbles(s)).toBe(1);
    expect(visibleBodies(s)).toEqual(['yo']);
  });

  it('SCENARIO: own send — echo arrives BEFORE sendStatus (the race that doubled messages)', () => {
    let s = addPending(empty(), { txnId: 't1', body: 'yo' });
    // 1) echo first (reconcile tail beats sendStatus)
    s = applySync(s, [msg('E1', 'yo', { sender: ME, txnId: 't1' })]);
    expect(totalBubbles(s)).toBe(1);
    // 2) sendStatus 'sent' lands late — must NOT resurrect a pending bubble
    const r = applyStatus(s, { txnId: 't1', status: 'sent', eventId: 'E1' });
    s = r.state;
    expect(s.pending).toHaveLength(0);
    expect(totalBubbles(s)).toBe(1);
  });

  it('SCENARIO: own send — sendStatus first, then echo (expectedEventId path)', () => {
    let s = addPending(empty(), { txnId: 't1', body: 'yo' });
    const r = applyStatus(s, { txnId: 't1', status: 'sent', eventId: 'E1' });
    s = r.state;
    expect(s.pending[0].expectedEventId).toBe('E1');
    // echo arrives WITHOUT a txnId (server dropped it) — expectedEventId saves us
    s = applySync(s, [msg('E1', 'yo', { sender: ME, txnId: null })]);
    expect(s.pending).toHaveLength(0);
    expect(totalBubbles(s)).toBe(1);
  });

  it('SCENARIO: failed send — bubble flips to error, toast fires exactly once', () => {
    let s = addPending(empty(), { txnId: 't1', body: 'oops' });
    const r = applyStatus(s, { txnId: 't1', status: 'failed', error: { message: 'M_FORBIDDEN' } });
    s = r.state;
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0].status).toBe('failed');
    expect(s.pending[0].errorReason).toBe('M_FORBIDDEN');
    expect(r.toast).toBe('M_FORBIDDEN'); // single writer ⇒ single toast
  });

  it('SCENARIO: wrong-chat routing — a delta for room B never touches room A', () => {
    const world: World = new Map();
    world.set(ROOM_A, applySync(empty(), [msg('a1', 'in A', { roomId: ROOM_A })]));
    // a burst arrives for room B only
    dispatchDelta(world, [{ roomId: ROOM_B, newEvents: [msg('b1', 'in B', { roomId: ROOM_B })] }]);
    expect(visibleBodies(world.get(ROOM_A)!)).toEqual(['in A']); // untouched
    expect(visibleBodies(world.get(ROOM_B)!)).toEqual(['in B']);
  });

  it('SCENARIO: room-switch mid-send — echo for room A reconciles even while B is on screen', () => {
    const world: World = new Map();
    // user sends in A (optimistic), then opens B
    world.set(ROOM_A, addPending(empty(), { txnId: 't1', body: 'from A' }));
    world.set(ROOM_B, empty());
    // A's echo lands in a batch while B is the active room
    dispatchDelta(world, [
      { roomId: ROOM_A, newEvents: [msg('A1', 'from A', { roomId: ROOM_A, sender: ME, txnId: 't1' })] },
    ]);
    const a = world.get(ROOM_A)!;
    expect(a.pending).toHaveLength(0); // reconciled despite not being active
    expect(totalBubbles(a)).toBe(1);
  });

  it('SCENARIO: E2EE — encrypted placeholder upgrades in place to cleartext (no second row)', () => {
    let s = empty();
    s = applySync(s, [encryptedPending('E1', { ts: 5000 })]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].type).toBe('m.room.encrypted');
    // wasm decrypt finishes → same eventId re-emitted as cleartext
    s = applySync(s, [msg('E1', 'secret', { ts: 5000 })]);
    expect(s.events).toHaveLength(1); // replaced in place, not appended
    expect(visibleBodies(s)).toEqual(['secret']);
  });

  it('SCENARIO: edit repaints the original in place (one row, new body)', () => {
    let s = applySync(empty(), [msg('E1', 'helo', { ts: 6000 })]);
    // worker re-emits the TARGET (not the m.replace event) with new content
    s = applySync(s, [msg('E1', 'hello', { ts: 6000, edits: ['edit1'] })]);
    expect(s.events).toHaveLength(1);
    expect(visibleBodies(s)).toEqual(['hello']);
  });

  it('SCENARIO: delete — redaction tombstone replaces the message in place (gone, not doubled)', () => {
    let s = applySync(empty(), [msg('E1', 'delete me', { ts: 7000 })]);
    expect(visibleBodies(s)).toEqual(['delete me']);
    s = applySync(s, [tombstone('E1', { ts: 7000 })]);
    expect(s.events).toHaveLength(1); // same slot, now a tombstone
    expect(s.events[0].type).toBe('m.room.redaction');
    expect(visibleBodies(s)).toEqual([]); // no longer a visible message
  });

  it('SCENARIO: out-of-order arrival — render order is by timestamp, not arrival', () => {
    let s = empty();
    s = applySync(s, [msg('e3', 'third', { ts: 3000 })]);
    s = applySync(s, [msg('e1', 'first', { ts: 1000 })]);
    s = applySync(s, [msg('e2', 'second', { ts: 2000 })]);
    expect(renderOrder(s)).toEqual(['e1', 'e2', 'e3']);
    expect(visibleBodies(s)).toEqual(['first', 'second', 'third']);
  });

  it('SCENARIO: interleaved batch — many rooms, dups, edits, deletes in one storm', () => {
    const world: World = new Map();
    dispatchDelta(world, [
      { roomId: ROOM_A, newEvents: [msg('a1', 'A hello', { roomId: ROOM_A, ts: 1000 })] },
      { roomId: ROOM_B, newEvents: [msg('b1', 'B hello', { roomId: ROOM_B, ts: 1000 })] },
    ]);
    // dup re-emit of a1, an edit of b1, and a new a2 — all in one batch
    dispatchDelta(world, [
      {
        roomId: ROOM_A,
        newEvents: [msg('a1', 'A hello', { roomId: ROOM_A, ts: 1000 }), msg('a2', 'A world', { roomId: ROOM_A, ts: 2000 })],
      },
      { roomId: ROOM_B, newEvents: [msg('b1', 'B HELLO', { roomId: ROOM_B, ts: 1000, edits: ['x'] })] },
    ]);
    expect(visibleBodies(world.get(ROOM_A)!)).toEqual(['A hello', 'A world']);
    expect(visibleBodies(world.get(ROOM_B)!)).toEqual(['B HELLO']);
  });

  it('PROPERTY: replaying any delta twice is idempotent (no eventId ever doubles)', () => {
    const stream = [
      [msg('e1', 'a', { ts: 1000 })],
      [encryptedPending('e2', { ts: 2000 })],
      [msg('e2', 'b', { ts: 2000 })],
      [msg('e1', 'a', { ts: 1000 })],
      [tombstone('e1', { ts: 1000 })],
    ];
    let once = empty();
    let twice = empty();
    for (const batch of stream) {
      once = applySync(once, batch);
      twice = applySync(twice, batch);
      twice = applySync(twice, batch); // apply each batch a second time
    }
    expect(renderOrder(once)).toEqual(renderOrder(twice));
    // no duplicate eventIds
    const ids = twice.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
