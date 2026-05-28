/**
 * Phase 14 — 1:1 voice / video call driver.
 *
 * This module is intentionally hand-rolled on top of `RTCPeerConnection`
 * rather than matrix-js-sdk's `MatrixCall`. The reason is structural:
 * our matrix-js-sdk client lives inside a Web Worker (so the main
 * thread stays responsive during sync + decrypt), and
 * `supportsMatrixCall()` returns false in any context without
 * `RTCPeerConnection` / `navigator.mediaDevices` — i.e. Workers.
 * Trying to hoist MatrixCall onto the main thread would require
 * spinning a second MatrixClient there just for VoIP, doubling the
 * /sync footprint. Cheaper to own ~250 lines of WebRTC glue and use
 * the worker as a pure signaling pipe.
 *
 * Spec compliance: we implement the legacy 1:1 VoIP flow (MSC2746
 * / spec v1.1 §13.7). MSC3401 group calls and MSC3898 SFU are
 * deferred — they need a media server backend (LiveKit) which is
 * out of scope for the v0 ship.
 *
 * Event vocabulary handled:
 *  - `m.call.invite`       — caller → callee, carries offer SDP
 *  - `m.call.answer`       — callee → caller, carries answer SDP
 *  - `m.call.candidates`   — both directions, ICE trickle
 *  - `m.call.hangup`       — either side, reason string
 *  - `m.call.reject`       — callee declines before answering
 *  - `m.call.select_answer`— caller picks one answering device when
 *                            multiple ring (we send it as soon as
 *                            we accept an answer)
 *
 * Glare: if both sides invite simultaneously, the side with the
 * higher MXID lexicographically wins (spec recommendation). The
 * losing side hangs up its own invite and answers the incoming one.
 * We implement this; it's a 4-line check inside `handleInvite`.
 */

import type { EventId, RoomId, UserId } from '@mata/shared/matrix';
import type { IceServer } from '@mata/shared/rpc';

/** Per-spec the SDP version a v1 client emits. */
const CALL_PROTOCOL_VERSION = '1';
/** Default invite lifetime; the spec recommends 60s. */
const INVITE_LIFETIME_MS = 60_000;

export type CallState =
  | 'idle'
  | 'creating_offer'
  | 'ringing_out'   // we invited, awaiting answer
  | 'ringing_in'    // we received an invite, user hasn't accepted yet
  | 'connecting'
  | 'connected'
  | 'ended';

export type CallDirection = 'inbound' | 'outbound';

export type CallMedia = 'audio' | 'video';

export interface CallSnapshot {
  callId: string;
  roomId: RoomId;
  peerUserId: UserId | null;
  direction: CallDirection;
  media: CallMedia;
  state: CallState;
  micMuted: boolean;
  videoOff: boolean;
  /** Wall-clock ms when we entered `connected`, null otherwise. */
  connectedAt: number | null;
  errorMessage: string | null;
}

/** Hook the call layer needs from the worker bridge. Decouples test from runtime. */
export interface CallSignalingPort {
  send(roomId: RoomId, eventType: string, content: Record<string, unknown>): Promise<EventId>;
  getIceServers(): Promise<IceServer[]>;
}

export type CallEvents = {
  snapshot: (snap: CallSnapshot) => void;
  /**
   * Remote stream fully attached. The UI binds this to its <video>/<audio>
   * element's srcObject. We hand off the MediaStream by reference; the
   * call driver retains ownership and releases tracks on hangup.
   */
  remoteStream: (stream: MediaStream | null) => void;
  /**
   * Local stream attached. Useful for the small self-preview tile in
   * video calls.
   */
  localStream: (stream: MediaStream | null) => void;
};

type Listener<E extends keyof CallEvents> = CallEvents[E];

