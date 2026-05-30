/**
 * Pure timeline-merge reducer.
 *
 * Extracted out of `room-view.tsx` so the live-delta merge logic can be
 * unit-tested in isolation AND reused by the data layer (`home.tsx`),
 * which owns the per-room cache store and therefore must merge events
 * for EVERY room in a delta batch — not just the one currently on
 * screen. Scoping the merge to the active room was the root cause of
 * the "messages don't show until refresh / appear in the wrong chat /
 * duplicate on send" class of bugs: events and send-echoes that landed
 * after the user switched rooms were written against the wrong cache
 * (or dropped entirely).
 *
 * Everything here is a pure function over plain data — no Solid stores,
 * no DOM, no bridge. The caller is responsible for committing the
 * returned arrays into whatever reactive container it uses.
 */

import type { TimelineEvent } from '@mata/shared/matrix';

/**
 * Structural equality for "does this event render differently than the
 * one we already have?". Used to decide whether a re-emitted event
 * (the reconcile tail re-sends content-identical events on every sync
 * tick) should REPLACE the existing object reference or be ignored.
 *
 * Keeping the OLD reference for unchanged re-emits is what stops the
 * "every bubble flashes its enter-animation on each sync tick"
 * regression — the rows() memo diffs by strict identity, so a no-op
 * merge must preserve references.
 */
export function sameRenderedEvent(a: TimelineEvent, b: TimelineEvent): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Circular or otherwise non-serializable — treat as different so we
    // err on the side of repainting rather than showing stale content.
    return false;
  }
}

export interface MergeResult {
  events: TimelineEvent[];
  /**
   * True when the array actually changed (a new event was appended or
   * an existing one was replaced with genuinely different content).
   * When false the caller should keep the OLD array reference so no
   * downstream reactive recompute fires.
   */
  mutated: boolean;
}

/**
 * Replace-or-append `incoming` into `events`, deduping by `eventId`.
 *
 * - Unknown eventId → appended (a new message).
 * - Known eventId, content differs → replaced in place (the
 *   E2EE "encrypted placeholder → decrypted cleartext" upgrade, an
 *   edit, or a reaction-count change).
 * - Known eventId, content identical → ignored (idle reconcile tail).
 *
 * Returns a FRESH array only when something changed; otherwise returns
 * the original reference with `mutated: false`.
 *
 * Ordering note: events are appended in arrival order. Chronological
 * sorting for display is the renderer's job (it sorts by
 * originServerTs), so this reducer deliberately does not reorder —
 * that keeps the merge O(n) and idempotent.
 */
export function mergeEvents(
  events: TimelineEvent[],
  incoming: readonly TimelineEvent[],
): MergeResult {
  if (incoming.length === 0) return { events, mutated: false };

  const indexById = new Map<string, number>();
  for (let i = 0; i < events.length; i++) indexById.set(events[i].eventId, i);

  let next: TimelineEvent[] | null = null;
  const ensureCopy = (): TimelineEvent[] => {
    if (!next) next = events.slice();
    return next;
  };

  for (const ev of incoming) {
    const existing = indexById.get(ev.eventId);
    if (existing !== undefined) {
      if (!sameRenderedEvent(events[existing], ev)) {
        ensureCopy()[existing] = ev;
      }
    } else {
      const arr = ensureCopy();
      indexById.set(ev.eventId, arr.length);
      arr.push(ev);
    }
  }

  return next ? { events: next, mutated: true } : { events, mutated: false };
}

/**
 * Drop optimistic pending entries whose confirmed server event has now
 * arrived in `incoming`. Two OR'd correlation paths:
 *
 *   1. txnId echo — the homeserver stamps our `transaction_id` on the
 *      event delivered back to this device. Deterministic; works even
 *      if the `sendStatus: sent` message hasn't been processed yet.
 *   2. expectedEventId — fallback once `sendStatus` has recorded the
 *      canonical id, for the rare server that drops the echoed txnId.
 *
 * Returns the ORIGINAL array reference when nothing matched, so the
 * caller can skip a needless reactive write.
 */
export function reconcilePending<
  P extends { txnId: string; expectedEventId?: string },
>(pending: readonly P[], incoming: readonly TimelineEvent[]): P[] {
  if (pending.length === 0) return pending as P[];

  const incomingTxns = new Set<string>();
  const incomingIds = new Set<string>();
  for (const ev of incoming) {
    incomingIds.add(ev.eventId);
    if (ev.txnId) incomingTxns.add(ev.txnId);
  }

  const kept = pending.filter(
    (p) =>
      !incomingTxns.has(p.txnId) &&
      !(p.expectedEventId !== undefined && incomingIds.has(p.expectedEventId)),
  );

  return kept.length === pending.length ? (pending as P[]) : kept;
}
