// =============================================================================
// Verification store — single global signal that mirrors the worker's
// in-flight SAS verification state to the UI.
//
// Why a singleton:
//   The verification modal is a top-level overlay; only one verification
//   can be active at a time from the user's point of view. The worker
//   theoretically can hold N concurrent flows (e.g. two devices both
//   open verifications against us), but the UI explicitly funnels them
//   into a single dialog and queues the rest implicitly — whichever
//   request advances to `sas_compare` first claims the slot. The
//   rest stay open on the worker side and surface as soon as the
//   current flow ends.
//
// Why track here instead of inside the modal component:
//   The modal is mounted at app root and we want subscriptions to
//   start the moment the bridge is available — before the user has
//   clicked anything. That way an *incoming* SAS request from another
//   device pops the dialog immediately even if no Verify button was
//   ever pressed in this tab.
// =============================================================================

import { createSignal } from 'solid-js';
import type { SasEmoji, UserId, DeviceId } from '@mata/shared/matrix';
import type { MatrixBridge } from '@mata/shared/rpc';

export type VerificationUiPhase =
  | 'requesting' // we sent a request, peer hasn't accepted yet
  | 'incoming' // peer sent a request to us, awaiting our accept
  | 'sas_compare' // emojis ready, user must say match/mismatch
  | 'verifying' // user confirmed match, waiting for finalize
  | 'done'
  | 'cancelled';

export interface VerificationFlow {
  transactionId: string;
  otherUserId: UserId;
  otherDeviceId: DeviceId;
  phase: VerificationUiPhase;
  sasEmojis: SasEmoji[];
  errorReason?: string;
}

const [activeFlow, setActiveFlow] = createSignal<VerificationFlow | null>(null);
export { activeFlow };

/** Imperatively close the modal (after Done / Cancelled stickies). */
export function clearVerificationFlow() {
  setActiveFlow(null);
}

/**
 * Wire the bridge event channel into the store. Must be called exactly
 * once — `setup-bridge.ts` style. Returns a dispose function so HMR
 * and tests can detach cleanly.
 */
export function attachVerificationStore(bridge: MatrixBridge): () => void {
  const offRequest = bridge.on('verificationRequest', (ev) => {
    // Incoming: peer wants to verify us. Replace any prior 'incoming'
    // entry (we only show one); leave 'sas_compare' alone so we don't
    // clobber an active emoji panel.
    const cur = activeFlow();
    if (cur && cur.phase === 'sas_compare') return;
    setActiveFlow({
      transactionId: ev.request.transactionId,
      otherUserId: ev.request.fromUser,
      otherDeviceId: ev.request.fromDevice,
      phase: 'incoming',
      sasEmojis: [],
    });
  });

  const offProgress = bridge.on('verificationProgress', (ev) => {
    const cur = activeFlow();
    // Filter cross-talk: only progress events for the flow the modal
    // currently tracks should update the modal. The store doesn't
    // store other flows; the user can re-trigger them after this one
    // closes. (See module header for rationale.)
    if (!cur || cur.transactionId !== ev.transactionId) {
      // …unless this is a sas_compare for a flow we initiated but
      // haven't seen yet — that means we never got a 'requesting'
      // entry because the peer raced to Ready. Synthesize a row.
      if (ev.phase === 'sas_compare') {
        setActiveFlow({
          transactionId: ev.transactionId,
          // We don't have user/device info here; the modal copes via
          // the unknown placeholders.
          otherUserId: ('@unknown' as UserId),
          otherDeviceId: ('UNKNOWN' as DeviceId),
          phase: 'sas_compare',
          sasEmojis: ev.sasEmojis ?? [],
        });
      }
      return;
    }
    if (ev.phase === 'ready') {
      // Still pre-SAS — keep the modal in 'requesting' so the user
      // sees "waiting for other device…" rather than a flicker.
      if (cur.phase === 'requesting' || cur.phase === 'incoming') {
        setActiveFlow({ ...cur, phase: cur.phase });
      }
    } else if (ev.phase === 'sas_compare') {
      setActiveFlow({
        ...cur,
        phase: 'sas_compare',
        sasEmojis: ev.sasEmojis ?? [],
      });
    } else if (ev.phase === 'done') {
      setActiveFlow({ ...cur, phase: 'done' });
    } else if (ev.phase === 'cancelled') {
      // exactOptionalPropertyTypes: only attach errorReason when it's
      // an actual string, otherwise the optional must be entirely absent.
      const next: VerificationFlow = { ...cur, phase: 'cancelled' };
      if (ev.cancellationReason) next.errorReason = ev.cancellationReason;
      setActiveFlow(next);
    }
  });

  return () => {
    offRequest();
    offProgress();
  };
}

/**
 * UI-initiated begin: kicks off a verification against (userId,
 * deviceId) and seeds the modal in 'requesting' state. Called from
 * the members panel and the devices list.
 */
export async function startVerification(
  bridge: MatrixBridge,
  userId: UserId,
  deviceId: DeviceId,
): Promise<void> {
  // Synchronously open the modal in 'requesting' so the user sees
  // immediate feedback; the RPC reply patches the transactionId.
  setActiveFlow({
    transactionId: '',
    otherUserId: userId,
    otherDeviceId: deviceId,
    phase: 'requesting',
    sasEmojis: [],
  });
  const res = await bridge.request({
    kind: 'beginDeviceVerification',
    userId,
    deviceId,
  });
  const cur = activeFlow();
  if (cur && cur.phase === 'requesting' && cur.transactionId === '') {
    setActiveFlow({ ...cur, transactionId: res.transactionId });
  }
}