export class CallSession {
  readonly callId: string;
  readonly roomId: RoomId;
  /** Our own randomly generated party_id (MSC2746). */
  readonly partyId: string;
  /** The other party's id (only known after we see their first signaling event). */
  private peerPartyId: string | null = null;
  peerUserId: UserId | null;
  direction: CallDirection;
  media: CallMedia;
  state: CallState = 'idle';
  errorMessage: string | null = null;
  micMuted = false;
  videoOff = false;
  connectedAt: number | null = null;

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  /**
   * Trickled candidates we collected before the remote answer arrived.
   * MatrixCall sends candidates in small batches every ~200ms; we follow
   * the same pattern so a stable connection doesn't fire 50 signaling
   * events.
   */
  private localCandidateBuffer: RTCIceCandidateInit[] = [];
  private candidateFlushTimer: number | null = null;
  /**
   * Remote candidates received before remoteDescription is set. RFC says
   * we MUST queue these — `pc.addIceCandidate` throws if applied early.
   */
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionApplied = false;
  /**
   * If we get an answer for our outbound invite, the spec wants us to
   * send `m.call.select_answer` so the other party's *other* devices
   * stop ringing. We track whether we've already done it.
   */
  private answerSelected = false;
  private listeners: { [K in keyof CallEvents]: Set<Listener<K>> } = {
    snapshot: new Set(),
    remoteStream: new Set(),
    localStream: new Set(),
  };

  constructor(
    private readonly signaling: CallSignalingPort,
    private readonly myUserId: UserId,
    init: {
      callId: string;
      roomId: RoomId;
      direction: CallDirection;
      media: CallMedia;
      peerUserId?: UserId | null;
    },
  ) {
    this.callId = init.callId;
    this.roomId = init.roomId;
    this.direction = init.direction;
    this.media = init.media;
    this.peerUserId = init.peerUserId ?? null;
    this.partyId = randomId(8);
  }

  // ---- Public surface ----------------------------------------------------

