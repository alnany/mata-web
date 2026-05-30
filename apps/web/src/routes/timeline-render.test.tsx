/**
 * DOM-level regression net for the recurring "sent message shows twice"
 * bug. Every previous fix validated a MODEL (pure reducers + a hand-written
 * sync simulator) — never the real rendered DOM. That seam is exactly where
 * the doubles kept hiding: the data layer was correct, but the JSX rendered
 * a pending bubble that the data said should be gone.
 *
 * This test renders the REAL PendingRow component over the REAL
 * visiblePending() output — the identical composition room-view uses
 * (`<For each={visiblePending(pending, events)}>`). It asserts on what the
 * user actually sees in the DOM, so a render-layer regression fails the gate
 * before it can ship.
 */
import { render, cleanup } from '@solidjs/testing-library';
import { For } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventId, RoomId, TimelineEvent, UserId } from '@mata/shared/matrix';
import { visiblePending } from '../lib/timeline-merge.js';
import { PendingRow, type PendingEvent } from './room-view.jsx';

afterEach(cleanup);

const ME = '@me:hs' as UserId;

function confirmedEvent(eventId: string, body: string, txnId: string | null): TimelineEvent {
  return {
    type: 'm.room.message',
    eventId: eventId as EventId,
    roomId: 'room' as RoomId,
    sender: ME,
    originServerTs: 1000,
    txnId,
    content: { msgtype: 'm.text', body, formattedBody: null },
    reactions: [],
    edits: [],
    inReplyTo: null,
    threadRoot: null,
  };
}

function pending(txnId: string, body: string, expectedEventId?: string): PendingEvent {
  return {
    txnId,
    body,
    status: 'sending',
    ...(expectedEventId ? { expectedEventId: expectedEventId as EventId } : {}),
  };
}

/** Mounts the exact pending composition room-view renders. */
function renderPending(pendingList: PendingEvent[], events: TimelineEvent[]) {
  return render(() => (
    <ul>
      <For each={visiblePending(pendingList, events)}>
        {(p) => <PendingRow pending={p} />}
      </For>
    </ul>
  ));
}

describe('timeline render — pending bubble dedup (DOM)', () => {
  it('echo confirmed in events but pending not pruned → ONE bubble on screen (matched by txnId)', () => {
    const { queryAllByTestId } = renderPending(
      [pending('t1', 'hi')],
      [confirmedEvent('E1', 'hi', 't1')],
    );
    // The confirmed event renders elsewhere (events list); the optimistic
    // twin must NOT render here. Pre-fix this was 1 → total 2 on screen.
    expect(queryAllByTestId('pending-bubble')).toHaveLength(0);
  });

  it('echo lacks txnId but pending carries expectedEventId → twin still hidden', () => {
    const { queryAllByTestId } = renderPending(
      [pending('t1', 'hi', 'E1')],
      [confirmedEvent('E1', 'hi', null)],
    );
    expect(queryAllByTestId('pending-bubble')).toHaveLength(0);
  });

  it('echo not yet arrived → optimistic bubble still shows (exactly one)', () => {
    const { queryAllByTestId, getByText } = renderPending([pending('t1', 'hi')], []);
    expect(queryAllByTestId('pending-bubble')).toHaveLength(1);
    expect(getByText('hi')).toBeInTheDocument();
  });

  it('two in-flight sends, one confirmed → only the still-pending one renders', () => {
    const { queryAllByTestId, getByText } = renderPending(
      [pending('t1', 'one'), pending('t2', 'two')],
      [confirmedEvent('E1', 'one', 't1')],
    );
    const bubbles = queryAllByTestId('pending-bubble');
    expect(bubbles).toHaveLength(1);
    expect(getByText('two')).toBeInTheDocument();
  });

  it('rapid-fire: three sends, two confirmed in one batch → one optimistic bubble left', () => {
    const { queryAllByTestId } = renderPending(
      [pending('t1', 'a'), pending('t2', 'b'), pending('t3', 'c')],
      [confirmedEvent('E1', 'a', 't1'), confirmedEvent('E2', 'b', 't2')],
    );
    expect(queryAllByTestId('pending-bubble')).toHaveLength(1);
  });
});
