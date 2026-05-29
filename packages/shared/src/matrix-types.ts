/**
 * Matrix protocol types — the minimum subset Mata needs at the boundary
 * between worker and main thread. These are intentionally lightweight
 * shapes optimized for serialization across postMessage, not exhaustive
 * representations of the Matrix Client-Server API.
 */

export type UserId = `@${string}:${string}`;
export type RoomId = `!${string}:${string}`;
export type EventId = `$${string}`;
export type DeviceId = string;
export type MxcUri = `mxc://${string}`;

export type RoomType = 'dm' | 'room' | 'space';

export interface RoomSummary {
  roomId: RoomId;
  type: RoomType;
  name: string;
  topic: string | null;
  avatarUrl: MxcUri | null;
  unreadCount: number;
  highlightCount: number;
  lastActivityTs: number;
  lastEventPreview: string | null;
  isEncrypted: boolean;
  /**
   * Server-driven mute state, derived from this room's push rule
   * override on the client. `true` when a `m.room.rule` override with
   * `notify:false` is present for `roomId`; toggled via the
   * `setRoomMuted` RPC. Default `false`.
   */
  isMuted: boolean;
  membership: 'join' | 'invite' | 'leave';
  /**
   * For DM rooms (`type === 'dm'`), the other party's user id. Null
   * for group rooms and spaces, and null for DM rooms where the
   * counterparty couldn't be resolved (rare — typically a left-room
   * or invite-only DM where the inviter hasn't accepted yet). The
   * client uses this to power "frequent chats" quick-add chips in
   * the new-room modal without round-tripping for member lists.
   */
  dmTargetUserId: UserId | null;
}

export interface RoomDelta {
  roomId: RoomId;
  // Only the fields that actually changed. `null` means no change.
  summary: Partial<RoomSummary> | null;
  newEvents: TimelineEvent[];
}

export type MessageBody =
  | {
      msgtype: 'm.text';
      body: string;
      formattedBody: string | null;
      /**
       * MSC3952 intentional mentions. Forwarded round-trip — the worker
       * serializes this to `m.mentions: { user_ids: [...] }` on send, and
       * parses the same field back on receive. The UI uses it to render
       * mention pills and to scope self-mention highlight.
       *
       * `room: true` represents `@room` (entire-room mention).
       */
      mentions?: { userIds: UserId[]; room?: boolean };
    }
  | { msgtype: 'm.emote'; body: string; mentions?: { userIds: UserId[]; room?: boolean } }
  | { msgtype: 'm.notice'; body: string; mentions?: { userIds: UserId[]; room?: boolean } }
  | MediaMessageBody
  | { msgtype: 'm.location'; body: string; geoUri: string };

/**
 * m.image / m.video / m.audio / m.file content. Exactly one of `url`
 * (plain rooms) or `file` (encrypted rooms) is meaningful — `url` is
 * the mxc URI for plain media; `file` carries the AES-CTR key + IV +
 * ciphertext hash for encrypted media. For convenience we declare both
 * as optional so the same shape covers both rooms; readers should
 * prefer `file` when present.
 */
export type MediaMessageBody = {
  msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file';
  body: string;
  info: MediaInfo;
  url?: MxcUri;
  file?: EncryptedFile;
};

/**
 * EncryptedFile per Matrix spec v1.11 — JWK-formatted 256-bit AES key,
 * 128-bit IV, SHA-256 ciphertext hash. The same shape is what we send
 * and what we receive; the AES key lives in event content so anyone
 * with megolm room keys can recover the file.
 */
export interface EncryptedFile {
  v: 'v2';
  url: MxcUri;
  key: {
    kty: 'oct';
    alg: 'A256CTR';
    key_ops: ['encrypt', 'decrypt'];
    k: string;
    ext: true;
  };
  iv: string;
  hashes: { sha256: string };
}

export interface MediaInfo {
  mimetype: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailUrl?: MxcUri;
  blurhash?: string;
}

export type TimelineEvent =
  | RoomMessageEvent
  | RoomEncryptedEvent
  | RoomMembershipEvent
  | RoomRedactionEvent;

interface BaseEvent {
  eventId: EventId;
  roomId: RoomId;
  sender: UserId;
  originServerTs: number;
}

export interface RoomMessageEvent extends BaseEvent {
  type: 'm.room.message';
  content: MessageBody;
  reactions: ReactionAggregate[];
  edits: EventId[];
  inReplyTo: EventId | null;
  threadRoot: EventId | null;
}

