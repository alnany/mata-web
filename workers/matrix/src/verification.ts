/**
 * Phase 8.5 — SAS (Short Authentication String) device verification.
 *
 * Matrix's verification flow is a multi-turn handshake between two
 * devices that already share an Olm channel. Both sides exchange
 * commitments + ephemeral ECDH keys, compute a shared secret, and
 * derive a short authentication string from it — by spec, either 7
 * emojis or 3 decimal numbers. If the strings match on both screens,
 * the user has out-of-band confirmation that no MITM sat between the
 * two devices, so each side signs the other's identity key (for
 * cross-device same-user verification) or master cross-signing key
 * (for cross-user verification).
 *
 * The matrix-js-sdk surface we use:
 *
 *   1. `crypto.requestDeviceVerification(userId, deviceId)`   — start
 *      a verification request targeting a specific device of another
 *      (or our own) user. Returns a `VerificationRequest`.
 *
 *   2. The request emits `VerificationRequestEvent.Change` as it walks
 *      through phases. We listen for `Ready` (other side accepted)
 *      then call `request.startVerification('m.sas.v1')` to switch to
 *      SAS. That returns a `Verifier`.
 *
 *   3. The verifier emits `VerifierEvent.ShowSas` once both sides have
 *      computed the SAS. We forward the seven emoji pairs to the UI
 *      via the `verificationProgress` worker event so the user can
 *      compare them with the other device.
 *
 *   4. UI calls back with `completeSasVerification` carrying 'match'
 *      or 'mismatch'. Match → we call `verifier.verify()`; mismatch or
 *      timeout → `request.cancel({ code: 'm.mismatched_sas' })`.
 *
 *   5. When the request reaches phase `Done`, both sides have signed
 *      each other; the verifier shuts down and we drop our local
 *      bookkeeping for the transactionId.
 *
 * The flow is intentionally Map-backed (`activeVerifications`): every
 * in-flight request keys a small record so subsequent RPCs from the
 * UI (`completeSasVerification`) can look up the right verifier
 * without round-tripping through the SDK.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api/verification.js';
import type { DeviceId, SasEmoji, UserId } from '@mata/shared/matrix';
import { authError, cryptoError } from '@mata/shared/errors';
import type { WorkerEvent } from '@mata/shared/rpc';

interface ActiveVerification {
  request: VerificationRequest;
  verifier: Verifier | null;
  /** Callbacks the SDK gave us via the ShowSas event. */
  showSas: ShowSasCallbacks | null;
  /** Cleanup function that detaches all listeners. */
  detach: () => void;
}

export interface VerificationDeps {
  client(): MatrixClient | null;
  emit(event: WorkerEvent): void;
}

export class VerificationService {
  /**
   * Outgoing + incoming verifications currently in flight, keyed by
   * the request transaction id. Bounded in practice by the number of
   * concurrent verification UIs the user has open — a handful at
   * most. Removed on `Done` / `Cancelled`.
   */
  private active = new Map<string, ActiveVerification>();
  private incomingListenerAttached = false;

  constructor(private deps: VerificationDeps) {}

  /**
   * Attach a single global listener for incoming verification
   * requests. Called once during sync bootstrap. Idempotent.
   */
  attachIncomingListener(): void {
    if (this.incomingListenerAttached) return;
    const c = this.deps.client();
    if (!c) return;
    const crypto = c.getCrypto();
    if (!crypto) return;
    // CryptoApi exposes the request event via the client EventEmitter
    // surface; matrix-js-sdk uses `CryptoEvent.VerificationRequestReceived`.
    // We dynamic-import to avoid pulling the enum into our public API
    // surface and to keep this file enum-light.
    void (async () => {
      const { CryptoEvent } = await import('matrix-js-sdk');
      c.on(CryptoEvent.VerificationRequestReceived, (request: VerificationRequest) => {
        this.trackRequest(request, /* incoming */ true);
      });
    })();
    this.incomingListenerAttached = true;
  }

  /**
   * Start a verification we initiated. `deviceId` is required because
   * SAS targets a specific device — the request the other side sees
   * carries this id in `from_device`. If you want to verify all of a
   * user's devices in one go (cross-user verification by signing the
   * master key), use a master-key flow; for v1 we always do per-device.
   */
  async begin(userId: UserId, deviceId: DeviceId): Promise<{ transactionId: string }> {
    const c = this.requireClient();
    const crypto = c.getCrypto();
    if (!crypto) throw cryptoError('Encryption not initialized');

    const request = await crypto.requestDeviceVerification(userId, deviceId);
    this.trackRequest(request, /* incoming */ false);
    return { transactionId: request.transactionId ?? '' };
  }

  /**
   * Resolve the user's SAS decision. 'match' calls `verifier.verify()`
   * which finalizes the cryptographic signing; 'mismatch' cancels with
   * the spec-mandated reason code so the other side sees the right
   * error.
   */
  async complete(transactionId: string, result: 'match' | 'mismatch'): Promise<void> {
    const active = this.active.get(transactionId);
    if (!active) throw cryptoError(`No active verification ${transactionId}`);
    if (!active.showSas) {
      throw cryptoError('Verification has not yet reached SAS step');
    }
    if (result === 'match') {
      // ShowSasCallbacks#confirm performs `verifier.verify()` under
      // the hood and waits for the other side's confirmation event.
      // It throws if the peer also said mismatch (race) — we surface
      // that to the UI as a normal error.
      await active.showSas.confirm();
    } else {
      active.showSas.mismatch();
    }
  }

