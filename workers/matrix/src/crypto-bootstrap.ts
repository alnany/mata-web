/**
 * Crypto initialization, isolated so the main `sdk-impl` chunk does not
 * pull in `@matrix-org/matrix-sdk-crypto-wasm` (≈9 MB inlined WASM) when
 * `ENABLE_E2EE` is false.
 *
 * Tree-shaking won't drop the SDK's `initRustCrypto` path from the JS bundle
 * by itself, so we route the SDK call through this file and gate the entire
 * file behind a dynamic import from `sdk-impl.ts`.
 */

import type { MatrixClient } from 'matrix-js-sdk';

export async function initRustCrypto(
  client: MatrixClient,
  pickleKeyRef: string,
  cryptoDbName: string,
): Promise<void> {
  const pickleKey = await derivePickleKey(pickleKeyRef);
  await client.initRustCrypto({
    useIndexedDB: true,
    storageKey: pickleKey,
    cryptoDatabasePrefix: cryptoDbName,
  });
}

async function derivePickleKey(ref: string): Promise<Uint8Array> {
  // TODO(phase-2): full PBKDF2-from-password derivation per ADR-003.
  const buf = new TextEncoder().encode(`mata.pickle.v1:${ref}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(hash);
}
