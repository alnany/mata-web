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

// Force Vite to bundle rust-crypto + crypto-wasm with THIS chunk. Without
// the static references, matrix-js-sdk's internal
// `await import("./rust-crypto/index.js")` inside client.js can be
// invisible to Vite's worker bundler, so the rust-crypto module never
// makes it into any chunk and runtime crypto init silently fails with
// `Failed to fetch dynamically imported module`.
//
// When MATA_ENABLE_E2EE=false, the Vite alias in apps/web/vite.config.ts
// rewrites both module ids to the stub, so this entire file gets
// dead-code-eliminated downstream from the guarded dynamic import in
// sdk-impl.ts. When E2EE=true, the real modules are pulled in.
import 'matrix-js-sdk/lib/rust-crypto';
import '@matrix-org/matrix-sdk-crypto-wasm';

export type CryptoBootstrapProgress = (phase: string, elapsedMs: number) => void;

export async function initRustCrypto(
  client: MatrixClient,
  pickleKeyRef: string,
  _cryptoDbName: string,
  onPhase: CryptoBootstrapProgress = () => {},
): Promise<void> {
  // Granular phase reporting so the SyncBanner can pinpoint which step
  // is hanging when the outer 30s race fires. Previously the only signal
  // we had was "crypto init exceeded 30s" — that gave us a timeout but
  // not the actual stuck phase.
  const t0 = Date.now();
  const phase = (name: string) => onPhase(name, Date.now() - t0);

  phase('deriving pickle key');
  const pickleKey = await derivePickleKey(pickleKeyRef);

  phase('calling client.initRustCrypto (wasm load + IDB open + OlmMachine init)');
  // matrix-js-sdk 34.x's initRustCrypto API is narrow: { useIndexedDB,
  // storageKey, storagePassword }. The IndexedDB database name is fixed
  // by the SDK (RUST_SDK_STORE_PREFIX); we used to pass cryptoDatabasePrefix
  // but the field is not part of the public signature and was silently
  // ignored. Kept the param in the signature for forward-compat.
  await client.initRustCrypto({
    useIndexedDB: true,
    storageKey: pickleKey,
  });
  phase('client.initRustCrypto resolved');

  // Default device isolation = AllDevicesIsolatedMode (send to all known
  // device keys regardless of trust). That's what Element does and what
  // unblocks sends to encrypted rooms without verification. Cross-signing
  // + SAS verification is queued for Phase 5.2.
}

async function derivePickleKey(ref: string): Promise<Uint8Array> {
  // TODO(phase-2): full PBKDF2-from-password derivation per ADR-003.
  const buf = new TextEncoder().encode(`mata.pickle.v1:${ref}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(hash);
}
