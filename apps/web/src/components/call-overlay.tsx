/**
 * Call overlay (Phase 14).
 *
 * Single source of truth for what the user sees during a 1:1 call:
 *   - Inbound ringing  → big accept/decline modal, centered
 *   - Outbound ringing → small floating card, top-right, with hangup
 *   - Connecting / connected → floating card with timer + mic/video/hangup
 *   - Ended            → 1.5s fade with last-known reason, then unmounts
 *
 * The overlay reads from `activeCall()` + `localStream()`/`remoteStream()`
 * in the call store; it never owns peer-connection state. That stays in
 * `CallSession` so a HMR-driven remount of this component doesn't kill
 * the call.
 */
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import {
  acceptActive,
  activeCall,
  hangupActive,
  localStream,
  rejectActive,
  remoteStream,
  toggleActiveMic,
  toggleActiveVideo,
} from '../stores/call.js';
import { prettyName } from './message-bubble.js';

export function CallOverlay() {
  const snap = activeCall;
  return (
    <Show when={snap()}>
      {(s) => {
        const state = () => s().state;
        if (state() === 'ringing_in') return <IncomingCallModal />;
        return <ActiveCallCard />;
      }}
    </Show>
  );
}

function IncomingCallModal() {
  const s = activeCall;
  const peer = () => s()?.peerUserId ?? 'Unknown';
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div class="w-[320px] rounded-2xl bg-white p-6 text-center shadow-2xl dark:bg-neutral-900">
        <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-mata-500/20 text-3xl">
          📞
        </div>
        <p class="text-xs uppercase tracking-wide text-neutral-500">Incoming {s()?.media} call</p>
        <h2 class="mt-1 text-lg font-semibold">{prettyName(peer())}</h2>
        <div class="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => void rejectActive()}
            class="rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => void acceptActive()}
            class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveCallCard() {
  const s = activeCall;
  const [elapsed, setElapsed] = createSignal('');

  // Tick the duration display once per second when connected. Stop
  // ticking as soon as we leave `connected` so we don't paint a moving
  // timer on the "Call ended" state.
  createEffect(() => {
    const snap = s();
    if (!snap || snap.state !== 'connected' || !snap.connectedAt) {
      setElapsed('');
      return;
    }
    const startedAt = snap.connectedAt;
    const tick = () => setElapsed(formatDuration(Date.now() - startedAt));
    tick();
    const id = setInterval(tick, 1000);
    onCleanup(() => clearInterval(id));
  });

  const headline = createMemo(() => {
    const snap = s();
    if (!snap) return '';
    switch (snap.state) {
      case 'creating_offer':
      case 'ringing_out':
        return 'Calling…';
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return elapsed() || '00:00';
      case 'ended':
        return snap.errorMessage ?? 'Call ended';
      default:
        return '';
    }
  });

  return (
    <div class="fixed right-4 top-4 z-40 w-[300px] rounded-2xl bg-white p-3 shadow-2xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 shrink-0 rounded-full bg-mata-500/20 text-center text-xl leading-10">
          {s()?.media === 'video' ? '🎥' : '📞'}
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold">{prettyName(s()?.peerUserId ?? '')}</div>
          <div class="truncate text-xs text-neutral-500">{headline()}</div>
        </div>
      </div>

      {/* Remote video tile, only for video calls. The element is
          mounted whenever we have a stream so srcObject assignment
          stays simple. Audio-only calls hide the tile but the audio
          tracks still play via the hidden audio element below. */}
      <Show when={s()?.media === 'video' && remoteStream()}>
        <video
          autoplay
          playsinline
          class="mt-3 aspect-video w-full rounded-lg bg-black object-cover"
          ref={(el) => bindStream(el, remoteStream)}
        />
      </Show>

      {/* Local self-view, smaller, only for video. */}
      <Show when={s()?.media === 'video' && localStream()}>
        <video
          autoplay
          playsinline
          muted
          class="mt-2 aspect-video w-1/2 rounded-lg bg-black object-cover"
          ref={(el) => bindStream(el, localStream)}
        />
      </Show>

      {/* Audio sink — invisible, autoplays remote audio for both
          voice and video calls. We use a separate <audio> rather than
          relying on <video>'s audio output so muting the local
          preview never affects the peer's audio. */}
      <Show when={remoteStream()}>
        <audio autoplay class="hidden" ref={(el) => bindStream(el, remoteStream)} />
      </Show>

      <div class="mt-3 flex justify-center gap-2">
        <button
          type="button"
          onClick={toggleActiveMic}
          class={`rounded-full px-3 py-1.5 text-xs font-medium ${
            s()?.micMuted
              ? 'bg-red-500 text-white'
              : 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'
          }`}
        >
          {s()?.micMuted ? 'Unmute' : 'Mute'}
        </button>
        <Show when={s()?.media === 'video'}>
          <button
            type="button"
            onClick={toggleActiveVideo}
            class={`rounded-full px-3 py-1.5 text-xs font-medium ${
              s()?.videoOff
                ? 'bg-red-500 text-white'
                : 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'
            }`}
          >
            {s()?.videoOff ? 'Video on' : 'Video off'}
          </button>
        </Show>
        <button
          type="button"
          onClick={() => void hangupActive()}
          disabled={s()?.state === 'ended'}
          class="rounded-full bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          End
        </button>
      </div>
    </div>
  );
}

/**
 * Bind a Solid stream accessor to a media element's srcObject. We
 * watch the accessor in an effect so when the stream is swapped (e.g.
 * remote renegotiation) the element re-points without leaking.
 */
function bindStream(
  el: HTMLMediaElement,
  accessor: () => MediaStream | null,
): void {
  createEffect(() => {
    const stream = accessor();
    if (el.srcObject !== stream) {
      // null-safe: setting srcObject = null detaches cleanly.
      // Re-binding the same stream is a no-op in Chromium but Firefox
      // restarts decode; the identity check above avoids that.
      el.srcObject = stream;
    }
  });
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