  /**
   * Cancel a verification we (or the UI) want to drop without saying
   * "they don't match". Used for the back/close UI affordance, or
   * incoming requests we decided to ignore.
   */
  async cancel(transactionId: string): Promise<void> {
    const active = this.active.get(transactionId);
    if (!active) return;
    try {
      await active.request.cancel();
    } catch {
      // Cancel after Done / already cancelled — non-fatal.
    }
  }

  // -- internals ----------------------------------------------------------

  private requireClient(): MatrixClient {
    const c = this.deps.client();
    if (!c) throw authError('Not logged in');
    return c;
  }

  /**
   * Hook a request — incoming or outgoing — into our event stream.
   * Manages the full lifecycle:
   *   - phase Ready  → forward as `ready`
   *   - phase Started→ pick up the verifier, wire ShowSas
   *   - ShowSas      → forward emojis as `sas_compare`
   *   - phase Done   → forward `done`, detach
   *   - phase Cancelled → forward `cancelled` with reason, detach
   */
  private trackRequest(request: VerificationRequest, incoming: boolean): void {
    const txnId = request.transactionId;
    if (!txnId) {
      // Spec says requests must have a transactionId by the time we
      // see them; defensive guard.
      return;
    }

    if (incoming) {
      // Surface the incoming request to the UI; UI calls accept()
      // back via the request's `accept` method through our existing
      // verificationRequest event — for now we just emit. Auto-accept
      // would be a footgun.
      this.deps.emit({
        kind: 'verificationRequest',
        request: {
          transactionId: txnId,
          fromUser: (request.otherUserId ?? '') as UserId,
          fromDevice: (request.otherDeviceId ?? '') as DeviceId,
          methods: [...(request.methods ?? [])],
        },
      });
    }

    const onChange = () => this.handlePhaseChange(txnId, request).catch((err) => {
      // Silent recovery: a phase listener throw must NOT crash the
      // worker. Cancel + drop so the UI can show the error.
      // eslint-disable-next-line no-console
      console.warn('[verification] phase handler threw', err);
      void this.cancel(txnId);
    });

    request.on(VerificationRequestEvent.Change, onChange);

    this.active.set(txnId, {
      request,
      verifier: null,
      showSas: null,
      detach: () => {
        request.off(VerificationRequestEvent.Change, onChange);
      },
    });

    // Kick once to capture current phase (e.g. our own outgoing
    // request that may already be Ready by the time we attach).
    void onChange();
  }

  private async handlePhaseChange(
    txnId: string,
    request: VerificationRequest,
  ): Promise<void> {
    const active = this.active.get(txnId);
    if (!active) return;

    const phase = request.phase;

    if (phase === VerificationPhase.Started && !active.verifier) {
      // `request.verifier` is populated by startVerification on either
      // side; here we just wire up the verifier whenever it appears
      // so the SAS callbacks reach the UI.
      const verifier = request.verifier ?? null;
      if (verifier) {
        active.verifier = verifier;
        this.wireVerifier(txnId, verifier);
      }
    } else if (phase === VerificationPhase.Done) {
      this.deps.emit({
        kind: 'verificationProgress',
        transactionId: txnId,
        phase: 'done',
      });
      active.detach();
      this.active.delete(txnId);
    } else if (phase === VerificationPhase.Cancelled) {
      const reason =
        request.cancellationCode ??
        (request.cancellingUserId
          ? `cancelled by ${request.cancellingUserId}`
          : 'cancelled');
      this.deps.emit({
        kind: 'verificationProgress',
        transactionId: txnId,
        phase: 'cancelled',
        cancellationReason: reason,
      });
      active.detach();
      this.active.delete(txnId);
    } else if (phase === VerificationPhase.Ready) {
      // Outgoing flow: now switch to SAS by calling startVerification.
      // Incoming: defer until the UI calls accept(). For v1 we
      // auto-accept incoming requests (UI shows the SAS panel directly)
      // so user effort matches the outgoing flow.
      if (!active.verifier) {
        try {
          const verifier = await request.startVerification('m.sas.v1');
          active.verifier = verifier;
          this.wireVerifier(txnId, verifier);
        } catch (err) {
          // Other side may have raced us; Started phase will arrive
          // and we'll pick up request.verifier then.
          // eslint-disable-next-line no-console
          console.warn('[verification] startVerification failed', err);
        }
      }
      this.deps.emit({
        kind: 'verificationProgress',
        transactionId: txnId,
        phase: 'ready',
      });
    }
  }

  private wireVerifier(txnId: string, verifier: Verifier): void {
    const onShowSas = (callbacks: ShowSasCallbacks) => {
      const active = this.active.get(txnId);
      if (!active) return;
      active.showSas = callbacks;
      const sas = callbacks.sas;
      const emojis: SasEmoji[] = (sas.emoji ?? []).map(([emoji, description]) => ({
        emoji,
        description,
      }));
      this.deps.emit({
        kind: 'verificationProgress',
        transactionId: txnId,
        phase: 'sas_compare',
        sasEmojis: emojis,
      });
    };
    verifier.on(VerifierEvent.ShowSas, onShowSas);
    // Verifier's Cancel / Mismatch surface through the parent
    // request's Change event, so we don't need separate listeners.
  }
}
