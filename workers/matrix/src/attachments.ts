/**
 * Phase 6 — File / image attachment send + receive.
 *
 * Matrix encrypted attachments (spec v2):
 *   - Random 256-bit AES key (JWK), random 128-bit IV (zero-counter form)
 *   - AES-256-CTR over the file bytes
 *   - SHA-256 over the ciphertext, base64-unpadded
 *   - Ciphertext uploaded plaintext to /_matrix/media (the server never
 *     sees the key), event content carries the JWK + iv + hash + mxc
 *     under `file:` (instead of `url:` for unencrypted rooms).
 *
 * The same primitives run in reverse on receive: fetch the ciphertext
 * blob from the homeserver via `MatrixClient.mxcUrlToHttp`, AES-CTR
 * decrypt with the JWK from the event, hand back raw bytes for the UI
 * to URL.createObjectURL.
 *
 * All crypto runs in the dedicated worker (no main-thread blocking).
 * The plain-AES path uses WebCrypto's `crypto.subtle`, available in
 * dedicated workers since 2018 in evergreen browsers.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import { EventType, MsgType } from 'matrix-js-sdk';
import type {
  EventId,
  MediaInfo,
  MessageBody,
  MxcUri,
  RoomId,
} from '@mata/shared/matrix';
import { authError, cryptoError, networkError } from '@mata/shared/errors';
import { getCachedMedia, putCachedMedia } from './media-cache.js';

// ---------------------------------------------------------------------------
// base64 helpers — encrypted-attachment spec uses *unpadded* base64.
// ---------------------------------------------------------------------------

function bytesToUnpaddedB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '');
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToUnpaddedB64(bytes).replace(/\+/g, '-').replace(/\//g, '_');
}

function b64UrlToBytes(s: string): Uint8Array {
  let raw = s.replace(/-/g, '+').replace(/_/g, '/');
  // Pad back to multiple of 4 for atob.
  while (raw.length % 4) raw += '=';
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64UnpaddedToBytes(s: string): Uint8Array {
  let raw = s;
  while (raw.length % 4) raw += '=';
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * The `file` object stored in an encrypted-room m.image / m.file / etc
 * event content. Matches the Matrix v2 EncryptedFile shape — JWK-formatted
 * 256-bit AES key, 128-bit IV, SHA-256 ciphertext hash.
 */
export interface EncryptedFileWire {
  v: 'v2';
  url: string; // mxc:// — present even on encrypted events; key is what's secret.
  key: {
    kty: 'oct';
    alg: 'A256CTR';
    key_ops: ['encrypt', 'decrypt'];
    k: string; // base64url, unpadded.
    ext: true;
  };
  iv: string; // base64, unpadded.
  hashes: { sha256: string };
}

// ---------------------------------------------------------------------------
// encrypt — file send for E2EE rooms
// ---------------------------------------------------------------------------

async function encryptAttachment(plaintext: ArrayBuffer): Promise<{
  ciphertext: ArrayBuffer;
  info: EncryptedFileWire;
}> {
  // 256-bit random key, exported as JWK (the event content carries the
  // raw key — anyone with megolm decrypts the event and then this key).
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  // 128-bit IV: spec v2 says random upper 64 bits + zero counter for
  // lower 64. Generating fully random 128 bits is fine in practice
  // (collision probability negligible) and matches what
  // matrix-encrypt-attachment does in element-web. We use 8 random
  // bytes + 8 zero bytes for spec compliance.
  const ivBytes = new Uint8Array(16);
  crypto.getRandomValues(ivBytes.subarray(0, 8));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: ivBytes, length: 64 },
    aesKey,
    plaintext,
  );

  // SHA-256 over CIPHERTEXT (not plaintext), unpadded base64.
  const hashBuf = await crypto.subtle.digest('SHA-256', ciphertext);

  const exported = (await crypto.subtle.exportKey('jwk', aesKey)) as {
    k: string;
  };
  // `exportKey('jwk')` returns standard base64url WITHOUT padding for
  // `k`, which is what the spec wants. We pass it through as-is.

  return {
    ciphertext,
    info: {
      v: 'v2',
      url: '' as string, // filled in by caller after upload.
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        key_ops: ['encrypt', 'decrypt'],
        k: exported.k,
        ext: true,
      },
      iv: bytesToUnpaddedB64(ivBytes),
      hashes: { sha256: bytesToUnpaddedB64(new Uint8Array(hashBuf)) },
    },
  };
}

