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
    // Cross-Origin isolation enables SharedArrayBuffer, which matrix-rust-sdk's
    // WASM build will use for atomic operations across the worker boundary.
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
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
    // terser hits ~20-30% smaller than the default esbuild minifier on
    // matrix-js-sdk specifically, which matters because the Composio
    // deploy gateway caps a single request at ~1 MB.
    minify: 'terser',
    terserOptions: {
      compress: {
        passes: 3,
        pure_funcs: ['console.debug', 'console.log'],
        dead_code: true,
        unused: true,
        toplevel: true,
      },
      mangle: { toplevel: true },
      format: { comments: false },
    },
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
