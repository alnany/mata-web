// =============================================================================
// VerificationModal — single global overlay for SAS device verification.
//
// State source: stores/verification.ts. Mounted at app root so it
// renders regardless of which route is active, and so incoming SAS
// requests (peer-initiated) trigger the same dialog as outgoing ones.
//
// Phase mapping (UI labels in parens):
//   requesting   — "Waiting for the other device…"
//   incoming     — "<user> wants to verify a session" + Accept / Decline
//   sas_compare  — the seven-emoji grid + They match / They don't
//   verifying    — locally optimistic between confirm() and Done
//   done         — green check, auto-dismisses after 2.5s
//   cancelled    — red message with cancellation reason; manual close
//
// We render emojis in a 4-3 staggered grid (Element's layout) so
// 7 items align visually. The description under each emoji is part
// of the spec — both ends must show the same canonical description
// so the user can disambiguate similar emojis ("dog" vs "puppy" etc).
// =============================================================================

import { createEffect, For, Match, onCleanup, Show, Switch } from 'solid-js';
import { useBridge } from '../bridge/context.js';
import {
  activeFlow,
  clearVerificationFlow,
  type VerificationFlow,
} from '../stores/verification.js';
import { prettyName } from './message-bubble.js';
import { showToast } from '../stores/toast.js';

export function VerificationModal() {
  const bridge = useBridge();

  // Auto-dismiss `done` after 2.5s so the dialog doesn't linger.
  // Cancelled stays until the user clicks Close so they can read the
  // reason — important when the peer aborted (we want it sticky).
  createEffect(() => {
    const f = activeFlow();
    if (f?.phase === 'done') {
      const t = setTimeout(() => clearVerificationFlow(), 2500);
      onCleanup(() => clearTimeout(t));
    }
  });

  const confirmMatch = async () => {
    const f = activeFlow();
    if (!f) return;
    try {
      await bridge.request({
        kind: 'completeSasVerification',
        transactionId: f.transactionId,
        result: 'match',
      });
      // Worker emits 'done' through the progress channel; we just
      // wait for it. No optimistic flip — if the peer raced into
      // mismatch we want the truth.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Verification failed: ${msg}`);
    }
  };

  const reportMismatch = async () => {
    const f = activeFlow();
    if (!f) return;
    try {
      await bridge.request({
        kind: 'completeSasVerification',
        transactionId: f.transactionId,
        result: 'mismatch',
      });
    } catch (err) {
      // Mismatch is still a cancel on the wire; tolerant errors only.
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Couldn't report mismatch: ${msg}`);
    }
  };

  const close = async () => {
    const f = activeFlow();
    if (!f) return;
    if (f.phase !== 'done' && f.phase !== 'cancelled' && f.transactionId) {
      try {
        await bridge.request({
          kind: 'cancelVerification',
          transactionId: f.transactionId,
        });
      } catch {
        // best-effort
      }
    }
    clearVerificationFlow();
  };

  return (
    <Show when={activeFlow()}>
      {(flow) => <ModalBody flow={flow()} onMatch={confirmMatch} onMismatch={reportMismatch} onClose={close} />}
    </Show>
  );
}

