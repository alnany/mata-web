/**
 * Global call store + signaling orchestrator (Phase 14).
 *
 * Responsibilities:
 *  - Hold the single active `CallSession` (1:1 only; v0 doesn't
 *    support concurrent calls — incoming-while-on-call rings as
 *    busy reject).
 *  - Pump `callSignal` worker events into the right session by
 *    `call_id`.
 *  - Expose a Solid signal `activeCall()` for the overlay UI.
 *
 * One CallSession per call_id. We key the registry by `call_id` so a
 * second invite under a different id can ride in as a new session
 * (used by the spec's call-replacement flow), though v0's UI only
 * surfaces the most recent.
 */
import { createSignal } from 'solid-js';
import type { EventId, RoomId, UserId } from '@mata/shared/matrix';
import type { IceServer, MatrixBridge, WorkerEvent } from '@mata/shared/rpc';
import {
  CallSession,
  type CallMedia,
  type CallSignalingPort,
  type CallSnapshot,
} from '../lib/webrtc-call.js';
import { startRinging, stopRinging } from '../lib/ringtone.js';
import { showToast } from './toast.js';
import { prettyName } from '../components/message-bubble.js';

interface SignalEvent extends Extract<WorkerEvent, { kind: 'callSignal' }> {}

const [activeCall, setActiveCall] = createSignal<CallSnapshot | null>(null);
const [localStream, setLocalStream] = createSignal<MediaStream | null>(null);
const [remoteStream, setRemoteStream] = createSignal<MediaStream | null>(null);

export { activeCall, localStream, remoteStream };

// We keep the live session out of the Solid signal — Solid would
// proxy it and break the WebRTC internals which expect raw object
// identity for the RTCPeerConnection event listeners.
let session: CallSession | null = null;
let myUserId: UserId | null = null;
let signaling: CallSignalingPort | null = null;
let initialized = false;

function bindSession(s: CallSession): void {
  session = s;
  let everAccepted = false;
  let ringerStarted = false;
  s.on('snapshot', (snap) => {
    setActiveCall(snap);
    // Phase 14.1 — ringtone management. We start the loop the first
    // time we see `ringing_in` (inbound side) or `ringing_out` (so
    // the caller gets a soft outgoing tone too) and stop the moment
    // we leave a ringing state. Keeping `ringerStarted` as a latch
    // avoids re-creating the WebAudio nodes on every snapshot tick.
    if (!ringerStarted && (snap.state === 'ringing_in' || snap.state === 'ringing_out')) {
      ringerStarted = true;
      startRinging(snap.state === 'ringing_in' ? 'incoming' : 'outgoing');
    }
    if (ringerStarted && snap.state !== 'ringing_in' && snap.state !== 'ringing_out') {
      ringerStarted = false;
      stopRinging();
    }
    if (snap.state === 'connecting' || snap.state === 'connected') {
      everAccepted = true;
    }
    // Auto-clear on `ended` after a brief delay so the user can see
    // the "Call ended" state for a beat before the overlay vanishes.
    if (snap.state === 'ended') {
      // Missed-call surface (Phase 14.1). If we ended without ever
      // accepting and we were the receiving side, surface a toast so
      // the call doesn't just disappear silently — Matrix has no
      // "missed call" timeline event yet, so the toast is our only
      // breadcrumb. Outbound endings show their own error text via
      // the overlay's last frame; no need to double-notify.
      if (!everAccepted && snap.direction === 'inbound') {
        showToast('info', `Missed call from ${prettyName(snap.peerUserId ?? undefined)}`, 6000);
      }
      setTimeout(() => {
        if (session === s) {
          session = null;
          setActiveCall(null);
          setLocalStream(null);
          setRemoteStream(null);
        }
      }, 1500);
    }
  });
  s.on('localStream', (st) => setLocalStream(st));
  s.on('remoteStream', (st) => setRemoteStream(st));
  setActiveCall(s.snapshot());
}

/**
 * Wire the store to the worker bridge. Call once on app boot AFTER
 * we know `myUserId`. Safe to call multiple times — subsequent calls
 * just refresh the user id (e.g. after re-login).
 */
export function initCallStore(bridge: MatrixBridge, mxid: UserId): void {
  myUserId = mxid;
  signaling = {
    async send(roomId: RoomId, eventType: string, content: Record<string, unknown>) {
      const res = await bridge.request({
        kind: 'sendCallEvent',
        roomId,
        eventType,
        content,
      });
      if (res.kind !== 'sendCallEvent') throw new Error('unexpected response');
      return res.eventId;
    },
    async getIceServers(): Promise<IceServer[]> {
      const res = await bridge.request({ kind: 'getTurnServers' });
      if (res.kind !== 'getTurnServers') return [];
      return res.iceServers;
    },
  };

  if (initialized) return;
  initialized = true;

  bridge.on('callSignal', (evt: SignalEvent) => {
    void routeSignal(evt);
  });
}

