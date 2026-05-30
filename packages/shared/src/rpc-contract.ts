/**
 * RPC contract between the main thread (Solid UI) and the dedicated
 * Web Worker that hosts matrix-rust-sdk.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the boundary.
 *
 * Design rules:
 *   1. Main thread NEVER imports matrix-rust-sdk. It only ever speaks
 *      this contract.
 *   2. Every request has a unique `id`. The worker replies with a
 *      response carrying the same `id`.
 *   3. Pushes from worker → main (sync deltas, send status, verification
 *      requests, etc.) use `WorkerEvent`. They carry no `id`.
 *   4. Anything ambiguous goes to the contract first, then to the impl.
 *      The contract is the design.
 */

import type { SerializedError } from './errors.js';

/**
 * RTCIceServer (lib.dom.d.ts) shaped JSON-safely so we can ship it
 * across the worker boundary. WebRTC accepts this verbatim — the
 * worker pulls credentials from /voip/turnServer; the main thread
 * passes them to `new RTCPeerConnection({ iceServers })`. `ttl` is
 * advisory; we refresh well before it.
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
import type {
  Device,
  DeviceId,
  EncryptedFile,
  EncryptionStatus,
  EventId,
  MediaInfo,
  MessageBody,
  MxcUri,
  RoomDelta,
  RoomId,
  RoomMember,
  RoomSummary,
  SasEmoji,
  SearchHit,
  TimelineEvent,
  UserId,
  VerificationRequest,
} from './matrix-types.js';

// -----------------------------------------------------------------------------
// Request / Response (main → worker → main)
// -----------------------------------------------------------------------------

/**
 * Normalized URL preview shape sent to the UI. Built from the
 * server's OG response on the worker side so the main thread
 * doesn't need to know about Matrix's `og:*` key convention. All
 * fields except `url` are optional — the homeserver may return
 * just a title, just an image, or any combination.
 */
/**
 * Browser PushSubscription serialized to JSON (`subscription.toJSON()`).
 * Carries the endpoint the push service exposes plus the two keys a
 * gateway needs to encrypt a Web Push payload per RFC 8291.
 */
export interface WebPushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  /**
   * Image URL. May be either `http(s)://` (server-hosted OG image,
   * usable in `<img src>` directly) or `mxc://` (authenticated
   * media — UI must fetch bytes via `loadMedia` and use a Blob URL,
   * because `<img>` can't attach the bearer token Synapse requires).
   */
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
}

/**
 * Single user-directory hit. `userId` is the canonical Matrix ID
 * (`@alice:server`); `displayName` is the server's claim about the
 * user's preferred name and may be missing on minimally-configured
 * homeservers. `avatarUrl` is an already-resolved http(s) URL — the
 * worker rewrites `mxc://` to an authenticated thumbnail before
 * sending across the boundary so the UI doesn't need a client.
 */
export interface UserSearchHit {
  userId: UserId;
  displayName?: string;
  avatarUrl?: string;
}