function ModalBody(props: {
  flow: VerificationFlow;
  onMatch: () => void;
  onMismatch: () => void;
  onClose: () => void;
}) {
  const otherLabel = () => prettyName(props.flow.otherUserId);
  const deviceLabel = () =>
    props.flow.otherDeviceId === ('UNKNOWN' as string) ? 'this session' : props.flow.otherDeviceId;

  return (
    <div class="fixed inset-0 z-40 flex items-center justify-center" role="dialog" aria-modal>
      <div class="absolute inset-0 bg-black/50" onClick={props.onClose} />
      <div class="relative z-10 w-[440px] max-w-[92vw] rounded-2xl bg-elev p-6 shadow-2xl">
        <header class="mb-4 flex items-start justify-between">
          <div>
            <h2 class="text-base font-semibold">Verify session</h2>
            <p class="mt-0.5 text-xs text-fg-3">
              {otherLabel()}
              <span class="ml-1.5 font-mono text-[10px] text-fg-3">
                {deviceLabel()}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded p-1 text-fg-3 hover:bg-input hover:text-fg-2"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <Switch>
          <Match when={props.flow.phase === 'requesting' || props.flow.phase === 'incoming'}>
            <WaitingState
              kind={props.flow.phase as 'requesting' | 'incoming'}
              who={otherLabel()}
              onCancel={props.onClose}
            />
          </Match>
          <Match when={props.flow.phase === 'sas_compare'}>
            <SasCompare
              emojis={props.flow.sasEmojis}
              onMatch={props.onMatch}
              onMismatch={props.onMismatch}
            />
          </Match>
          <Match when={props.flow.phase === 'verifying'}>
            <CenteredMessage emoji="⏳" title="Finalizing…" />
          </Match>
          <Match when={props.flow.phase === 'done'}>
            <CenteredMessage
              emoji="✅"
              title="Session verified"
              detail="Future messages from this device will be marked as trusted."
            />
          </Match>
          <Match when={props.flow.phase === 'cancelled'}>
            <CenteredMessage
              emoji="❌"
              title="Verification stopped"
              detail={props.flow.errorReason ?? 'The other side cancelled.'}
              detailTone="warn"
            />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function WaitingState(props: {
  kind: 'requesting' | 'incoming';
  who: string;
  onCancel: () => void;
}) {
  return (
    <div class="flex flex-col items-center py-6 text-center">
      <div class="mb-3 text-4xl">🔐</div>
      <p class="text-sm font-medium">
        {props.kind === 'requesting'
          ? `Waiting for ${props.who}'s device to accept…`
          : `${props.who} wants to verify this session.`}
      </p>
      <p class="mt-1 text-xs text-fg-3">
        On the other device, accept the request to compare emojis.
      </p>
      <button
        type="button"
        onClick={props.onCancel}
        class="mt-5 rounded-md border border-line px-3 py-1.5 text-xs text-fg-2 hover:bg-elev"
      >
        Cancel
      </button>
    </div>
  );
}

function SasCompare(props: {
  emojis: { emoji: string; description: string }[];
  onMatch: () => void;
  onMismatch: () => void;
}) {
  return (
    <div>
      <p class="text-xs text-fg-2">
        Compare the emojis with the other device. They must be in the same order.
      </p>
      <div class="my-5 grid grid-cols-4 gap-2 px-1">
        <For each={props.emojis}>
          {(e) => (
            <div class="flex flex-col items-center rounded-lg border border-line bg-elev py-3">
              <div class="text-2xl leading-none">{e.emoji}</div>
              <div class="mt-1.5 text-[10px] capitalize text-fg-2">
                {e.description}
              </div>
            </div>
          )}
        </For>
        {/* spec is 7 emojis — last cell is filler so the 4-3 grid stays even */}
        <Show when={props.emojis.length === 7}>
          <div aria-hidden class="invisible" />
        </Show>
      </div>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={props.onMismatch}
          class="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          They don't match
        </button>
        <button
          type="button"
          onClick={props.onMatch}
          class="rounded-md bg-mata-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-mata-700"
        >
          They match
        </button>
      </div>
    </div>
  );
}

function CenteredMessage(props: {
  emoji: string;
  title: string;
  detail?: string;
  detailTone?: 'warn';
}) {
  return (
    <div class="flex flex-col items-center py-6 text-center">
      <div class="mb-3 text-4xl">{props.emoji}</div>
      <p class="text-sm font-medium">{props.title}</p>
      <Show when={props.detail}>
        <p
          class="mt-1 text-xs"
          classList={{
            'text-fg-3': props.detailTone !== 'warn',
            'text-amber-600 dark:text-amber-400': props.detailTone === 'warn',
          }}
        >
          {props.detail}
        </p>
      </Show>
    </div>
  );
}
