import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@mata/shared/matrix';
import { mergeEvents, reconcilePending, sameRenderedEvent } from './timeline-merge.js';

// ---- builders -------------------------------------------------------------

function msg(
  eventId: string,
  overrides: Partial<Record<string, unknown>> = {},
): TimelineEvent {
  return {
    type: 'm.room.message',
    eventId,
    roomId: '!r:hs',
    sender: '@a:hs',
    originServerTs: 1000,
    content: { msgtype: 'm.text', body: 'hi' },
    ...overrides,
  } as unknown as TimelineEvent;
}

function encryptedPlaceholder(eventId: string): TimelineEvent {
  return {
    type: 'm.room.encrypted',
    eventId,
    roomId: '!r:hs',
    sender: '@a:hs',
    originServerTs: 1000,
    decryptionStatus: 'pending',
  } as unknown as TimelineEvent;
}

// ---- mergeEvents ----------------------------------------------------------

describe('mergeEvents', () => {
  it('appends a brand-new event', () => {
    const base = [msg('e1')];
    const { events, mutated } = mergeEvents(base, [msg('e2')]);
    expect(mutated).toBe(true);
    expect(events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    // original array untouched (fresh reference returned)
    expect(events).not.toBe(base);
    expect(base).toHaveLength(1);
  });

  it('is a no-op for a content-identical re-emit (reconcile tail)', () => {
    const base = [msg('e1'), msg('e2')];
    const { events, mutated } = mergeEvents(base, [msg('e1'), msg('e2')]);
    expect(mutated).toBe(false);
    // SAME reference back → no downstream recompute
    expect(events).toBe(base);
  });

  it('preserves untouched references on a partial change', () => {
    const e1 = msg('e1');
    const e2 = msg('e2');
    const base = [e1, e2];
    const { events } = mergeEvents(base, [msg('e2', { content: { msgtype: 'm.text', body: 'edited' } })]);
    // e1 reference preserved; e2 replaced
    expect(events[0]).toBe(e1);
    expect(events[1]).not.toBe(e2);
    expect((events[1].content as { body: string }).body).toBe('edited');
  });

  it('upgrades an encrypted placeholder to its decrypted message in place', () => {
    const base = [encryptedPlaceholder('e1')];
    const decrypted = msg('e1', { originServerTs: 1000 });
    const { events, mutated } = mergeEvents(base, [decrypted]);
    expect(mutated).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('m.room.message');
  });

  it('does not duplicate when the same new event arrives twice in one batch', () => {
    const { events } = mergeEvents([], [msg('e1'), msg('e1')]);
    expect(events.map((e) => e.eventId)).toEqual(['e1']);
  });

  it('returns the same reference for an empty incoming batch', () => {
    const base = [msg('e1')];
    const res = mergeEvents(base, []);
    expect(res.mutated).toBe(false);
    expect(res.events).toBe(base);
  });

  it('idempotent: merging the same delta twice yields one stable array', () => {
    const base = [msg('e1')];
    const first = mergeEvents(base, [msg('e2')]);
    const second = mergeEvents(first.events, [msg('e2')]);
    expect(second.mutated).toBe(false);
    expect(second.events).toBe(first.events);
    expect(first.events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
  });
});

// ---- reconcilePending -----------------------------------------------------

interface Pending {
  txnId: string;
  expectedEventId?: string;
  body: string;
}

describe('reconcilePending', () => {
  it('drops a pending entry when its txnId echoes back (double-send fix)', () => {
    const pending: Pending[] = [{ txnId: 't1', body: 'hello' }];
    const incoming = [msg('e1', { txnId: 't1' })];
    const kept = reconcilePending(pending, incoming);
    expect(kept).toHaveLength(0);
  });

  it('drops a pending entry via expectedEventId fallback (no txnId echo)', () => {
    const pending: Pending[] = [{ txnId: 't1', expectedEventId: 'e1', body: 'hello' }];
    const incoming = [msg('e1')]; // server dropped txnId
    const kept = reconcilePending(pending, incoming);
    expect(kept).toHaveLength(0);
  });

  it('keeps a pending entry whose event has not arrived yet', () => {
    const pending: Pending[] = [{ txnId: 't1', body: 'hello' }];
    const incoming = [msg('e9', { txnId: 't-other' })];
    const kept = reconcilePending(pending, incoming);
    expect(kept).toBe(pending); // unchanged reference
  });

  it('reconciles only the matching entry in a multi-pending queue', () => {
    const pending: Pending[] = [
      { txnId: 't1', body: 'a' },
      { txnId: 't2', body: 'b' },
    ];
    const incoming = [msg('e1', { txnId: 't2' })];
    const kept = reconcilePending(pending, incoming);
    expect(kept.map((p) => p.txnId)).toEqual(['t1']);
  });

  it('returns the same reference when there is nothing pending', () => {
    const pending: Pending[] = [];
    expect(reconcilePending(pending, [msg('e1', { txnId: 't1' })])).toBe(pending);
  });
});

// ---- sameRenderedEvent ----------------------------------------------------

describe('sameRenderedEvent', () => {
  it('treats identical content as equal', () => {
    expect(sameRenderedEvent(msg('e1'), msg('e1'))).toBe(true);
  });
  it('detects a body change', () => {
    expect(
      sameRenderedEvent(msg('e1'), msg('e1', { content: { msgtype: 'm.text', body: 'x' } })),
    ).toBe(false);
  });
  it('detects a reaction-count change', () => {
    const a = msg('e1', { reactions: [{ key: '👍', count: 1, selfReacted: false, senders: [] }] });
    const b = msg('e1', { reactions: [{ key: '👍', count: 2, selfReacted: false, senders: [] }] });
    expect(sameRenderedEvent(a, b)).toBe(false);
  });
});
