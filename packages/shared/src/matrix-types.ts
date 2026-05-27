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
  membership: 'join' | 'invite' | 'leave';
}

export interface RoomDelta {
  roomId: RoomId;
  // Only the fields that actually changed. `null` means no change.
  summary: Partial<RoomSummary> | null;
  newEvents: TimelineEvent[];
}

export type MessageBody =
  | { msgtype: 'm.text'; body: string; formattedBody: string | null }
  | { msgtype: 'm.emote'; body: string }
  | { msgtype: 'm.notice'; body: string }
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
  failureReason: string | null;
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

export interface ReactionAggregate {
  key: string;
  count: number;
  selfReacted: boolean;
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
