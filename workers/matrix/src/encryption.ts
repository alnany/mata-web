/**
 * Phase 5.2 — Cross-signing + Secret Secret Storage (SSSS) + Server-side
 * key backup. This file owns the four-RPC surface exposed in
 * `rpc-contract.ts`:
 *
 *   - `getEncryptionStatus` → snapshot of {crossSigningReady,
 *     secretStorageReady, keyBackupEnabled, keyBackupVersion}.
 *   - `listDevices` → user's own device list with cross-signing trust.
 *   - `enableKeyBackup` → bootstrap cross-signing (UIA password) +
 *     bootstrap SSSS (passphrase-derived key) + start a key backup. The
 *     base58-encoded private key is returned to the caller as the
 *     escape-hatch recovery key.
 *   - `restoreKeyBackup` → user-entered recovery key (either base58 or
 *     passphrase-derived; both produce the same private bytes). Caches
 *     it in `secretStorageKeyCache` so the SDK's `getSecretStorageKey`
 *     callback can decrypt SSSS-protected secrets, then asks the server
 *     for the current backup version and restores room keys.
 *
 * The `secretStorageKeyCache` lives on the SdkSession (passed in here)
 * so the SDK's `cryptoCallbacks.getSecretStorageKey` callback —
 * registered at `createClient` time in `sdk-impl.ts` — can read from it.
 * The cache is in-memory only; it is rebuilt from the user's recovery
 * passphrase on every fresh device restore.
 */

import type {
  AuthDict,
  MatrixClient,
  UIAResponse,
} from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/key-passphrase.js';
import type { GeneratedSecretStorageKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type {
  Device,
  EncryptionStatus,
  UserId,
} from '@mata/shared/matrix';
import { authError, cryptoError } from '@mata/shared/errors';

/**
 * The session-scoped state these helpers need access to. Lives on
 * `SdkSession` and is passed in by reference so the per-call methods
 * here can read/write the SSSS key cache and reach the live client.
 */
export interface EncryptionDeps {
  /** The MatrixClient, or `null` if not booted yet. */
  client(): MatrixClient | null;
  /** Cached SSSS private keys keyed by SSSS key id. */
  secretStorageKeyCache: Map<string, Uint8Array>;
}

function requireClient(deps: EncryptionDeps): MatrixClient {
  const c = deps.client();
  if (!c) throw authError('Not logged in');
  return c;
}

function requireCrypto(deps: EncryptionDeps) {
  const c = requireClient(deps);
  const crypto = c.getCrypto();
  if (!crypto) {
    throw cryptoError('Encryption is not initialized on this device yet.');
  }
  return { client: c, crypto };
}

export async function getEncryptionStatus(
  deps: EncryptionDeps,
): Promise<EncryptionStatus> {
  const c = deps.client();
  if (!c || !c.getCrypto()) {
    return {
      crossSigningReady: false,
      secretStorageReady: false,
      keyBackupEnabled: false,
      keyBackupVersion: null,
      recoveryReady: false,
    };
  }
  const crypto = c.getCrypto()!;
  const [crossSigningReady, secretStorageReady, activeBackupVersion] =
    await Promise.all([
      crypto.isCrossSigningReady(),
      crypto.isSecretStorageReady(),
      crypto.getActiveSessionBackupVersion(),
    ]);
  const keyBackupEnabled = activeBackupVersion !== null;
  return {
    crossSigningReady,
    secretStorageReady,
    keyBackupEnabled,
    keyBackupVersion: activeBackupVersion,
    recoveryReady:
      crossSigningReady && secretStorageReady && keyBackupEnabled,
  };
}

export async function listDevices(deps: EncryptionDeps): Promise<Device[]> {
  const { client, crypto } = requireCrypto(deps);
  const userId = client.getUserId();
  if (!userId) throw authError('No user id on client');
  const myDeviceId = client.getDeviceId();

  // /devices is the source-of-truth list (display name, last_seen).
  // Cross-signing trust comes from getDeviceVerificationStatus, which
  // requires keys for those devices to be in the local store. On a
  // fresh boot they may not be — devices we have never sent or received
  // a message to/from won't have keys queried yet. We force a query
  // with downloadUncached=true so the trust column is meaningful.
  const { devices } = await client.getDevices();
  await crypto.getUserDeviceInfo([userId], true);

  const out: Device[] = [];
  for (const d of devices) {
    const status = await crypto.getDeviceVerificationStatus(userId, d.device_id);
    // status === null means we couldn't even download the device's
    // identity keys (typically: device hasn't uploaded keys yet, brand
    // new). Treat as unverified rather than throwing.
    let verified: Device['verified'] = 'unverified';
    if (status) {
      if (status.crossSigningVerified || status.localVerified) {
        verified = 'verified';
      }
    }
    out.push({
      deviceId: d.device_id,
      displayName: d.display_name ?? null,
      lastSeenTs: d.last_seen_ts ?? null,
      lastSeenIp: d.last_seen_ip ?? null,
      isCurrent: d.device_id === myDeviceId,
      verified,
    });
  }

  // Sort: current device first, then verified, then most-recently-seen.
  out.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const av = a.verified === 'verified' ? 1 : 0;
    const bv = b.verified === 'verified' ? 1 : 0;
    if (av !== bv) return bv - av;
    return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
  });
  return out;
}