/**
 * Send a file/image/video/audio as an m.room.message event.
 *
 * For encrypted rooms: encrypt-then-upload-then-send-with-`file`.
 * For plain rooms:    upload-then-send-with-`url`.
 *
 * `info.mimetype` and `info.size` are required; width/height/duration
 * are optional and threaded through verbatim. Spec keeps `body` as the
 * filename — clients fall back to it when the media can't be rendered.
 */
export async function sendFileMessage(
  client: MatrixClient,
  args: {
    roomId: RoomId;
    data: ArrayBuffer;
    filename: string;
    info: MediaInfo;
    txnId: string;
    extraContent?: Record<string, unknown>;
  },
): Promise<{ eventId: EventId }> {
  if (!client.getUserId()) throw authError('Not logged in');

  const { roomId, data, filename, info, txnId, extraContent } = args;
  const isEncrypted = (() => {
    try {
      return client.isRoomEncrypted(roomId);
    } catch {
      return false;
    }
  })();

  const msgtype = pickMsgType(info.mimetype);

  let content: MessageBody;
  if (isEncrypted) {
    const { ciphertext, info: enc } = await encryptAttachment(data);
    // Upload the ciphertext bytes as application/octet-stream so the
    // homeserver doesn't try to thumbnail / sniff it.
    const blob = new Blob([ciphertext], { type: 'application/octet-stream' });
    const uploadRes = await client.uploadContent(blob, {
      name: filename,
      type: 'application/octet-stream',
    });
    enc.url = uploadRes.content_uri;
    content = buildBody(msgtype, filename, info, { file: enc }, extraContent);
  } else {
    const blob = new Blob([data], { type: info.mimetype });
    const uploadRes = await client.uploadContent(blob, {
      name: filename,
      type: info.mimetype,
    });
    content = buildBody(
      msgtype,
      filename,
      info,
      { url: uploadRes.content_uri as MxcUri },
      extraContent,
    );
  }

  try {
    const result = await client.sendEvent(
      roomId,
      EventType.RoomMessage,
      // Cast: MessageBody is a strict subset of the room.message content
      // shape. encodeMessageBody (in sdk-impl) is the canonical encoder
      // for `m.text`/`m.notice`/`m.emote`; media types are already in
      // wire shape so we send them directly.
      content as unknown as Record<string, unknown>,
      txnId,
    );
    return { eventId: result.event_id as EventId };
  } catch (err) {
    throw networkError(
      `sendFileMessage failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

function pickMsgType(mime: string): 'm.image' | 'm.video' | 'm.audio' | 'm.file' {
  if (mime.startsWith('image/')) return 'm.image';
  if (mime.startsWith('video/')) return 'm.video';
  if (mime.startsWith('audio/')) return 'm.audio';
  return 'm.file';
}

function buildBody(
  msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file',
  filename: string,
  info: MediaInfo,
  ref: { url?: MxcUri; file?: EncryptedFileWire },
  extraContent?: Record<string, unknown>,
): MessageBody {
  // Build a content object that matches MessageBody for *plain* rooms
  // (which requires `url`) and slips the `file` payload through as an
  // extra field for encrypted rooms. The shared type currently only
  // models `url`; we widen it via a cast at the callsite. Phase 6.1
  // extends MessageBody to model the encrypted shape natively.
  const out = {
    msgtype,
    body: filename,
    info,
  } as unknown as MessageBody & { file?: EncryptedFileWire; url?: MxcUri };
  if (ref.file) out.file = ref.file;
  if (ref.url) out.url = ref.url;
  // Ensure ts is happy: media MessageBody variants require `url`. For
  // encrypted rooms `url` will be empty — readers must check `file`
  // first.
  if (!ref.url) (out as { url: MxcUri }).url = '' as MxcUri;
  // Merge MSC3245 voice keys (and any future extras) over the body.
  if (extraContent) Object.assign(out, extraContent);
  return out;
}

// ---------------------------------------------------------------------------
// decrypt — file receive
// ---------------------------------------------------------------------------

/**
 * Load and (if needed) decrypt a media attachment.
 *
 * Two shapes:
 *  - `{ mxc, encryptedFile? = null }` for unencrypted media → just
 *    fetch the bytes from the homeserver and hand them back.
 *  - `{ mxc, encryptedFile }` for encrypted media → fetch the
 *    ciphertext, validate hash, AES-CTR decrypt with the JWK.
 *
 * Returns raw bytes + a MIME hint (sniffed from `encryptedFile` is
 * impossible — the event's `info.mimetype` is what tells us how to
 * render, so we expose it to the caller).
 */
export async function loadMedia(
  client: MatrixClient,
  args: { mxc: MxcUri; encryptedFile?: EncryptedFileWire | null; mime: string },
): Promise<{ data: ArrayBuffer; mime: string }> {
  const { mxc, encryptedFile, mime } = args;

  // ─── Cache fast path ──────────────────────────────────────────────────
  // mxc URIs are content-addressed by the Matrix spec — same URI ⇒ same
  // bytes forever. We can safely return cached plaintext without any
  // re-validation. The cache holds *decrypted* bytes, so even encrypted
  // attachments skip both the network fetch and the AES-CTR pass on a
  // hit. Cache failures fall through to the normal network path.
  const cached = await getCachedMedia(mxc);
  if (cached) {
    // Copy the buffer so the caller can't mutate the cached bytes via a
    // shared view. Cheap relative to the network + decrypt we're saving.
    const copy = cached.data.slice(0);
    return { data: copy, mime: cached.mime ?? mime };
  }

  // matrix-js-sdk 34 signature:
  //   mxcUrlToHttp(mxc, width?, height?, resizeMethod?, allowDirectLinks?,
  //                allowRedirects?, useAuthentication?): string | null
  // The 7th positional flips the URL from legacy `/_matrix/media/v3/download/...`
  // (unauth, rejected by modern Synapse with `enable_authenticated_media: true`)
  // to `/_matrix/client/v1/media/download/...` (authenticated). We were passing
  // `true` in position 6 = `allowRedirects`, leaving `useAuthentication` undefined
  // and silently shipping the legacy URL — Synapse 1.100+ answers that with
  // 404/401 even when we attach `Authorization: Bearer`, which is exactly the
  // "image unavailable" the user is seeing.
  const httpUrl = client.mxcUrlToHttp(
    mxc,
    undefined, // width
    undefined, // height
    undefined, // resizeMethod
    undefined, // allowDirectLinks
    true, // allowRedirects — follow CDN 30x from the v1 endpoint
    true, // useAuthentication — REQUIRED to get the v1 URL
  );
  if (!httpUrl) throw cryptoError(`Could not resolve mxc URL: ${mxc}`);

  // The Matrix v1.11 spec requires Authorization on /_matrix/client/v1/
  // media endpoints (authenticated media). matrix-js-sdk's mxcUrlToHttp
  // with `useAuthentication=true` builds the v1 URL; we still have to
  // attach the access token ourselves on a manual fetch since
  // `fetch()` doesn't get the SDK's interceptor.
  const accessToken = client.getAccessToken();
  if (!accessToken) throw authError('No access token; cannot download media.');

  const res = await fetch(httpUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw networkError(`media download failed: ${res.status} ${res.statusText}`);
  }
  const cipherOrPlain = await res.arrayBuffer();

  if (!encryptedFile) {
    // Unencrypted path: persist plaintext to the cache so the next
    // render skips the network entirely. Fire-and-forget — the
    // caller doesn't care whether the write succeeds.
    void putCachedMedia(mxc, cipherOrPlain, mime).catch(() => {});
    return { data: cipherOrPlain, mime };
  }

  // Verify ciphertext hash before attempting decrypt — a hash mismatch
  // is a hard fail (someone tampered with the ciphertext, or we got
  // the wrong blob). Saves on a wasted AES-CTR pass and surfaces the
  // real failure cleanly.
  const hashBuf = await crypto.subtle.digest('SHA-256', cipherOrPlain);
  const observed = bytesToUnpaddedB64(new Uint8Array(hashBuf));
  if (observed !== encryptedFile.hashes.sha256) {
    throw cryptoError(
      `media hash mismatch: expected ${encryptedFile.hashes.sha256.slice(0, 12)}…, got ${observed.slice(0, 12)}…`,
    );
  }

  const ivBytes = b64UnpaddedToBytes(encryptedFile.iv);
  // Some servers/clients have historically written iv as base64url —
  // try b64url decode as a fallback if the unpadded base64 form
  // produced the wrong length.
  const iv = ivBytes.length === 16 ? ivBytes : b64UrlToBytes(encryptedFile.iv);

  const aesKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: encryptedFile.key.kty,
      alg: encryptedFile.key.alg,
      key_ops: encryptedFile.key.key_ops,
      k: encryptedFile.key.k,
      ext: encryptedFile.key.ext,
    },
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    aesKey,
    cipherOrPlain,
  );

  // Encrypted path: stash plaintext so the next scroll-into-view skips
  // both the network round-trip AND the AES-CTR pass. This is the path
  // where caching actually saves CPU, not just bytes.
  void putCachedMedia(mxc, plaintext, mime).catch(() => {});

  return { data: plaintext, mime };
}

// Re-export MsgType so callers (sdk.ts) can build msgtype-aware UIs
// without a separate matrix-js-sdk import path.
export { MsgType };