async function routeSignal(evt: SignalEvent): Promise<void> {
  if (!signaling || !myUserId) return;
  const callId =
    typeof evt.content.call_id === 'string' ? (evt.content.call_id as string) : null;
  if (!callId) return;

  // Self-echo guard. With the worker no longer filtering by sender
  // MXID (so same-account multi-device works), our own sent events
  // come back through sync. MSC2746's `party_id` is the per-device
  // identifier — if it matches the partyId of our currently bound
  // session for this callId, this event originated on this very
  // device and routing it would mis-fire the state machine (e.g.
  // an inbound `m.call.invite` echo would try to spawn a second
  // session, hit the busy branch, and reject our own call).
  if (session && session.callId === callId && evt.partyId && evt.partyId === session.partyId) {
    return;
  }

  // Inbound invite — only create a new session if we don't already
  // have an active one. If we do, send a hangup as busy.
  if (evt.eventType === 'm.call.invite') {
    if (session && session.state !== 'idle' && session.state !== 'ended') {
      // Busy. Decline politely so the caller's UI updates.
      await signaling
        .send(evt.roomId, 'm.call.hangup', {
          call_id: callId,
          version: '1',
          party_id: 'busy',
          reason: 'user_busy',
        })
        .catch(() => undefined);
      return;
    }
    const newSession = new CallSession(signaling, myUserId, {
      callId,
      roomId: evt.roomId,
      direction: 'inbound',
      media: 'audio', // will be refined inside receiveInvite by SDP peek
      peerUserId: evt.sender,
    });
    bindSession(newSession);
    const ringing = await newSession.receiveInvite(evt.content, evt.ageMs);
    if (!ringing) {
      // Stale invite; clear it silently.
      session = null;
      setActiveCall(null);
    }
    return;
  }

  // Subsequent events: route to existing session if call_id matches.
  if (!session || session.callId !== callId) return;
  switch (evt.eventType) {
    case 'm.call.answer':
      await session.receiveAnswer(evt.content);
      break;
    case 'm.call.candidates':
      await session.receiveCandidates(evt.content);
      break;
    case 'm.call.hangup':
      session.receiveHangup(evt.content);
      break;
    case 'm.call.reject':
      session.receiveReject(evt.content);
      break;
    case 'm.call.select_answer':
      // We were the inbound side and we were selected — nothing to do
      // on our end; the caller has already committed. If we were NOT
      // selected we'd hang up here, but the v0 flow only supports a
      // single answering device per user so this is a no-op.
      break;
    default:
      // m.call.negotiate (renegotiation), m.call.replaces (transfer)
      // — out of scope for v0. We ignore rather than fail.
      break;
  }
}

/**
 * Place an outbound call. Returns once the invite is on the wire (or
 * throws if it failed). Subsequent state updates flow through
 * `activeCall()`.
 */
export async function placeCall(
  roomId: RoomId,
  peerUserId: UserId | null,
  media: CallMedia,
): Promise<void> {
  if (!signaling || !myUserId) throw new Error('Call store not initialized');
  if (session && session.state !== 'idle' && session.state !== 'ended') {
    throw new Error('Another call is already active');
  }
  const callId = freshCallId();
  const s = new CallSession(signaling, myUserId, {
    callId,
    roomId,
    direction: 'outbound',
    media,
    peerUserId,
  });
  bindSession(s);
  await s.place();
}

export async function acceptActive(): Promise<void> {
  if (!session) return;
  await session.accept();
}

export async function rejectActive(): Promise<void> {
  if (!session) return;
  await session.reject();
}

export async function hangupActive(): Promise<void> {
  if (!session) return;
  await session.hangup();
}

export function toggleActiveMic(): void {
  session?.toggleMic();
}

export function toggleActiveVideo(): void {
  session?.toggleVideo();
}

function freshCallId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Type re-export so consumers don't have to dig into the lib path.
export type { CallSnapshot, CallMedia };
// Silence unused-import linter — EventId is reserved for future
// `sentEventId` plumbing that surfaces ack state per signaling msg.
type _Reserved = EventId;

/**
 * Ringtone — pure WebAudio so we don't ship audio assets in the
 * bundle (no .mp3, no fetch). The "incoming" pattern is the classic
 * Matrix ringer (two tones with a small gap, looping every ~2s).
 * The "outgoing" pattern is a softer single tone every ~2s, modelled
 * after the Telegram outgoing ring. Both fade in/out by 30ms so we
 * don't pop the speakers.
 *
 * Browser autoplay note: AudioContext is allowed to play whenever it
 * was created in response to a user gesture. For the outgoing case
 * that's always true (the user clicked the call button). For
 * incoming, the user opened the tab themselves so most browsers (and
 * specifically Chromium / Firefox stable) allow it; Safari iOS may
 * silently fail. We don't fight that — the visual modal is the
 * authoritative "you're being called" surface; the ringtone is a
 * bonus.
 */
const ringtone = (() => {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;
  let stopped = true;

  function ensureCtx(): AudioContext | null {
    if (ctx) return ctx;
    const AC =
      typeof window !== 'undefined'
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window.AudioContext ?? (window as any).webkitAudioContext)
        : null;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function blip(freq: number, durationMs: number, gain: number): void {
    const c = ctx;
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Attack/release envelope to keep the tone smooth.
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.03);
    g.gain.linearRampToValueAtTime(gain, t0 + durationMs / 1000 - 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + durationMs / 1000);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
  }

  function pattern(mode: 'incoming' | 'outgoing'): void {
    if (stopped) return;
    if (!ensureCtx()) return;
    if (mode === 'incoming') {
      // Two tones, 200ms each, 80ms gap.
      blip(750, 200, 0.18);
      setTimeout(() => !stopped && blip(550, 200, 0.18), 280);
    } else {
      blip(420, 300, 0.08);
    }
  }

  return {
    start(mode: 'incoming' | 'outgoing'): void {
      stopped = false;
      if (!ensureCtx()) return;
      // Resume context if it auto-suspended (Chrome does this on
      // cross-origin iframe wake; harmless for us but kept defensive).
      void ctx?.resume().catch(() => undefined);
      pattern(mode);
      if (timer != null) clearInterval(timer);
      timer = setInterval(() => pattern(mode), 2000) as unknown as number;
    },
    stop(): void {
      stopped = true;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
})();