export interface RoomEncryptedEvent extends BaseEvent {
  type: 'm.room.encrypted';
  /** Set when decryption failed; UI renders a placeholder + retry hint. */
  decryptionStatus: 'pending' | 'failed' | 'key_missing';
  /**
   * Categorized failure reason for UI copy. Derived from the SDK's
   * `DecryptionFailureCode`. UI maps each category to a single friendly
   * sentence (no raw error strings ever surface to the user).
   */
  failureReason:
    | 'historical' // sent before this device existed; common after logout/re-login
    | 'key_withheld' // sender's device refused to share the key
    | 'session_missing' // key never arrived; might come later
    | 'verification' // sender device isolation policy rejected it
    | 'unknown'
    | null;
}

export interface RoomMembershipEvent extends BaseEvent {
  type: 'm.room.member';
  target: UserId;
  membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
  displayname: string | null;
  avatarUrl: MxcUri | null;
}

export interface RoomRedactionEvent extends BaseEvent {
  type: 'm.room.redaction';
  redacts: EventId;
  reason: string | null;
}

/**
 * Live member row for the room "people" panel. Combines membership +
 * profile + power level + (for encrypted rooms) cross-signing trust
 * status. `trust` is null in plain rooms — we don't pay the cost of
 * walking the device list unless the room is encrypted.
 *
 * `powerLevel` is the canonical Matrix integer (default 0; mods 50;
 * admins 100). UI uses thresholds for badging, but we keep the raw
 * value so power-level edits round-trip cleanly.
 */
export interface RoomMember {
  userId: UserId;
  displayname: string | null;
  avatarUrl: MxcUri | null;
  membership: 'join' | 'invite' | 'leave' | 'ban' | 'knock';
  powerLevel: number;
  trust: 'verified' | 'unverified' | 'unknown' | null;
}

export interface ReactionAggregate {
  key: string;
  count: number;
  selfReacted: boolean;
}

/**
 * One row in the message-search results panel.
 *
 * Synapse's `/search` returns full `MatrixEvent` objects with context;
 * we flatten to just what the panel renders (sender, ts, body, room)
 * plus the `eventId` so a future "jump to this message" wire-up has the
 * anchor it needs. `contextBefore` / `contextAfter` are short text
 * snippets pulled from the SearchResult's surrounding timeline — the
 * panel renders them muted above/below the match.
 */
export interface SearchHit {
  eventId: EventId;
  roomId: RoomId;
  sender: UserId;
  originServerTs: number;
  /** The matching event's body (or a best-effort summary for media events). */
  body: string;
  contextBefore: string | null;
  contextAfter: string | null;
}

export interface Device {
  deviceId: DeviceId;
  displayName: string | null;
  lastSeenTs: number | null;
  lastSeenIp: string | null;
  /** Whether this device is the one the user is logged in on right now. */
  isCurrent: boolean;
  /**
   * Cross-signing trust state for the device.
   *  - `unverified` — visible on /devices but not signed by this user's
   *    self-signing key (default for fresh logins until verified).
   *  - `verified`   — signed by this user's self-signing key.
   *  - `blacklisted` — marked untrusted; messages will not be encrypted
   *    for it (only reachable from explicit user action).
   */
  verified: 'unverified' | 'verified' | 'blacklisted';
}

/**
 * Snapshot of the user's encryption setup. Read with the
 * `getEncryptionStatus` RPC and rendered in Settings → Encryption.
 *
 * The flags map to the three independent pieces of Matrix E2EE state:
 *  - cross-signing — master/self-signing/user-signing keys exist locally
 *    and are uploaded to the server (`/keys/device_signing/upload` done).
 *  - secret storage — an SSSS default key exists on the server
 *    (account-data `m.secret_storage.default_key`) and the private parts
 *    of cross-signing + the backup key are stored under it.
 *  - key backup — a server-side backup version is active and the local
 *    device knows the backup decryption key (so megolm room keys are
 *    being uploaded as they are created).
 *
 * `recoveryReady` is the user-facing "everything is wired up" flag — true
 * only when all three are ready. UI uses this for the green check in the
 * Encryption tab.
 */
export interface EncryptionStatus {
  crossSigningReady: boolean;
  secretStorageReady: boolean;
  keyBackupEnabled: boolean;
  keyBackupVersion: string | null;
  /** Convenience: all three above are true. */
  recoveryReady: boolean;
}

export interface VerificationRequest {
  transactionId: string;
  fromUser: UserId;
  fromDevice: DeviceId;
  methods: string[];
}

export interface SasEmoji {
  emoji: string;
  description: string;
}
