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
  | { msgtype: 'm.image'; body: string; url: MxcUri; info: MediaInfo }
  | { msgtype: 'm.video'; body: string; url: MxcUri; info: MediaInfo }
  | { msgtype: 'm.audio'; body: string; url: MxcUri; info: MediaInfo }
  | { msgtype: 'm.file'; body: string; url: MxcUri; info: MediaInfo }
  | { msgtype: 'm.location'; body: string; geoUri: string };

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
  verified: 'unverified' | 'verified' | 'blacklisted';
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