export type MainToWorkerRequest =
  | { kind: 'ping' }
  | { kind: 'diagLog'; note: string }
  | {
      kind: 'login';
      serverUrl: string;
      user: string;
      password: string;
      /** Human-readable label for the device on the homeserver. */
      deviceDisplayName: string;
    }
  | { kind: 'restoreSession' }
  | { kind: 'logout' }
  | { kind: 'loadRoomList' }
  | { kind: 'loadRoomHistory'; roomId: RoomId; fromToken: string | null; limit: number }
  | {
      kind: 'sendMessage';
      roomId: RoomId;
      content: MessageBody;
      /** Client-generated transaction id. The worker echoes it on `sendStatus`. */
      txnId: string;
      /**
       * When set, the outgoing event is decorated with
       * `m.relates_to: { rel_type: "m.thread", event_id: threadRoot, ... }`
       * — wire format defined by MSC3440 / spec v1.4. Threaded replies
       * also get an in-reply-to fallback pointing at the latest event
       * in the thread (handled in the worker) so unthreaded clients
       * still see a reply chain.
       */
      threadRoot?: EventId;
      /**
       * When set, the outgoing event is decorated with
       * `m.relates_to: { 'm.in_reply_to': { event_id } }` per Matrix
       * spec v1.4 (rich replies). The worker also rebuilds the
       * `> <@sender> body\n\n` fallback prefix so clients without rich
       * reply support still see a quote chain. Mutually composable
       * with `threadRoot` — when both are set we emit a thread relation
       * with an in-reply-to to the parent (intra-thread reply).
       */
      replyTo?: { eventId: EventId; sender: UserId; body: string };
    }
  | { kind: 'editMessage'; roomId: RoomId; eventId: EventId; content: MessageBody; txnId: string }
  | { kind: 'redactMessage'; roomId: RoomId; eventId: EventId; reason: string | null }
  /**
   * Pin / unpin a message. The worker reads the current
   * `m.room.pinned_events` state, appends or removes `eventId`, and
   * writes the new array back as a state event. The resulting summary
   * delta (with updated `pinnedEventIds`) is pushed via the normal sync
   * channel, so the client doesn't need the response to update the bar.
   */
  | { kind: 'pinEvent'; roomId: RoomId; eventId: EventId }
  | { kind: 'unpinEvent'; roomId: RoomId; eventId: EventId }
  /**
   * Resolve a single event by id, even when it isn't in the loaded
   * timeline. Used by the pinned bar to render a preview for a pin that
   * scrolled out of the cached window. Falls back to a homeserver
   * `/event/{id}` fetch (and decrypts) when not already in the room.
   */
  | { kind: 'fetchEvent'; roomId: RoomId; eventId: EventId }
  | { kind: 'fetchPresence'; userId: UserId }
  | { kind: 'fetchProfile'; userId: UserId }
  | { kind: 'setIgnored'; userId: UserId; ignored: boolean }
  | { kind: 'fetchRoomSettings'; roomId: RoomId }
  | { kind: 'setRoomName'; roomId: RoomId; name: string }
  | { kind: 'setRoomTopic'; roomId: RoomId; topic: string }
  | { kind: 'setRoomAvatar'; roomId: RoomId; mxc: MxcUri }
  | { kind: 'setMemberPowerLevel'; roomId: RoomId; userId: UserId; powerLevel: number }
  | { kind: 'forgetRoom'; roomId: RoomId }
  | { kind: 'sendReaction'; roomId: RoomId; eventId: EventId; key: string }
  | { kind: 'sendTyping'; roomId: RoomId; timeoutMs: number }
  | { kind: 'sendReadReceipt'; roomId: RoomId; eventId: EventId }
  | { kind: 'markRoomRead'; roomId: RoomId }
  | { kind: 'uploadMedia'; data: ArrayBuffer; mime: string; filename: string }
  | {
      /**
       * Send a file/image/video/audio as one atomic operation. In
       * encrypted rooms the worker AES-CTR encrypts the data before
       * upload and packs the JWK + IV + hash into the event content's
       * `file:` field. In plain rooms it uploads as-is and uses `url:`.
       * `info.mimetype` drives the msgtype (m.image / m.video / etc).
       */
      kind: 'sendFileMessage';
      roomId: RoomId;
      data: ArrayBuffer;
      filename: string;
      info: MediaInfo;
      txnId: string;
      /**
       * Extra event-content keys merged verbatim into the outgoing
       * `m.room.message`. Used for MSC3245 voice messages
       * (`org.matrix.msc3245.voice` + `org.matrix.msc1767.audio`); the
       * worker shallow-merges this over the built media body.
       */
      extraContent?: Record<string, unknown>;
    }
  | {
      /**
       * Download (and if encrypted, decrypt) a media attachment. Returns
       * raw bytes — caller wraps them in a Blob + URL.createObjectURL on
       * the main thread so the rendered `<img>` / `<video>` element
       * owns the URL lifecycle.
       */
      kind: 'loadMedia';
      mxc: MxcUri;
      encryptedFile: EncryptedFile | null;
      mime: string;
    }
  | { kind: 'subscribeRoom'; roomId: RoomId }
  | { kind: 'unsubscribeRoom'; roomId: RoomId }
  | { kind: 'listDevices' }
  | { kind: 'fetchUserDevices'; userId: UserId }
  | { kind: 'beginDeviceVerification'; userId: UserId; deviceId: DeviceId }
  | { kind: 'completeSasVerification'; transactionId: string; result: 'match' | 'mismatch' }
  | { kind: 'cancelVerification'; transactionId: string }
  | { kind: 'getEncryptionStatus' }
  | {
      /**
       * Unified "set up secure backup" operation: bootstraps cross-signing
       * keys (signs + uploads master/self-signing/user-signing), creates
       * an SSSS default key derived from the supplied passphrase, then
       * starts a server-side key backup encrypted with that SSSS key.
       * Returns a base58 recovery key the user MUST store offline as the
       * escape hatch if they forget the passphrase.
       *
       * `password` is the user's login password, required because the
       * server gates `POST /keys/device_signing/upload` behind UIA. It
       * is never persisted — only forwarded to the UIA callback for this
       * single request chain.
       */
      kind: 'enableKeyBackup';
      password: string;
      passphrase: string;
    }
  | { kind: 'restoreKeyBackup'; recoveryKey: string }
  | {
      /**
       * Create a new room. `isDirect=true` is a 1:1 DM in Matrix terms;
       * the spec doesn't gate any behavior on it, but Element + other
       * clients use it for the "Direct messages" section.
       *
       * `encrypted` defaults to true — Mata is secure-by-default. Pass
       * false explicitly to create a plain room (e.g. for a public
       * lobby). Honoured by sending an initial `m.room.encryption` state
       * event in `initial_state` during createRoom.
       *
       * `invite` is a list of user IDs to invite immediately. Public
       * rooms are not supported in v1 — every room defaults to
       * `private_chat` preset (invite-only).
       */
      kind: 'createRoom';
      name: string;
      topic: string | null;
      isDirect: boolean;
      encrypted: boolean;
      invite: UserId[];
    }
  | { kind: 'inviteToRoom'; roomId: RoomId; userId: UserId }
  | { kind: 'joinRoom'; roomId: RoomId }
  | { kind: 'leaveRoom'; roomId: RoomId }
  | {
      /**
       * Snapshot of the room's member list. Lazy-loads members from the
       * server if the SDK hasn't yet (Element + matrix-js-sdk follow the
       * "lazy load members" pattern for big rooms). Returns ALL
       * memberships including 'invite' and 'leave' so the UI can show
       * pending invitees and recently-left members; the panel filters
       * by default.
       */
      kind: 'loadRoomMembers';
      roomId: RoomId;
    }
  | { kind: 'kickFromRoom'; roomId: RoomId; userId: UserId; reason: string | null }
  /**
   * Set/clear the per-room mute push rule (`global.room` override).
   * Server-side: matrix-js-sdk's `setRoomMutePushRule('global', roomId, muted)`.
   * Returns the resulting muted state so the UI can confirm before
   * the next sync delta reaches `RoomSummary.isMuted`.
   */
  | { kind: 'setRoomMuted'; roomId: RoomId; muted: boolean }
  /**
   * Load every event in a Matrix thread (rel_type `m.thread`) plus
   * the root itself. Worker fetches via `client.relations` and the
   * fallback `/rooms/{roomId}/relations/{eventId}/m.thread` endpoint
   * for clients/servers without thread-aware sync. Returns events
   * sorted oldest-first so the thread panel can render them in
   * timeline order.
   */
  | { kind: 'loadThread'; roomId: RoomId; threadRootId: EventId }
  /**
   * Send a Matrix VoIP signaling event (m.call.invite / m.call.answer
   * / m.call.candidates / m.call.hangup / m.call.select_answer …) on
   * behalf of the main thread. WebRTC itself lives on the main thread
   * (Web Workers don't expose `RTCPeerConnection` or
   * `navigator.mediaDevices`), so the worker's job is purely the
   * signaling relay: it puts the event on the wire, encrypted-or-not
   * per room policy, with the SDK-managed access token. `content` is
   * the raw m.call.* JSON body — we keep this untyped at the RPC
   * boundary so we don't have to mirror the entire VoIP spec in our
   * shared types (and so we can adopt MSC3401 fields later without a
   * contract bump).
   */
  | {
      kind: 'sendCallEvent';
      roomId: RoomId;
      eventType: string;
      content: Record<string, unknown>;
    }
  /**
   * Pull the homeserver's TURN credentials so the main-thread peer
   * connection can configure its ICE servers. Falls back to the
   * spec's public STUN list when the server doesn't expose
   * /voip/turnServer (older or self-hosted setups).
   */
  | { kind: 'getTurnServers' }
  /**
   * Server-side full-text search for room events.
   *
   * Maps to matrix-js-sdk's `searchRoomEvents({ term, filter })`,
   * which posts to `/_matrix/client/v3/search` under
   * `search_categories.room_events`. When `roomId` is non-null the
   * worker scopes the search with `filter.rooms = [roomId]`; when
   * `null` the search runs across every joined room.
   *
   * First page only — no `next_batch` round-trip yet. Server default
   * page size (~10) is fine for a "ctrl-F in this room" UX.
   */
  | { kind: 'searchMessages'; query: string; roomId: RoomId | null }
  /**
   * Forward `sourceEventId` from `sourceRoomId` into `targetRoomId`.
   * The worker grabs the decrypted content from the source event,
   * strips relations (`m.relates_to`, `m.new_content`) and mentions
   * (different audience), prepends a "[Forwarded from @sender]"
   * header on text-class messages, and re-sends the cleaned content
   * via `client.sendEvent`. Media (`m.image` / `m.video` / `m.audio`
   * / `m.file`) is forwarded as-is — the AES-CTR key for encrypted
   * media travels inside `content.file`, so any recipient with the
   * megolm key for the TARGET room can decrypt the file without
   * needing the source room's keys.
   */
  | {
      kind: 'forwardEvent';
      sourceRoomId: RoomId;
      sourceEventId: EventId;
      targetRoomId: RoomId;
    }
  /**
   * Fetch OG metadata for a URL via the homeserver's
   * /_matrix/media/v3/preview_url endpoint. The homeserver itself
   * fetches the page server-side and returns OpenGraph tags — this
   * is the only privacy-respecting way to do link previews in a
   * Matrix client (the client never hits the third-party URL with
   * the user's IP).
   *
   * Why route through the worker, not the main thread: media auth
   * is on the SDK client, which lives in the worker. The endpoint
   * also requires auth in modern Synapse (MSC3916).
   */
  | { kind: 'getUrlPreview'; url: string }
  /**
   * Live user-directory search for the "start a chat" surface.
   * Hits POST `/_matrix/client/v3/user_directory/search` via
   * matrix-js-sdk `searchUserDirectory`. The server scopes the
   * scan to users this account can plausibly contact — public
   * directory entries + shared-room members on Synapse — so
   * results stay useful without requiring federation-wide enum.
   */
  | { kind: 'searchUsers'; term: string; limit: number }
  /**
   * Register a Web Push pusher on the homeserver so it forwards
   * push notifications to our gateway (`gatewayUrl`) even when the
   * tab is frozen or closed. `subscription` is the browser
   * PushSubscription JSON; the worker stuffs it into the pusher
   * `data` so the gateway has the endpoint + VAPID keys to dispatch.
   */
  | {
      kind: 'setWebPusher';
      subscription: WebPushSubscriptionJson;
      gatewayUrl: string;
      appId: string;
      lang: string;
    }
  /** Remove a previously-registered Web Push pusher (by endpoint = pushkey). */
  | { kind: 'removeWebPusher'; endpoint: string; appId: string };

