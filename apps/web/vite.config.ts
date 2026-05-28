import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

const ENABLE_E2EE = process.env.MATA_ENABLE_E2EE === 'true';

// When E2EE is off, alias matrix-js-sdk's rust-crypto module to a stub so
// the ~9 MB crypto-wasm chunk is excluded from the bundle entirely. See
// `workers/matrix/src/rust-crypto-stub.ts` for the contract. This is also
// the path the Vercel deploy uses, where the argv-limited Composio channel
// can't pump the full 25 MB build through.
const cryptoAlias = ENABLE_E2EE
  ? []
  : [
      { find: /^matrix-js-sdk\/lib\/rust-crypto.*/, replacement: new URL('../../workers/matrix/src/rust-crypto-stub.ts', import.meta.url).pathname },
      { find: '@matrix-org/matrix-sdk-crypto-wasm', replacement: new URL('../../workers/matrix/src/rust-crypto-stub.ts', import.meta.url).pathname },
    ];

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: { alias: cryptoAlias },
  define: {
    // Compile-time feature flag. When false, the crypto-wasm chunk is
    // dead-code-eliminated because `crypto-bootstrap.ts` is only reached
    // via a guarded dynamic import in `sdk-impl.ts`.
    ENABLE_E2EE: JSON.stringify(ENABLE_E2EE),
    // matrix-js-sdk has Node-isms — references to `global` and a few
    // `process.env.*` lookups. The browser/worker globals are `globalThis`
    // and an empty env object. Without these aliases, login fails with
    // "global is not defined" the moment the SDK's lazy modules load.
    global: 'globalThis',
    'process.env.NODE_DEBUG': 'undefined',
    'process.env.DEBUG': 'undefined',
  },
  server: {
    port: 5173,
    strictPort: true,
    // COEP=require-corp was added speculatively to enable SharedArrayBuffer
    // for matrix-rust-sdk WASM threads, but matrix-sdk-crypto-wasm 9.x does
    // not use SAB. The cost was huge: every cross-origin /_matrix/ fetch
    // got blocked by the browser unless the homeserver emitted
    // Cross-Origin-Resource-Policy on every response, which most homeservers
    // (including conduwuit and matrix.org) do not. Result: silent sync
    // hang — fetch() never resolves, no /_matrix/ requests appear in DevTools
    // Network tab because the browser blocks them at the network layer
    // before they fire on the wire. Removed. If we ever ship multi-threaded
    // WASM crypto we'll need to either run a CORP-injecting proxy in front
    // of the homeserver or use a registered service-worker shim.
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Source maps are not deployed; they make tarballs huge for the
    // crypto-wasm chunks. Local dev builds get them via vite serve.
    sourcemap: false,
    cssCodeSplit: true,
    // We tried terser with aggressive compress/mangle to squeeze under
    // Composio's old 1MB-per-request deploy gateway. On Vercel that
    // ceiling no longer exists, and terser's `compress.unused` keeps
    // misanalyzing Babel's `_asyncToGenerator` helper (mutually-recursive
    // `_next` / `_throw` function declarations inside a Promise
    // executor) — eliminating one of the two declarations while the
    // sibling still references it → `ReferenceError: c is not defined`
    // at runtime on the first async-await call in the worker (sync /
    // sendMessage / decrypt). esbuild's minifier handles this case
    // correctly and is what Vite uses by default; we just opt back in.
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('solid-js')) return 'solid';
          if (id.includes('@solidjs/router')) return 'router';
          // Split matrix-js-sdk into halves so each Composio-bound deploy
          // chunk stays well under the 1 MB request ceiling. Boundary is
          // alphabetical filename ordering — stable and reproducible.
          if (id.includes('matrix-js-sdk/lib/')) {
            const m = id.match(/matrix-js-sdk\/lib\/([^/]+)/);
            if (m) {
              const first = m[1][0].toLowerCase();
              if (first < 'm') return 'matrix-a';
              return 'matrix-b';
            }
            return 'matrix-b';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