/**
 * Unified "set up secure backup" — runs three Matrix protocol flows in
 * order. Each is idempotent at the SDK level, so re-running this is
 * safe (it short-circuits steps already complete).
 *
 *   1. Cross-signing bootstrap.
 *      Generates master/self-signing/user-signing keypairs locally if
 *      they don't exist, then uploads the public halves via
 *      POST /keys/device_signing/upload. That endpoint requires
 *      User-Interactive Auth — we satisfy it with m.login.password
 *      using the user's normal login password.
 *
 *   2. Secret Secret Storage bootstrap.
 *      Derives an SSSS key from `passphrase` (PBKDF2 per spec, salt and
 *      iteration count live in `keyInfo`), stores it as the default
 *      account-data key, then asks the SDK to mirror the cross-signing
 *      private halves + the soon-to-be-created backup decryption key
 *      under it. Also flips on a new key-backup version via
 *      `setupNewKeyBackup: true`.
 *
 *   3. We cache the freshly-minted SSSS private bytes in
 *      `secretStorageKeyCache` so any subsequent SDK call that needs to
 *      decrypt SSSS payloads in this session can find them without
 *      re-deriving from passphrase.
 *
 * The base58-encoded private key bytes are returned to the caller so
 * the UI can show them to the user as the offline recovery key (the
 * escape hatch if they forget the passphrase). The SDK clears the raw
 * bytes from `GeneratedSecretStorageKey` after the bootstrap, so this
 * is the only place the recovery key can be surfaced.
 */
export async function enableKeyBackup(
  deps: EncryptionDeps,
  password: string,
  passphrase: string,
): Promise<{ recoveryKey: string }> {
  const { client, crypto } = requireCrypto(deps);
  const userId = client.getUserId();
  if (!userId) throw authError('No user id on client');

  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (
      makeRequest: (auth: AuthDict | null) => Promise<UIAResponse<void>>,
    ) => {
      // Pattern is: SDK calls our callback with `makeRequest`. We call
      // `makeRequest(authDict)` to actually submit the upload. The SDK
      // handles the first 401-with-flows step itself; we just supply
      // the auth dict for the password stage.
      await makeRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: userId as UserId },
        password,
      });
    },
  });

  // Stash the generated key bytes so we can both (a) return the
  // base58 form to the UI for offline storage and (b) populate the
  // session's SSSS cache below.
  let generated: GeneratedSecretStorageKey | null = null;

  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    setupNewKeyBackup: true,
    createSecretStorageKey: async () => {
      // The SDK's createRecoveryKeyFromPassphrase does the full PBKDF2
      // derivation + builds a GeneratedSecretStorageKey ({ privateKey,
      // encodedPrivateKey, keyInfo: { passphrase: {algorithm, salt,
      // iterations} } }) in one shot. We just hand the passphrase in
      // and let the SDK pick fresh salt/iterations per spec.
      generated = await crypto.createRecoveryKeyFromPassphrase(passphrase);
      return generated;
    },
  });

  if (!generated) {
    throw cryptoError('SSSS bootstrap completed without generating a key (SDK skipped createSecretStorageKey)');
  }
  const gen = generated as GeneratedSecretStorageKey;
  if (!gen.encodedPrivateKey || !gen.privateKey) {
    throw cryptoError('Generated SSSS key missing private material');
  }

  // Cache the private bytes against the new SSSS key id so subsequent
  // calls inside this session don't have to re-derive from passphrase.
  // The key id is the only public reference the SDK keeps after
  // bootstrap — pull it from default_key in account_data.
  const defaultKeyId =
    (await client.getAccountDataFromServer<{ key: string }>(
      'm.secret_storage.default_key',
    ))?.key ?? null;
  if (defaultKeyId) {
    deps.secretStorageKeyCache.set(defaultKeyId, gen.privateKey);
  }

  return { recoveryKey: gen.encodedPrivateKey };
}