export type MainToWorkerResponse =
  | { kind: 'ping'; pong: true }
  | { kind: 'diagLog'; ok: true }
  | { kind: 'login'; userId: UserId; deviceId: DeviceId }
  | { kind: 'restoreSession'; restored: boolean; userId: UserId | null; deviceId: DeviceId | null }
  | { kind: 'logout' }
  | { kind: 'loadRoomList'; rooms: RoomSummary[] }
  | {
      kind: 'loadRoomHistory';
      events: TimelineEvent[];
      /** Token to fetch the next older page. `null` means we've reached the start. */
      prevToken: string | null;
      /**
       * The user's own read-receipt up-to event id at load time, used
       * to anchor the "New messages" unread divider. `null` on paging
       * requests (fromToken !== null) and when no receipt exists.
       */
      readUpToEventId: string | null;
    }
  | { kind: 'sendMessage'; queued: true }
  | { kind: 'editMessage'; queued: true }
  | { kind: 'redactMessage' }
  | { kind: 'pinEvent' }
  | { kind: 'unpinEvent' }
  | { kind: 'fetchEvent'; event: TimelineEvent | null }
  | {
      kind: 'fetchPresence';
      presence: 'online' | 'offline' | 'unavailable';
      lastActiveAgoMs: number | null;
      currentlyActive: boolean | null;
    }
  | { kind: 'fetchProfile'; displayName: string | null; avatarUrl: string | null; ignored: boolean }
  | { kind: 'setIgnored' }
  | {
      kind: 'fetchRoomSettings';
      name: string;
      topic: string;
      canSetName: boolean;
      canSetTopic: boolean;
      canSetAvatar: boolean;
      canSetPowerLevel: boolean;
      myPowerLevel: number;
    }
  | { kind: 'setRoomName' }
  | { kind: 'setRoomTopic' }
  | { kind: 'setRoomAvatar' }
  | { kind: 'setMemberPowerLevel' }
  | { kind: 'forgetRoom' }
  | { kind: 'sendReaction' }
  | { kind: 'sendTyping' }
  | { kind: 'sendReadReceipt' }
  | { kind: 'markRoomRead' }
  | { kind: 'uploadMedia'; mxc: MxcUri }
  | { kind: 'sendFileMessage'; eventId: EventId }
  | { kind: 'loadMedia'; data: ArrayBuffer; mime: string }
  | { kind: 'subscribeRoom' }
  | { kind: 'unsubscribeRoom' }
  | { kind: 'listDevices'; devices: Device[] }
  | { kind: 'fetchUserDevices'; devices: Device[] }
  | { kind: 'beginDeviceVerification'; transactionId: string }
  | { kind: 'completeSasVerification' }
  | { kind: 'cancelVerification' }
  | { kind: 'getEncryptionStatus'; status: EncryptionStatus }
  | { kind: 'enableKeyBackup'; recoveryKey: string }
  | { kind: 'restoreKeyBackup'; keysImported: number }
  | { kind: 'createRoom'; roomId: RoomId }
  | { kind: 'inviteToRoom' }
  | { kind: 'joinRoom'; roomId: RoomId }
  | { kind: 'leaveRoom' }
  | { kind: 'loadRoomMembers'; members: RoomMember[] }
  | { kind: 'kickFromRoom' }
  | { kind: 'setRoomMuted'; muted: boolean }
  | { kind: 'loadThread'; events: TimelineEvent[] }
  | { kind: 'sendCallEvent'; eventId: EventId }
  /**
   * RTCIceServer list (the shape WebRTC's RTCPeerConnection accepts
   * verbatim). Empty when the homeserver returns no servers and the
   * fallback list is also empty — the caller treats that as "STUN-
   * only, host-to-host" and accepts the higher failure rate.
   */
  | { kind: 'getTurnServers'; iceServers: IceServer[] }
  | {
      kind: 'searchMessages';
      results: SearchHit[];
      /** Server's best estimate of total matching events. */
      count: number;
      /** Stemmed terms the server says match — used for client highlight. */
      highlights: string[];
    }
  | { kind: 'forwardEvent'; eventId: EventId }
  /**
   * `null` when the homeserver returns no usable preview (404,
   * empty body, blacklisted URL, network error). The UI treats
   * null as "skip — render the link as plain text".
   */
  | { kind: 'getUrlPreview'; preview: UrlPreview | null }
  | { kind: 'setWebPusher' }
  | { kind: 'removeWebPusher' }
  | {
      kind: 'searchUsers';
      results: UserSearchHit[];
      /** Server hit the cap and may be hiding more matches — UI shows "+ more". */
      limited: boolean;
    };

