/**
 * Pure helpers split out of sdk-impl.ts so the main file stays under
 * the Linux MAX_ARG_STRLEN ceiling (~128 KB encoded) when committing
 * via the GitHub Contents API. None of these touch SdkSession's
 * internal state — they take MatrixClient / Room / MatrixEvent as
 * inputs and return wire-shaped values.
 *
 * Anything that needs `this.client` / `this.emit` / SSSS cache stays
 * in sdk-impl.ts as a private method on SdkSession.
 */

import {
  EventType,
  MsgType,
  type MatrixClient,
  type Room,
  type MatrixEvent,
  type IContent,
} from 'matrix-js-sdk';

import type {
  RoomSummary,
  TimelineEvent,
  RoomEncryptedEvent,
  UserId,
  RoomId,
  EventId,
  MessageBody,
  MediaMessageBody,
  EncryptedFile,
  MxcUri,
  MediaInfo,
} from '@mata/shared/matrix';
import { authError } from '@mata/shared/errors';
import type { WorkerEvent } from '@mata/shared/rpc';

// Duplicate of sdk-impl's `describe` — too widely used in sdk-impl to
// move, and not worth a third shared file just for one 4-liner.
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

/**
 * Wipe IndexedDB databases that hold rust-crypto-sdk state from a
 * previous device login.
 *
 * matrix-js-sdk's rust-crypto pipeline opens an IDB store named with the
 * `RUST_SDK_STORE_PREFIX` constant ("matrix-js-sdk"); matrix-sdk-crypto-wasm
 * creates one or more child databases under that prefix. When a user logs
 * in fresh, the server allocates a NEW deviceId. The OlmMachine then
 * compares the account it finds in the existing store (which still
 * belongs to the previous device) against the constructor's
 * (userId, deviceId) pair, finds a mismatch, and throws:
 *
 *    the account in the store doesn't match the account in the
 *    constructor: expected @user:host:OLD_DEVICE, got @user:host:NEW_DEVICE
 *
 * The original device's keys are unrecoverable without that device's
 * pickle key anyway, so the only safe move is to discard the stale
 * crypto state and let bootClient initialise a fresh store for the new
 * device. This is the same recovery path Element-web takes when its
 * "clear storage" button is pressed.
 *
 * `indexedDB.databases()` is available in modern Chromium/Safari/Firefox
 * (and is exposed inside DedicatedWorkerGlobalScope). When unavailable
 * (e.g. older browsers, polyfilled jsdom tests) we fall back to deleting
 * known names from the SDK.
 */