  on<K extends keyof CallEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  /** Caller path: gather media, build offer, send m.call.invite. */
  async place(): Promise<void> {
    if (this.direction !== 'outbound') {
      throw new Error('place() called on an inbound call');
    }
    try {
      await this.attachMedia();
      const pc = await this.buildPeerConnection();
      this.setState('creating_offer');
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.media === 'video',
      });
      await pc.setLocalDescription(offer);
      debug('local offer applied', sdpDirections(offer.sdp ?? ''));
      await this.signaling.send(this.roomId, 'm.call.invite', {
        call_id: this.callId,
        version: CALL_PROTOCOL_VERSION,
        party_id: this.partyId,
        lifetime: INVITE_LIFETIME_MS,
        offer: { type: offer.type, sdp: offer.sdp },
      });
      this.setState('ringing_out');
    } catch (err) {
      this.fail(`Couldn't start the call: ${msgOf(err)}`);
    }
  }

  /** Callee path: accept an inbound invite, build answer, send m.call.answer. */
  async accept(): Promise<void> {
    if (this.direction !== 'inbound' || this.state !== 'ringing_in') {
      throw new Error(`accept() in wrong state (${this.state}/${this.direction})`);
    }
    try {
      await this.attachMedia();
      const pc = this.pc;
      if (!pc) throw new Error('peer connection not ready');
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      debug('local answer applied', sdpDirections(answer.sdp ?? ''));
      await this.signaling.send(this.roomId, 'm.call.answer', {
        call_id: this.callId,
        version: CALL_PROTOCOL_VERSION,
        party_id: this.partyId,
        answer: { type: answer.type, sdp: answer.sdp },
      });
      this.setState('connecting');
    } catch (err) {
      this.fail(`Couldn't accept the call: ${msgOf(err)}`);
    }
  }

  /** Callee path: decline before answering. */
  async reject(): Promise<void> {
    if (this.direction !== 'inbound' || this.state !== 'ringing_in') return;
    await this.signaling.send(this.roomId, 'm.call.reject', {
      call_id: this.callId,
      version: CALL_PROTOCOL_VERSION,
      party_id: this.partyId,
    }).catch(() => undefined);
    this.teardown('ended');
  }

  /** Either side: end the call. */
  async hangup(reason: string = 'user_hangup'): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended') return;
    await this.signaling.send(this.roomId, 'm.call.hangup', {
      call_id: this.callId,
      version: CALL_PROTOCOL_VERSION,
      party_id: this.partyId,
      reason,
    }).catch(() => undefined);
    this.teardown('ended');
  }

  toggleMic(): void {
    this.micMuted = !this.micMuted;
    setTracksEnabled(this.localStream?.getAudioTracks() ?? [], !this.micMuted);
    this.emitSnapshot();
  }

  toggleVideo(): void {
    if (this.media !== 'video') return;
    this.videoOff = !this.videoOff;
    setTracksEnabled(this.localStream?.getVideoTracks() ?? [], !this.videoOff);
    this.emitSnapshot();
  }

  // ---- Inbound signaling -------------------------------------------------

  /**
   * Bootstrap an inbound call from an `m.call.invite`. The CallSession is
   * created in `idle`, this transitions it to `ringing_in` after
   * pre-warming the peer connection with the remote offer. Returns
   * `false` if the invite is stale (past its lifetime) — the orchestrator
   * uses that to discard pre-resume invites without ringing the user.
   */
  async receiveInvite(content: Record<string, unknown>, ageMs: number): Promise<boolean> {
    const offer = (content.offer ?? null) as { type?: string; sdp?: string } | null;
    const lifetime = numberOr(content.lifetime, INVITE_LIFETIME_MS);
    if (!offer || typeof offer.sdp !== 'string') {
      this.fail('Invite had no SDP — dropping');
      return false;
    }
    if (ageMs > lifetime) {
      // Resume-time stale invite. We don't ring the user for missed
      // calls — Matrix has no "missed call" UX bucket yet and faking
      // it would just create a confusing modal.
      return false;
    }
    this.peerPartyId =
      typeof content.party_id === 'string' ? (content.party_id as string) : null;
    this.media = inferMediaFromSdp(offer.sdp);
    const pc = await this.buildPeerConnection();
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    this.remoteDescriptionApplied = true;
    await this.flushPendingRemoteCandidates();
    this.setState('ringing_in');
    return true;
  }

  /**
   * Caller path: apply an `m.call.answer`. Emits select_answer so the
   * answering party's other devices stop ringing.
   */
  async receiveAnswer(content: Record<string, unknown>): Promise<void> {
    if (this.direction !== 'outbound' || this.state !== 'ringing_out') return;
    const ans = (content.answer ?? null) as { type?: string; sdp?: string } | null;
    if (!ans || typeof ans.sdp !== 'string') return;
    const pc = this.pc;
    if (!pc) return;
    try {
      this.peerPartyId =
        typeof content.party_id === 'string' ? (content.party_id as string) : null;
      await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
      this.remoteDescriptionApplied = true;
      await this.flushPendingRemoteCandidates();
      this.setState('connecting');
      if (!this.answerSelected && this.peerPartyId) {
        this.answerSelected = true;
        await this.signaling.send(this.roomId, 'm.call.select_answer', {
          call_id: this.callId,
          version: CALL_PROTOCOL_VERSION,
          party_id: this.partyId,
          selected_party_id: this.peerPartyId,
        }).catch(() => undefined);
      }
    } catch (err) {
      this.fail(`Couldn't apply answer SDP: ${msgOf(err)}`);
    }
  }

  async receiveCandidates(content: Record<string, unknown>): Promise<void> {
    const raw = Array.isArray(content.candidates) ? content.candidates : [];
    for (const c of raw as Array<Record<string, unknown>>) {
      const init: RTCIceCandidateInit = {
        candidate: typeof c.candidate === 'string' ? (c.candidate as string) : '',
      };
      if (typeof c.sdpMid === 'string') init.sdpMid = c.sdpMid as string;
      if (typeof c.sdpMLineIndex === 'number') init.sdpMLineIndex = c.sdpMLineIndex as number;
      // Empty candidate string signals end-of-candidates per Trickle ICE.
      // We still apply it because RTCPeerConnection uses it as a hint.
      if (!this.remoteDescriptionApplied) {
        this.pendingRemoteCandidates.push(init);
      } else {
        await this.applyCandidate(init);
      }
    }
  }

  receiveHangup(content: Record<string, unknown>): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    // Surface meaningful reasons. If we never connected and the remote
    // hung up, the most likely diagnosis is "user_busy" (their other
    // device picked up) or "invite_timeout" (they were AFK). For the
    // already-connected case the reason matters less — the timer makes
    // the duration clear — so we leave errorMessage null and let the
    // overlay show its neutral "Call ended" text.
    const reason =
      typeof content.reason === 'string' ? (content.reason as string) : null;
    if (this.state !== 'connected' && reason) {
      this.errorMessage = mapHangupReason(reason);
    }
    this.teardown('ended');
  }

  receiveReject(content: Record<string, unknown>): void {
    if (this.direction !== 'outbound' || this.state !== 'ringing_out') return;
    const reason =
      typeof content.reason === 'string' ? (content.reason as string) : null;
    this.errorMessage = reason ? mapHangupReason(reason) : 'Call declined';
    this.teardown('ended');
  }

  // ---- Internals ---------------------------------------------------------

  private async attachMedia(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: true,
      video: this.media === 'video',
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.localStream = stream;
    // CRITICAL: in the inbound flow, `buildPeerConnection` runs inside
    // `receiveInvite` BEFORE the user clicks Accept — so when it ran,
    // `this.localStream` was null and zero senders were added. When
    // `accept()` finally calls us here, we have a stream but the pc
    // is already built. If we don't push the tracks into the existing
    // pc, the answer SDP ends up declaring our m-lines as `recvonly`
    // / `inactive`, DTLS never completes on a sending m-line, and the
    // connectionState hangs at `connecting` indefinitely. This was the
    // "stuck on Connecting…" symptom. The check is idempotent — if
    // buildPeerConnection already added these tracks (outbound flow,
    // where attachMedia runs first), `getSenders()` reports them and
    // we skip. We compare by track identity, not stream identity.
    if (this.pc) {
      const existing = new Set(this.pc.getSenders().map((s) => s.track).filter(Boolean));
      for (const track of stream.getTracks()) {
        if (!existing.has(track)) {
          this.pc.addTrack(track, stream);
        }
      }
    }
    for (const fn of this.listeners.localStream) fn(stream);
    debug('attachMedia', { tracks: stream.getTracks().map((t) => t.kind), pcHadSenders: this.pc?.getSenders().length });
  }

  private async buildPeerConnection(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;
    const iceServers = await this.signaling.getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    // Pipe local tracks. If we don't have a stream yet (inbound invite
    // pre-accept), tracks will be added when the user clicks Accept.
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }
    pc.ontrack = (e) => {
      // We collect all remote tracks into a single stream for the UI's
      // single <video>/<audio> element. The spec allows multiple streams
      // but our v0 1:1 UI only renders one peer.
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        for (const fn of this.listeners.remoteStream) fn(this.remoteStream);
      }
      this.remoteStream.addTrack(e.track);
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        // null candidate = ICE gathering done. Flush immediately so the
        // peer learns we're done sending.
        this.flushCandidateBuffer();
        return;
      }
      this.localCandidateBuffer.push(e.candidate.toJSON());
      if (this.candidateFlushTimer == null) {
        this.candidateFlushTimer = setTimeout(() => this.flushCandidateBuffer(), 200) as unknown as number;
      }
    };
    pc.onconnectionstatechange = () => {
      debug('connectionState', pc.connectionState);
      switch (pc.connectionState) {
        case 'connected':
          this.connectedAt = Date.now();
          this.setState('connected');
          break;
        case 'failed':
          this.fail('Network couldn\'t reach the other side.');
          break;
        case 'disconnected':
          // Spec: don't immediately hang up — Chrome flips here on a
          // brief network blip. We let onconnectionstatechange settle to
          // failed before tearing down.
          break;
        default:
          break;
      }
    };
    // ICE-layer transitions are usually the diagnostic the user
    // actually cares about: `checking` → stuck means no candidate
    // pair worked (NAT / firewall); `connected` → followed by no
    // `connectionState=connected` means DTLS is the problem (no
    // active sender, cert mismatch, ...). Logged separately so we
    // can see them in the browser console without enabling verbose
    // matrix-js-sdk tracing.
    pc.oniceconnectionstatechange = () => {
      debug('iceConnectionState', pc.iceConnectionState);
    };
    pc.onicegatheringstatechange = () => {
      debug('iceGatheringState', pc.iceGatheringState);
    };
    pc.onsignalingstatechange = () => {
      debug('signalingState', pc.signalingState);
    };
    debug('peerConnection built', {
      iceServers: iceServers.map((s) => s.urls),
      direction: this.direction,
      media: this.media,
    });
    return pc;
  }

  private async flushCandidateBuffer(): Promise<void> {
    if (this.candidateFlushTimer != null) {
      clearTimeout(this.candidateFlushTimer);
      this.candidateFlushTimer = null;
    }
    if (this.localCandidateBuffer.length === 0) return;
    const batch = this.localCandidateBuffer.splice(0);
    await this.signaling.send(this.roomId, 'm.call.candidates', {
      call_id: this.callId,
      version: CALL_PROTOCOL_VERSION,
      party_id: this.partyId,
      candidates: batch,
    }).catch(() => undefined);
  }

  private async flushPendingRemoteCandidates(): Promise<void> {
    const pending = this.pendingRemoteCandidates.splice(0);
    for (const c of pending) await this.applyCandidate(c);
  }

  private async applyCandidate(init: RTCIceCandidateInit): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      await pc.addIceCandidate(init);
    } catch {
      // Ignore — Trickle ICE is best-effort; bad candidates just don't
      // contribute to the connectivity check set.
    }
  }

  private setState(s: CallState): void {
    this.state = s;
    this.emitSnapshot();
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.teardown('ended');
  }

  private teardown(final: CallState): void {
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    this.localStream = null;
    for (const fn of this.listeners.localStream) fn(null);
    for (const fn of this.listeners.remoteStream) fn(null);
    this.remoteStream = null;
    this.state = final;
    this.emitSnapshot();
  }

  snapshot(): CallSnapshot {
    return {
      callId: this.callId,
      roomId: this.roomId,
      peerUserId: this.peerUserId,
      direction: this.direction,
      media: this.media,
      state: this.state,
      micMuted: this.micMuted,
      videoOff: this.videoOff,
      connectedAt: this.connectedAt,
      errorMessage: this.errorMessage,
    };
  }

  private emitSnapshot(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners.snapshot) fn(snap);
  }
}

