/**
 * Ringtone / ringback generator (Phase 14.1).
 *
 * We synthesise tones via WebAudio rather than shipping audio assets:
 *   - zero network bytes, no Vercel asset config
 *   - the AudioContext is the same one the rest of the app already
 *     uses (chime, future call audio), so the user grants the
 *     audio permission exactly once
 *   - we get exact loop timing without fighting <audio>'s
 *     gapless-playback inconsistencies between browsers
 *
 * Two patterns, both modelled on classic PSTN cadence:
 *   - `incoming` — ITU-T E.180 standard ringing: two superposed tones
 *     (440 + 480 Hz) for 2s on, 4s off. This is the sound people
 *     unconsciously read as "phone ringing", and matches what Element
 *     and most softphones do.
 *   - `outgoing` — US ringback (440 Hz pure tone, 2s on, 4s off).
 *     Lets the caller know the other end is being signalled.
 *
 * Autoplay policy: AudioContext starts suspended until a user gesture
 * resumes it. For outbound calls that's fine — the user clicked the
 * call button. For inbound it's trickier: the page might be idle in
 * the background. We `resume()` best-effort; if it fails the visual
 * ring modal still appears, which is the more important channel.
 */

export type RingPattern = 'incoming' | 'outgoing';

interface ActiveRing {
  pattern: RingPattern;
  /** Whether `stop()` has been called — guards against late timer fires. */
  cancelled: boolean;
  /** Setinterval handle so we can clear it on stop. */
  cycleHandle: number | null;
  /** Currently-sounding oscillators so we can detune them on stop. */
  liveOscillators: OscillatorNode[];
  /** Gain node fronting the whole pattern; ramped down on stop. */
  gain: GainNode | null;
}

let ctx: AudioContext | null = null;
let active: ActiveRing | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  // Safari < 14 uses webkitAudioContext; we ignore that branch and
  // accept that older browsers get silent rings. The visual modal still
  // works on those browsers, and they're <1% of the share.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C: typeof AudioContext | undefined = window.AudioContext;
  if (!C) return null;
  ctx = new C();
  return ctx;
}

/**
 * Start a ringing pattern. Safe to call when something else is already
 * ringing — we replace the active pattern atomically. If WebAudio isn't
 * available we silently no-op; the visual call UI is the canonical
 * notification, ringtone is only the accent.
 */
export function startRinging(pattern: RingPattern): void {
  stopRinging();
  const ac = audioContext();
  if (!ac) return;
  // Resume best-effort. We don't await this — if the browser blocks
  // resume due to autoplay policy the ringtone will be silent, which
  // is acceptable.
  void ac.resume().catch(() => undefined);

  const ring: ActiveRing = {
    pattern,
    cancelled: false,
    cycleHandle: null,
    liveOscillators: [],
    gain: null,
  };
  active = ring;

  // Master gain — kept low so the ringtone never overshadows speech
  // from a parallel browser tab or notification. 0.18 lands roughly
  // where Element's ring sits at default OS volume.
  const masterGain = ac.createGain();
  masterGain.gain.value = 0.18;
  masterGain.connect(ac.destination);
  ring.gain = masterGain;

  const playOneBurst = () => {
    if (ring.cancelled || active !== ring) return;
    const now = ac.currentTime;
    const onMs = 2000;
    // Build either one (outgoing) or two (incoming) oscillators per
    // burst; we recreate them each cycle because OscillatorNode is
    // one-shot in WebAudio.
    const freqs = pattern === 'incoming' ? [440, 480] : [440];
    const oscs: OscillatorNode[] = [];
    for (const f of freqs) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      // Per-oscillator gain envelope so two superposed tones don't
      // exceed master headroom (each at 0.5).
      const oscGain = ac.createGain();
      oscGain.gain.setValueAtTime(0, now);
      oscGain.gain.linearRampToValueAtTime(0.5, now + 0.05);
      oscGain.gain.setValueAtTime(0.5, now + onMs / 1000 - 0.05);
      oscGain.gain.linearRampToValueAtTime(0, now + onMs / 1000);
      osc.connect(oscGain).connect(masterGain);
      osc.start(now);
      osc.stop(now + onMs / 1000);
      oscs.push(osc);
    }
    ring.liveOscillators = oscs;
  };

  // Fire immediately so the user hears something within ~50ms of the
  // invite arriving, then repeat. 6s cycle = 2s ring + 4s silence.
  playOneBurst();
  ring.cycleHandle = setInterval(playOneBurst, 6000) as unknown as number;
}

export function stopRinging(): void {
  const ring = active;
  if (!ring) return;
  ring.cancelled = true;
  if (ring.cycleHandle != null) {
    clearInterval(ring.cycleHandle);
    ring.cycleHandle = null;
  }
  if (ring.gain && ctx) {
    // Brief fade-out so we don't get a click on hangup.
    try {
      ring.gain.gain.cancelScheduledValues(ctx.currentTime);
      ring.gain.gain.setValueAtTime(ring.gain.gain.value, ctx.currentTime);
      ring.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
    } catch {
      // Some browsers throw if the param is in a weird state; safe to
      // ignore — the next ring will create a fresh node anyway.
    }
  }
  for (const osc of ring.liveOscillators) {
    try {
      osc.stop();
    } catch {
      // already stopped; OK
    }
  }
  ring.liveOscillators = [];
  ring.gain = null;
  active = null;
}