// Compile-time guarantee: request kind ↔ response kind 1:1.
export type ResponseFor<K extends MainToWorkerRequest['kind']> = Extract<
  MainToWorkerResponse,
  { kind: K }
>;

// -----------------------------------------------------------------------------
// Wire envelopes
// -----------------------------------------------------------------------------

export interface RequestEnvelope<R extends MainToWorkerRequest = MainToWorkerRequest> {
  type: 'request';
  id: string;
  payload: R;
}

export type ResponseEnvelope =
  | {
      type: 'response';
      id: string;
      ok: true;
      payload: MainToWorkerResponse;
    }
  | {
      type: 'response';
      id: string;
      ok: false;
      error: SerializedError;
    };

// -----------------------------------------------------------------------------
// Worker-pushed events (no request — fire-and-forget streams)
// -----------------------------------------------------------------------------

export type WorkerEvent =
  | {
      kind: 'syncStatus';
      status: 'idle' | 'connecting' | 'syncing' | 'reconnecting' | 'error';
      reason?: string;
    }
  | {
      /**
       * Diagnostic note from the worker. Lives in the syncLog feed but
       * does NOT change the sync-state pill. Used for instrumentation
       * markers (send phases, decrypt phases, watchdog beacons) so the
       * pill keeps tracking real SDK SyncState transitions instead of
       * flipping to `connecting` on every phase emit.
       */
      kind: 'diagNote';
      note: string;
    }
  | {
      kind: 'syncUpdate';
      deltas: RoomDelta[];
      /** Opaque pagination token returned by the homeserver. */
      nextBatch: string;
    }
  | {
      kind: 'sendStatus';
      txnId: string;
      status: 'sending' | 'sent' | 'failed';
      eventId?: EventId;
      error?: SerializedError;
    }
  | {
      kind: 'cryptoStatus';
      roomId: RoomId;
      eventId: EventId;
      status: 'decrypted' | 'key_missing' | 'key_requested' | 'failed';
      reason?: string;
    }
  | {
      kind: 'verificationRequest';
      request: VerificationRequest;
    }
  | {
      kind: 'verificationProgress';
      transactionId: string;
      phase: 'ready' | 'sas_compare' | 'done' | 'cancelled';
      sasEmojis?: SasEmoji[];
      cancellationReason?: string;
    }
  | {
      kind: 'typing';
      roomId: RoomId;
      userIds: UserId[];
    }
  | {
      kind: 'presence';
      userId: UserId;
      presence: 'online' | 'offline' | 'unavailable';
      lastActiveAgoMs: number | null;
      currentlyActive: boolean | null;
    }
  | {
      kind: 'workerCrashed';
      message: string;
    }
  /**
   * Inbound VoIP signaling event (m.call.invite / m.call.answer /
   * m.call.candidates / m.call.hangup / m.call.select_answer /
   * m.call.reject / m.call.negotiate). The worker fishes these out of
   * timeline + to-device sync deltas and forwards them verbatim;
   * everything WebRTC-specific (SDP parsing, ICE candidate
   * application, mute) is the main thread's job.
   *
   * `sender` is the MXID of the originating user — useful for ringer
   * UX and for filtering out our own echoes (Matrix delivers our
   * sent signaling events back to us on next sync).
   *
   * `partyId` (MSC2746) disambiguates which device on the remote side
   * is participating; null for legacy clients that don't set it.
   *
   * `content` is the raw m.call.* body. The main-thread call layer
   * narrows it by `eventType`.
   */
  | {
      kind: 'callSignal';
      roomId: RoomId;
      eventType: string;
      sender: UserId;
      partyId: string | null;
      ageMs: number;
      content: Record<string, unknown>;
    };

export interface EventEnvelope {
  type: 'event';
  payload: WorkerEvent;
}

// -----------------------------------------------------------------------------
// Bridge surface — what the main-thread RPC client exposes
// -----------------------------------------------------------------------------

/**
 * The strongly-typed call surface the UI consumes. Implementations live in
 * `apps/web/src/bridge/`. This type sits in @mata/shared so the worker side
 * can refer to it too (for mock harnesses, tests, type parity).
 */
export interface MatrixBridge {
  request<K extends MainToWorkerRequest['kind']>(
    payload: Extract<MainToWorkerRequest, { kind: K }>,
  ): Promise<ResponseFor<K>>;
  /** Subscribe to worker-pushed events. Returns an unsubscribe handle. */
  on<K extends WorkerEvent['kind']>(
    kind: K,
    handler: (event: Extract<WorkerEvent, { kind: K }>) => void,
  ): () => void;
  /** Tear down the worker. Idempotent. */
  dispose(): void;
}