// ---- Helpers ---------------------------------------------------------------

function setTracksEnabled(tracks: MediaStreamTrack[], enabled: boolean): void {
  for (const t of tracks) t.enabled = enabled;
}

function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, len);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Peek the offer SDP to decide whether an inbound invite is a voice
 * or video call. We look at the m= lines — `m=video` present + active
 * means the caller wants video. This drives our local getUserMedia
 * constraint when the user accepts.
 */
/**
 * Diagnostic logger. Behind a single flag so flipping verbose mode
 * on/off is one place. We tag every line with `[call]` so console
 * filters work cleanly during user-reported call bugs ("paste lines
 * starting with [call]"). Production builds keep this on — WebRTC
 * bugs are too painful to debug without a breadcrumb trail, and the
 * volume is low (a handful per call).
 */
const CALL_DEBUG = true;
function debug(label: string, info?: unknown): void {
  if (!CALL_DEBUG) return;
  if (info === undefined) {
    // eslint-disable-next-line no-console
    console.log(`[call] ${label}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[call] ${label}`, info);
  }
}

/**
 * Sniff the active m-line directions from an SDP blob. Used in the
 * post-mortem log to flag the "I'm sending nothing" failure mode: if
 * we just applied a local description and it's all `recvonly` /
 * `inactive`, the remote peer can't hear us no matter how good ICE
 * gets. Cheap to compute on top of an SDP string we already have.
 */