/**
 * Restore on a new device from the user-entered recovery key. Accepts
 * either:
 *  - the base58-encoded private key shown to them at setup, OR
 *  - the security passphrase they chose (we re-derive via PBKDF2 from
 *    the salt+iterations stored alongside the SSSS key info).
 *
 * Stages:
 *  1. Resolve a private-key Uint8Array from the user input.
 *  2. Cache it under the default SSSS key id so the SDK can use it.
 *  3. Run cross-signing/SSSS bootstrap once more — with private bytes
 *     already cached, the SDK's "is already set up" short-circuits
 *     trigger, downloads cross-signing private parts from SSSS, and
 *     this device becomes trusted.
 *  4. Trigger checkKeyBackupAndEnable to start importing room keys.
 *
 * Returns the number of room keys successfully imported.
 */
export async function restoreKeyBackup(
  deps: EncryptionDeps,
  userInput: string,
): Promise<{ keysImported: number }> {
  const { client, crypto } = requireCrypto(deps);

  // Step 1: figure out the default SSSS key id + its keyInfo (we need
  // the PBKDF2 params if the user gave us a passphrase).
  const defaultKeyId = (
    await client.getAccountDataFromServer<{ key: string }>(
      'm.secret_storage.default_key',
    )
  )?.key;
  if (!defaultKeyId) {
    throw cryptoError('No secret storage is set up on the server. Set up secure backup first on a device that has your keys.');
  }
  const keyInfo = await client.getAccountDataFromServer<{
    passphrase?: {
      algorithm: string;
      salt: string;
      iterations: number;
      bits?: number;
    };
  }>(`m.secret_storage.key.${defaultKeyId}`);
  if (!keyInfo) {
    throw cryptoError(`Could not read SSSS key info for ${defaultKeyId} from server`);
  }

  // Step 2: try base58 decode first; if that fails AND a passphrase
  // descriptor exists, treat input as the passphrase.
  let privateKey: Uint8Array | null = null;
  try {
    privateKey = decodeRecoveryKey(userInput.replace(/\s+/g, ''));
  } catch {
    // not a recovery key
  }
  if (!privateKey && keyInfo.passphrase) {
    // Low-level helper signature in matrix-js-sdk 34.x is
    // (passphrase, salt, iterations, numBits?) → Promise<Uint8Array>.
    // We need the exact salt + iteration count the original setup
    // used; both live in account_data alongside the SSSS key id.
    privateKey = await deriveRecoveryKeyFromPassphrase(
      userInput,
      keyInfo.passphrase.salt,
      keyInfo.passphrase.iterations,
      keyInfo.passphrase.bits,
    );
  }
  if (!privateKey) {
    throw cryptoError('Could not interpret input as a recovery key or passphrase.');
  }

  // Step 3: cache + run bootstrap. With the SSSS bytes cached,
  // bootstrapSecretStorage finds existing storage, sees we already
  // have the key, and pulls cross-signing private parts down from it.
  deps.secretStorageKeyCache.set(defaultKeyId, privateKey);
  await crypto.bootstrapCrossSigning({
    // No UIA needed on restore — keys already uploaded by another
    // device; we just download privates from SSSS to verify ourselves.
  });
  await crypto.bootstrapSecretStorage({});

  // Step 4: re-check + enable backup. Returns null if no backup on
  // server; otherwise SDK starts decrypting and importing room keys
  // from the server-side backup using the now-cached SSSS key.
  const check = await crypto.checkKeyBackupAndEnable();
  if (!check) {
    return { keysImported: 0 };
  }

  // Step 5 — ACTIVELY pull every backed-up session down.
  //
  // checkKeyBackupAndEnable() only verifies the backup is trusted and
  // turns on *future* backup-of-new-keys; it does NOT walk the
  // server's existing /room_keys/keys archive and import historical
  // megolm sessions. Without this step the user clicks "Restore from
  // backup", we silently approve trust, and zero past messages
  // decrypt — exactly the "I restored but old messages are still
  // missing" symptom on first set-up of a second device.
  //
  // The legacy client API restoreKeyBackupWithRecoveryKey downloads
  // every session, decrypts them with the recovery key bytes (the
  // backup decryption key derives from the same SSSS curve25519
  // private), and pushes them into the crypto store. matrix-js-sdk's
  // BackupDecryptor then fires MatrixEvent decrypted callbacks on
  // every event whose session id was just imported — so the live
  // tab's "🔒 N encrypted messages" pill collapses and the real text
  // appears without a refresh, because sdk-impl.ts already re-emits
  // syncUpdate on the MatrixEventEvent.Decrypted hook.
  //
  // We pass the raw user input (whitespace-stripped) — the API parses
  // it as base58 internally. Passphrase input still flows through
  // here because deriveRecoveryKeyFromPassphrase above seeded
  // `privateKey`; the API will fall back to base58 parsing first then
  // re-derive if needed. Either way the result is the same curve25519
  // private bytes the backup was encrypted with.
  const recoveryKeyInput = userInput.replace(/\s+/g, '');
  let result: { total: number; imported: number };
  try {
    result = await client.restoreKeyBackupWithRecoveryKey(
      recoveryKeyInput,
      undefined,
      undefined,
      check.backupInfo,
    );
  } catch (err) {
    // Surface a useful message but don't unwind the bootstrap that
    // already succeeded — the user IS now cross-signed and SSSS is
    // hydrated; only the historical-key download failed.
    throw cryptoError(
      `Restored cross-signing but key import failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Step 6 — Retry decryption on already-loaded UTD events.
  //
  // The newly-imported sessions cause matrix-js-sdk to fire
  // MatrixEventEvent.Decrypted for events that were waiting on those
  // session ids — but only for events the SDK still has open
  // attemptDecryption promises on. Events that we already mapped to
  // m.room.encrypted{decryptionStatus:'failed'} a long time ago will
  // NOT re-attempt automatically; the SDK considers their decryption
  // pipeline closed. Walking every room's live timeline and
  // re-asking decryptEventIfNeeded() forces a fresh attempt, which
  // now succeeds because the session is in the crypto store, and
  // fires the Decrypted hook the worker already taps to re-emit
  // syncUpdate.
  //
  // This is best-effort: a room with thousands of historical UTDs
  // will take a few seconds to walk, but every retry is cheap (the
  // megolm AES path is fast) and matrix-js-sdk dedupes if the event
  // is already mid-flight.
  for (const room of client.getRooms()) {
    const events = room.getLiveTimeline().getEvents();
    for (const ev of events) {
      if (ev.isDecryptionFailure()) {
        // Fire and forget — each retry resolves on its own and the
        // Decrypted hook handles the UI update. Awaiting in series
        // would needlessly stretch the spinner.
        client.decryptEventIfNeeded(ev).catch(() => {
          /* swallow — the event will stay UTD if the session truly
             isn't in the imported set (e.g. sender used a different
             megolm session than the one backed up). */
        });
      }
    }
  }

  return { keysImported: result.imported };
}