export async function wipeStaleCryptoStores(
  emit: (event: WorkerEvent) => void,
): Promise<void> {
  const PREFIX = 'matrix-js-sdk';
  const wiped: string[] = [];
  try {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return;
    let names: string[] = [];
    if (typeof (idb as { databases?: unknown }).databases === 'function') {
      const list = (await idb.databases()) as Array<{ name?: string }>;
      names = list
        .map((d) => d.name ?? '')
        .filter((n) => n && n.startsWith(PREFIX));
    } else {
      // Fallback: delete the well-known names matrix-js-sdk + rust-crypto
      // historically create. deleteDatabase is a no-op if the DB does
      // not exist, so listing extras here is harmless.
      names = [
        `${PREFIX}::matrix-sdk-crypto`,
        `${PREFIX}::matrix-sdk-crypto-meta`,
        `${PREFIX}:crypto`,
        `${PREFIX}:riot-web-sync`,
      ];
    }
    for (const name of names) {
      await new Promise<void>((resolve) => {
        const req = idb.deleteDatabase(name);
        req.onsuccess = () => {
          wiped.push(name);
          resolve();
        };
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  } catch (err) {
    // Best-effort: if wiping fails, bootClient will surface the real
    // bootstrap error and the user can fall back to a manual reset.
    emit({
      kind: 'syncStatus',
      status: 'error',
      reason: `crypto store wipe failed: ${(err as Error)?.message ?? String(err)}`,
    });
    return;
  }
  if (wiped.length > 0) {
    emit({
      kind: 'syncStatus',
      status: 'connecting',
      reason: `wiped ${wiped.length} stale crypto store(s): ${wiped.join(', ')}`,
    });
  }
}

export function mapLoginError(err: unknown): Error {
  const msg = describe(err);
  // Match on Matrix error codes only — never on free-text substrings, which
  // misclassified transport-layer errors as auth failures (the `M_INVALID_USERNAME`
  // → "Invalid username or password" confusion that masked the real bug for hours).
  if (/M_FORBIDDEN|M_UNKNOWN_TOKEN|M_MISSING_TOKEN|M_BAD_JSON/i.test(msg)) {
    return authError('Invalid username or password');
  }
  if (/M_USER_IN_USE|M_INVALID_USERNAME/i.test(msg)) {
    return authError('That username is not accepted by this homeserver');
  }
  if (/M_LIMIT_EXCEEDED/i.test(msg)) {
    return authError('Too many attempts — wait a moment and try again');
  }
  if (/M_USER_DEACTIVATED/i.test(msg)) {
    return authError('This account has been deactivated');
  }
  return authError(`Sign-in failed: ${msg.slice(0, 300)}`);
}

export function classifyRoom(room: Room): 'dm' | 'room' | 'space' {
  if (room.isSpaceRoom?.()) return 'space';
  if (room.getDMInviter() || (room.getJoinedMemberCount?.() === 2 && !room.isSpaceRoom?.())) return 'dm';
  return 'room';
}

export function toSummary(room: Room, client: MatrixClient): RoomSummary {
  const last = room.getLiveTimeline().getEvents().slice(-1)[0];
  const type = classifyRoom(room);
  // DM counterparty resolution. Three sources, in priority:
  //   1. `m.direct` account data — authoritative when the inviter
  //      flagged the room as a DM via `setRoomTag` on creation.
  //   2. `guessDMUserId()` — fallback matrix-js-sdk heuristic
  //      (DM inviter or sole other joined member).
  //   3. null — group room or self-only DM during onboarding.
  // We resolve here so the client doesn't have to re-walk member
  // lists every time the new-room modal opens.
  let dmTargetUserId: UserId | null = null;
  if (type === 'dm') {
    try {
      const me = client.getUserId();
      const directs =
        (client.getAccountData('m.direct')?.getContent?.() as
          | Record<string, string[]>
          | undefined) ?? {};
      for (const [uid, roomIds] of Object.entries(directs)) {
        if (uid === me) continue;
        if (Array.isArray(roomIds) && roomIds.includes(room.roomId)) {
          dmTargetUserId = uid as UserId;
          break;
        }
      }
      if (!dmTargetUserId && typeof room.guessDMUserId === 'function') {
        const guess = room.guessDMUserId();
        if (guess && guess !== me) dmTargetUserId = guess as UserId;
      }
    } catch {
      /* never block summary on DM resolution */
    }
  }
  return {
    roomId: room.roomId as RoomId,
    type,
    name: room.name || room.roomId,
    topic: (room.currentState.getStateEvents(EventType.RoomTopic, '') as MatrixEvent | null)?.getContent()?.topic ?? null,
    avatarUrl: (room.getMxcAvatarUrl() ?? null) as MxcUri | null,
    unreadCount: room.getUnreadNotificationCount(),
    highlightCount: room.getUnreadNotificationCount('highlight'),
    lastActivityTs: last?.getTs() ?? 0,
    lastEventPreview: last ? extractPreview(last) : null,
    isEncrypted: room.hasEncryptionStateEvent(),
    isMuted: isRoomMuted(client, room.roomId as RoomId),
    membership: (room.getMyMembership() as 'join' | 'invite' | 'leave') ?? 'leave',
    dmTargetUserId,
  };
}

/**
 * Detect mute via the canonical Matrix push rule: a room-override
 * rule under `global.room` whose rule_id matches the roomId and whose
 * actions list does NOT include `notify`. matrix-js-sdk surfaces these
 * through `client.getRoomPushRule('global', roomId)`. Returns false
 * for any error / missing rule (the default), so an unconfigured room
 * reads as unmuted.
 */
export function isRoomMuted(client: MatrixClient, roomId: RoomId): boolean {
  try {
    // getRoomPushRule has been on matrix-js-sdk's Client for a long
    // time but isn't in its public typings; cast through unknown to
    // reach the runtime method without weakening the rest of the file.
    const rule = (client as unknown as {
      getRoomPushRule?: (scope: 'global', roomId: string) => { actions?: unknown[] } | undefined;
    }).getRoomPushRule?.('global', roomId);
    if (!rule) return false;
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    // Per Matrix spec: a rule notifies iff its actions list contains
    // the bare string `'notify'`. Anything else (`'dont_notify'`,
    // empty list, `set_tweak` entries only) is muted.
    return !actions.some((a) => a === 'notify');
  } catch {
    return false;
  }
}

export function partialSummary(room: Room, client: MatrixClient): Partial<RoomSummary> {
  return toSummary(room, client);
}

export function extractPreview(ev: MatrixEvent): string | null {
  if (ev.isRedacted()) return '(message deleted)';
  if (ev.isDecryptionFailure()) return '(encrypted message)';
  const type = ev.getType();
  if (type === EventType.RoomMessage) {
    const c = ev.getContent();
    if (c.msgtype === MsgType.Text || c.msgtype === MsgType.Emote || c.msgtype === MsgType.Notice) {
      return typeof c.body === 'string' ? c.body : null;
    }
    if (c.msgtype === MsgType.Image) return '📷 Image';
    if (c.msgtype === MsgType.Video) return '🎬 Video';
    if (c.msgtype === MsgType.File) return '📎 File';
    if (c.msgtype === MsgType.Audio) return '🎙 Audio';
  }
  if (type === EventType.RoomMember) {
    const c = ev.getContent();
    if (c.membership === 'join') return `${ev.getSender()} joined`;
    if (c.membership === 'leave') return `${ev.getSender()} left`;
  }
  return null;
}

/**
 * Map matrix-js-sdk's `DecryptionFailureCode` to the coarser category
 * the UI uses for copy. Keep this exhaustive — unrecognized codes fall
 * through to `'unknown'` rather than leaking raw enum names to users.
 */
export function categorizeFailure(code: string | null): RoomEncryptedEvent['failureReason'] {
  if (!code) return 'unknown';
  if (code.startsWith('HISTORICAL_MESSAGE_')) return 'historical';
  if (code === 'MEGOLM_KEY_WITHHELD' || code === 'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE') {
    return 'key_withheld';
  }
  if (code === 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' || code === 'OLM_UNKNOWN_MESSAGE_INDEX') {
    return 'session_missing';
  }
  if (
    code === 'SENDER_IDENTITY_PREVIOUSLY_VERIFIED' ||
    code === 'UNSIGNED_SENDER_DEVICE' ||
    code === 'UNKNOWN_SENDER_DEVICE'
  ) {
    return 'verification';
  }
  return 'unknown';
}

export function toTimelineEvent(ev: MatrixEvent): TimelineEvent | null {
  const type = ev.getType();
  const sender = ev.getSender();
  if (!sender) return null;
  const base = {
    eventId: ev.getId() as EventId,
    roomId: ev.getRoomId() as RoomId,
    sender: sender as UserId,
    originServerTs: ev.getTs(),
    // Echoed back by the homeserver only on the delivery to the sending
    // device. Drives deterministic local-echo reconciliation in the UI
    // (kills the double-bubble race). matrix-js-sdk also exposes it via
    // getUnsigned().transaction_id; we read both to be safe across
    // SDK versions.
    txnId:
      (ev.getUnsigned()?.transaction_id as string | undefined) ??
      (ev as unknown as { getTxnId?: () => string | null }).getTxnId?.() ??
      null,
  } as const;

  // Intercept decryption failures BEFORE the type branching below. When
  // matrix-js-sdk fails to decrypt, it replaces the cleartext content
  // with a placeholder body like "** Unable to decrypt: DecryptionError:
  // This message was sent before this device logged in, and there is no
  // key backup on the server. **" AND keeps the event's `getType()` as
  // `m.room.message`. Without this guard, the `RoomMessage` branch
  // below would happily render that raw developer-speak as a real
  // message body. Route it to our structured `m.room.encrypted` shape
  // instead so the UI can show friendly copy and collapse runs of
  // undecryptable events.
  if (ev.isDecryptionFailure()) {
    const code = (ev as unknown as { decryptionFailureReason: string | null })
      .decryptionFailureReason;
    return {
      type: 'm.room.encrypted',
      ...base,
      decryptionStatus: 'failed',
      failureReason: categorizeFailure(code),
    };
  }

  // A redacted (deleted) message keeps its original type but has its
  // content stripped. Render it as an in-place "removed" tombstone that
  // carries the ORIGINAL event id, so a delete REPLACES the bubble in
  // place instead of leaving the old content up and appending a
  // separate row. The standalone m.room.redaction event itself is
  // dropped (returns null below) — it is never its own row.
  if (ev.isRedacted() && (type === EventType.RoomMessage || type === EventType.RoomEncrypted)) {
    return {
      type: 'm.room.redaction',
      ...base,
      redacts: base.eventId,
      reason: null,
    };
  }

  if (type === EventType.RoomMessage) {
    const c = ev.getContent();
    const body = decodeMessageBody(c);
    return {
      type: 'm.room.message',
      ...base,
      content: body,
      reactions: [],
      edits: ev.replacingEventId() ? [ev.replacingEventId() as EventId] : [],
      // `inReplyTo` is set whenever the event carries an
      // m.in_reply_to relation, including the fallback chain inside a
      // thread. `threadRoot` is set ONLY when rel_type is m.thread —
      // otherwise it would collide with regular reply chains, which
      // use the same `event_id` key under `m.relates_to`.
      inReplyTo: (c['m.relates_to']?.['m.in_reply_to']?.event_id as EventId | undefined) ?? null,
      threadRoot:
        c['m.relates_to']?.rel_type === 'm.thread'
          ? ((c['m.relates_to']?.event_id as EventId | undefined) ?? null)
          : null,
    };
  }
  if (type === EventType.RoomEncrypted) {
    // The `isDecryptionFailure()` branch is already handled above, so
    // reaching here means decryption is still pending (just arrived,
    // session lookup mid-flight).
    return {
      type: 'm.room.encrypted',
      ...base,
      decryptionStatus: 'pending',
      failureReason: null,
    };
  }
  if (type === EventType.RoomMember) {
    const c = ev.getContent();
    return {
      type: 'm.room.member',
      ...base,
      target: (ev.getStateKey() ?? '') as UserId,
      membership: (c.membership ?? 'leave') as 'join' | 'leave' | 'invite' | 'ban' | 'knock',
      displayname: typeof c.displayname === 'string' ? c.displayname : null,
      avatarUrl: typeof c.avatar_url === 'string' ? (c.avatar_url as MxcUri) : null,
    };
  }
  // Standalone redaction events are never rendered as their own row —
  // a deletion is shown by re-rendering its TARGET message in place as
  // a tombstone (see the isRedacted() branch above). Drop it.
  if (type === EventType.RoomRedaction) {
    return null;
  }
  return null;
}

/**
 * Build the Matrix reply-fallback prefix per spec v1.4 §"Rich replies".
 * Format:
 *   > <@sender:server> first-line-of-original
 *   > more-lines-of-original
 *   \n
 * Multi-line originals each get their own `> ` quote line; subsequent
 * lines after the first do NOT repeat the sender pill (only the first
 * line carries it). Returns the prefix INCLUDING the trailing `\n\n`
 * separator.
 */
export function buildReplyFallback(sender: UserId, body: string): string {
  const lines = body.split('\n');
  if (lines.length === 0) return `> <${sender}>\n\n`;
  const head = `> <${sender}> ${lines[0]}`;
  const rest = lines.slice(1).map((l) => `> ${l}`);
  return [head, ...rest].join('\n') + '\n\n';
}

/**
 * HTML reply fallback. Wraps the parent reference in a permalink
 * inside an `<mx-reply>` element — clients with rich-reply support
 * hide this element and render their own reply preview chip.
 */
export function buildReplyFallbackHtml(
  roomId: RoomId,
  eventId: EventId,
  sender: UserId,
  body: string,
): string {
  const linkRoom = encodeURIComponent(roomId);
  const linkEvent = encodeURIComponent(eventId);
  const linkSender = encodeURIComponent(sender);
  const safe = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 400);
  return (
    `<mx-reply><blockquote>` +
    `<a href="https://matrix.to/#/${linkRoom}/${linkEvent}">In reply to</a> ` +
    `<a href="https://matrix.to/#/${linkSender}">${sender}</a><br />` +
    `${safe}` +
    `</blockquote></mx-reply>`
  );
}

/**
 * Minimal HTML escape used when constructing the "Forwarded from"
 * header in formatted bodies. The sender's Matrix ID is the only
 * thing we interpolate here; we don't pull in a full HTML library
 * for one substitution.
 */
export function escapeHtmlForForward(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strip the reply-fallback prefix from an incoming wire body so the UI
 * renders only the user's actual text. The reply chip is rendered
 * separately from the `inReplyTo` relation.
 */
export function stripReplyFallback(body: string): string {
  // Drop leading `> ...` lines plus the one blank separator line.
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  if (i === 0) return body;
  // Eat the single blank separator if present.
  if (i < lines.length && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

export function encodeMessageBody(body: MessageBody): IContent {
  // MSC3952 intentional mentions: attach as `m.mentions` when present,
  // so push rules on the homeserver fire correctly even when the body
  // text has no display-name match. We merge it onto every text-ish
  // result via the helper below to avoid duplicating the spread in
  // each branch (text formatted vs unformatted etc).
  const withMentions = <T extends Record<string, unknown>>(out: T): T => {
    if (body.msgtype !== 'm.text' && body.msgtype !== 'm.emote' && body.msgtype !== 'm.notice') {
      return out;
    }
    const m = body.mentions;
    if (!m) return out;
    const payload: { user_ids?: string[]; room?: true } = {};
    if (m.userIds && m.userIds.length > 0) payload.user_ids = m.userIds;
    if (m.room) payload.room = true;
    if (Object.keys(payload).length === 0) return out;
    return { ...out, 'm.mentions': payload };
  };

  switch (body.msgtype) {
    case 'm.text':
      return withMentions(
        body.formattedBody
          ? {
              msgtype: MsgType.Text,
              body: body.body,
              format: 'org.matrix.custom.html',
              formatted_body: body.formattedBody,
            }
          : { msgtype: MsgType.Text, body: body.body },
      );
    case 'm.emote':
      return withMentions({ msgtype: MsgType.Emote, body: body.body });
    case 'm.notice':
      return withMentions({ msgtype: MsgType.Notice, body: body.body });
    case 'm.image':
      return { msgtype: MsgType.Image, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.video':
      return { msgtype: MsgType.Video, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.audio': {
      const out: Record<string, unknown> = {
        msgtype: MsgType.Audio,
        body: body.body,
        url: body.url,
        info: mediaInfo(body.info),
      };
      // Re-emit MSC3245 voice keys so a re-encoded voice body (e.g. local
      // echo) stays a voice note on the wire.
      if (body.voice) out['org.matrix.msc3245.voice'] = {};
      if (body.audio) {
        const a: { duration?: number; waveform?: number[] } = {};
        if (body.audio.duration !== undefined) a.duration = body.audio.duration;
        if (body.audio.waveform) a.waveform = body.audio.waveform;
        out['org.matrix.msc1767.audio'] = a;
      }
      return out as IContent;
    }
    case 'm.file':
      return { msgtype: MsgType.File, body: body.body, url: body.url, info: mediaInfo(body.info) };
    case 'm.location':
      return { msgtype: 'm.location', body: body.body, geo_uri: body.geoUri };
  }
}

export function mediaInfo(info: MediaInfo): Record<string, unknown> {
  return {
    mimetype: info.mimetype,
    size: info.size,
    ...(info.width !== undefined ? { w: info.width } : {}),
    ...(info.height !== undefined ? { h: info.height } : {}),
    ...(info.duration !== undefined ? { duration: info.duration } : {}),
    ...(info.thumbnailUrl !== undefined ? { thumbnail_url: info.thumbnailUrl } : {}),
    ...(info.blurhash !== undefined ? { 'xyz.amorgan.blurhash': info.blurhash } : {}),
  };
}

export function decodeMessageBody(c: IContent): MessageBody {
  const msgtype = (c.msgtype ?? MsgType.Text) as string;
  // Strip Matrix reply-fallback `> <@sender> ...\n\n` prefix from the
  // wire body so the UI shows only the user's actual text. The reply
  // chip is rendered separately from the `m.relates_to.m.in_reply_to`
  // relation, which is decoded into `inReplyTo` upstream.
  const rawBody = typeof c.body === 'string' ? c.body : '';
  const isReply =
    !!(c as Record<string, unknown>)['m.relates_to'] &&
    !!((c as Record<string, unknown>)['m.relates_to'] as Record<string, unknown> | undefined)?.[
      'm.in_reply_to'
    ];
  const body = isReply ? stripReplyFallback(rawBody) : rawBody;
  // MSC3952 mentions on the receive side. We pluck this out once and
  // merge it into the structured text variants; matrix-js-sdk does
  // *not* surface this field at the typed-event layer, so the cast
  // to a record is unavoidable.
  const decodeMentions = (): { userIds: UserId[]; room?: boolean } | undefined => {
    const raw = (c as Record<string, unknown>)['m.mentions'];
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { user_ids?: unknown; room?: unknown };
    const userIds: UserId[] = Array.isArray(r.user_ids)
      ? r.user_ids.filter((u): u is UserId => typeof u === 'string' && u.startsWith('@'))
      : [];
    const isRoom = r.room === true;
    if (userIds.length === 0 && !isRoom) return undefined;
    const out: { userIds: UserId[]; room?: boolean } = { userIds };
    if (isRoom) out.room = true;
    return out;
  };
  switch (msgtype) {
    case MsgType.Text: {
      const mentions = decodeMentions();
      const rawFormatted =
        c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string'
          ? c.formatted_body
          : null;
      // Strip leading <mx-reply>...</mx-reply> fallback block when the
      // event carries a rich-reply relation. The reply chip is rendered
      // from `inReplyTo` separately.
      const formattedBody =
        rawFormatted && isReply
          ? rawFormatted.replace(/^\s*<mx-reply>[\s\S]*?<\/mx-reply>\s*/i, '')
          : rawFormatted;
      const base: MessageBody = {
        msgtype: 'm.text',
        body,
        formattedBody,
      };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Emote: {
      const mentions = decodeMentions();
      const base: MessageBody = { msgtype: 'm.emote', body };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Notice: {
      const mentions = decodeMentions();
      const base: MessageBody = { msgtype: 'm.notice', body };
      if (mentions) (base as { mentions?: typeof mentions }).mentions = mentions;
      return base;
    }
    case MsgType.Image:
    case MsgType.Video:
    case MsgType.Audio:
    case MsgType.File: {
      const file = decodeEncryptedFile(c);
      const base: MediaMessageBody = {
        msgtype: msgtype as MediaMessageBody['msgtype'],
        body,
        url: (c.url ?? '') as MxcUri,
        info: decodeMediaInfo(c.info),
      };
      if (file) (base as MediaMessageBody).file = file;
      // MSC3245 voice-message keys. matrix-js-sdk passes unknown content
      // keys through untouched, so we read them straight off the raw
      // content. Only attach for audio to keep other media bodies clean.
      if (msgtype === MsgType.Audio) {
        const rec = c as Record<string, unknown>;
        if (rec['org.matrix.msc3245.voice'] !== undefined) base.voice = true;
        const audioExt = rec['org.matrix.msc1767.audio'];
        if (audioExt && typeof audioExt === 'object') {
          const a = audioExt as { duration?: unknown; waveform?: unknown };
          const out: { duration?: number; waveform?: number[] } = {};
          if (typeof a.duration === 'number') out.duration = a.duration;
          if (Array.isArray(a.waveform)) {
            out.waveform = a.waveform.filter((n): n is number => typeof n === 'number');
          }
          if (out.duration !== undefined || out.waveform) base.audio = out;
        }
      }
      return base;
    }
    default:
      return { msgtype: 'm.text', body, formattedBody: null };
  }
}

/**
 * Pull the EncryptedFile payload off a wire `m.room.message` content for
 * encrypted-room media events (spec §11.x — `content.file` carries the
 * mxc + AES-CTR JWK + IV + ciphertext SHA-256 hash). Returns `null` for
 * plain media events (which use top-level `content.url`) or malformed
 * payloads — the renderer falls back to `body.url` in that case.
 *
 * This was previously dropped at decode, which made every encrypted
 * image / video / audio / file render as "image unavailable" since the
 * UI had no mxc to fetch from. The encrypted-attachment send side was
 * always correct.
 */
export function decodeEncryptedFile(c: IContent): EncryptedFile | null {
  const raw = (c as Record<string, unknown>).file;
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.url !== 'string' || !f.url.startsWith('mxc://')) return null;
  if (typeof f.iv !== 'string') return null;
  const key = f.key as Record<string, unknown> | undefined;
  if (!key || typeof key.k !== 'string') return null;
  const hashes = f.hashes as Record<string, unknown> | undefined;
  if (!hashes || typeof hashes.sha256 !== 'string') return null;
  // Build a fresh plain-JSON copy — matrix-js-sdk's IContent can carry
  // proxy / class wrappers / getters that survive its internal cloning
  // but fail the worker→main `structuredClone` we use to ship body
  // around (DataCloneError: "#<Object> could not be cloned"). Picking
  // each field by name strips anything non-spec, so the renderer-side
  // `worker.postMessage({ encryptedFile, … })` is always cloneable.
  return {
    v: 'v2',
    url: f.url as MxcUri,
    key: {
      kty: 'oct',
      alg: 'A256CTR',
      key_ops: ['encrypt', 'decrypt'],
      k: key.k,
      ext: true,
    },
    iv: f.iv,
    hashes: { sha256: hashes.sha256 },
  };
}

export function decodeMediaInfo(info: unknown): MediaInfo {
  const i = (info ?? {}) as Record<string, unknown>;
  return {
    mimetype: typeof i.mimetype === 'string' ? i.mimetype : 'application/octet-stream',
    size: typeof i.size === 'number' ? i.size : 0,
    ...(typeof i.w === 'number' ? { width: i.w } : {}),
    ...(typeof i.h === 'number' ? { height: i.h } : {}),
    ...(typeof i.duration === 'number' ? { duration: i.duration } : {}),
    ...(typeof i.thumbnail_url === 'string' ? { thumbnailUrl: i.thumbnail_url as MxcUri } : {}),
    ...(typeof i['xyz.amorgan.blurhash'] === 'string' ? { blurhash: i['xyz.amorgan.blurhash'] as string } : {}),
  };
}