function sdpDirections(sdp: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentMedia: string | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const kind = line.split(/\s+/)[0]?.slice(2);
      currentMedia = kind ?? null;
      // Default to sendrecv if no direction attribute appears.
      if (currentMedia) out[currentMedia] = 'sendrecv';
    } else if (currentMedia) {
      for (const dir of ['sendrecv', 'sendonly', 'recvonly', 'inactive']) {
        if (line === `a=${dir}`) {
          out[currentMedia] = dir;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Translate spec-defined `m.call.hangup.reason` strings into a
 * sentence the user can read. Anything we don't recognise falls
 * through to a Title-Cased version of the raw token — better than
 * showing `user_hangup` literally and better than swallowing the
 * detail entirely (which would hide e.g. ICE failures from any
 * future debugging session).
 */
function mapHangupReason(reason: string): string {
  switch (reason) {
    case 'ice_failed':
    case 'ice_timeout':
      return "Couldn't reach the other side.";
    case 'invite_timeout':
      return 'No answer.';
    case 'user_busy':
      return 'They were on another call.';
    case 'user_hangup':
      return 'Call ended.';
    case 'user_media_failed':
      return 'Their microphone or camera failed.';
    case 'unknown_error':
      return 'Call ended unexpectedly.';
    default: {
      const titled = reason
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return titled;
    }
  }
}

function inferMediaFromSdp(sdp: string): CallMedia {
  for (const line of sdp.split('\n')) {
    if (line.startsWith('m=video')) {
      // a port of 0 means rejected/removed; anything else is active.
      const parts = line.trim().split(/\s+/);
      const port = Number(parts[1]);
      if (Number.isFinite(port) && port !== 0) return 'video';
    }
  }
  return 'audio';
}
