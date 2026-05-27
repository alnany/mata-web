/**
 * Stub for matrix-js-sdk's rust-crypto module. When the build sets
 * ENABLE_E2EE=false, Vite's `resolve.alias` swaps the real rust-crypto
 * implementation (which transitively pulls ~9 MB of WASM) with this file.
 *
 * The real `initRustCrypto` is invoked from `client.js` via a dynamic
 * import, so if E2EE is disabled at compile time we never call into this
 * file — the stub exists only to satisfy the module resolver during
 * bundling. Importing it at runtime throws loudly so we'd notice if the
 * conditional ever flipped wrong.
 */

const message =
  'rust-crypto is stubbed out for this build (ENABLE_E2EE=false). ' +
  'Enable E2EE by setting MATA_ENABLE_E2EE=true at build time.';

export async function initRustCrypto(): Promise<never> {
  throw new Error(message);
}

export class RustCrypto {
  constructor() {
    throw new Error(message);
  }
}

export default { initRustCrypto, RustCrypto };
