/**
 * Voice-message helpers — recording mime negotiation + waveform
 * extraction for MSC3245 voice messages.
 *
 * A "voice message" on the wire is an `m.audio` event carrying two
 * extra content keys:
 *   - `org.matrix.msc3245.voice: {}`            → marks it a voice note
 *   - `org.matrix.msc1767.audio: { duration, waveform }`
 *
 * `waveform` is an array of integers in the range 0..1024 (per MSC1767)
 * describing perceived loudness over time. We render it as a bar graph
 * in the bubble; Element reads the same shape, so our voice notes are
 * interoperable.
 */

/** MSC1767 caps the waveform at 1024 samples; ~64 reads cleanly at bubble width. */
export const WAVEFORM_BUCKETS = 64;
const WAVEFORM_MAX = 1024;

/**
 * Pick the first MediaRecorder mime type the browser actually supports.
 * Opus in WebM/OGG is preferred (small + ubiquitous); Safari only does
 * mp4/aac, so it's the final fallback. Returns null if recording isn't
 * supported at all.
 */
export function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // isTypeSupported can throw on some engines — treat as unsupported.
    }
  }
  return null;
}

/** True if the runtime can record audio at all. */
export function canRecordVoice(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    pickRecordingMime() !== null
  );
}

export interface VoiceWaveform {
  /** Clip duration in milliseconds. */
  durationMs: number;
  /** WAVEFORM_BUCKETS integers, each 0..1024 (MSC1767). */
  waveform: number[];
}

/**
 * Decode a recorded audio blob and downsample it into a small, gamma-
 * corrected loudness waveform suitable for the bubble bar graph.
 *
 * Decoding can fail (corrupt clip, unsupported container on this engine)
 * — callers should fall back to a flat placeholder waveform so the voice
 * note still sends.
 */
export async function computeWaveform(
  blob: Blob,
  buckets = WAVEFORM_BUCKETS,
): Promise<VoiceWaveform> {
  const Ctx: typeof AudioContext =
    (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const channel = audio.getChannelData(0);
    const total = channel.length;
    const per = Math.max(1, Math.floor(total / buckets));
    const peaks: number[] = [];
    let max = 0;
    for (let b = 0; b < buckets; b++) {
      const start = b * per;
      const end = Math.min(total, start + per);
      let sumSq = 0;
      for (let i = start; i < end; i++) {
        const s = channel[i] ?? 0;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, end - start));
      peaks.push(rms);
      if (rms > max) max = rms;
    }
    // Normalize → gamma (0.7 lifts quiet passages so the bars read) →
    // quantize to 0..1024 ints.
    const waveform = peaks.map((p) => {
      const norm = max > 0 ? p / max : 0;
      const shaped = norm ** 0.7;
      return Math.max(0, Math.min(WAVEFORM_MAX, Math.round(shaped * WAVEFORM_MAX)));
    });
    return { durationMs: Math.round(audio.duration * 1000), waveform };
  } finally {
    void ctx.close().catch(() => {});
  }
}

/** Flat fallback waveform when decoding fails but we still want to send. */
export function flatWaveform(buckets = WAVEFORM_BUCKETS): number[] {
  return new Array(buckets).fill(Math.round(WAVEFORM_MAX * 0.25));
}

/** Normalize an arbitrary waveform array down to 0..1 floats for rendering. */
export function normalizeWaveform(raw: number[] | undefined): number[] {
  if (!raw || raw.length === 0) return new Array(WAVEFORM_BUCKETS).fill(0.25);
  return raw.map((v) => Math.max(0, Math.min(1, v / WAVEFORM_MAX)));
}

/** mm:ss formatter for durations given in milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
