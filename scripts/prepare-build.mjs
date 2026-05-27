#!/usr/bin/env node
/**
 * Pre-build hook: stub out matrix-js-sdk's rust-crypto + the
 * matrix-sdk-crypto-wasm npm package so the production bundle excludes
 * the ~9 MB WASM payload when `MATA_ENABLE_E2EE` is unset/false.
 *
 * This runs after `pnpm install` (which materialises node_modules) and
 * before `pnpm build` (which feeds those stubbed modules into Vite).
 * On Vercel, this is wired in `vercel.json` as part of `buildCommand`.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

if (process.env.MATA_ENABLE_E2EE === 'true') {
  console.log('[prepare-build] MATA_ENABLE_E2EE=true → keeping rust-crypto, exiting.');
  process.exit(0);
}

console.log('[prepare-build] ENABLE_E2EE=false → stubbing rust-crypto + crypto-wasm…');

// 1. Stub the matrix-sdk-crypto-wasm package (preserves named exports as
//    throwing shims).
const wasmPkgGlob = execSync(
  "ls -d node_modules/.pnpm/@matrix-org+matrix-sdk-crypto-wasm@*/node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg 2>/dev/null || true",
  { cwd: root, encoding: 'utf8' }
).trim();

if (wasmPkgGlob) {
  for (const pkgDir of wasmPkgGlob.split('\n').filter(Boolean)) {
    const indexPath = join(root, pkgDir, 'index.js');
    if (existsSync(indexPath)) {
      execFileSync('node', [join(__dirname, 'stub-crypto-wasm.mjs'), indexPath], {
        cwd: root,
        stdio: 'inherit',
      });
    }
  }
} else {
  console.warn('[prepare-build] no matrix-sdk-crypto-wasm package found; skipping wasm stub.');
}

// 2. Stub each rust-crypto module — keep constants.js intact since
//    client.js statically imports a string prefix from it.
const rcGlob = execSync(
  "ls -d node_modules/.pnpm/matrix-js-sdk@*/node_modules/matrix-js-sdk/lib/rust-crypto 2>/dev/null || true",
  { cwd: root, encoding: 'utf8' }
).trim();

const STUB_SRC = [
  '// prepare-build: stubbed (ENABLE_E2EE=false)',
  "export async function initRustCrypto() { throw new Error('rust-crypto stubbed at build time'); }",
  "export class RustCrypto { constructor() { throw new Error('rust-crypto stubbed'); } }",
  '',
].join('\n');

const CONSTANTS_SRC = [
  "export const RUST_SDK_STORE_PREFIX = 'matrix-js-sdk::rust-sdk';",
  "export const RUST_BACKUP_STORE_PREFIX = 'matrix-js-sdk::rust-sdk-backup';",
  '',
].join('\n');

if (rcGlob) {
  for (const rcDir of rcGlob.split('\n').filter(Boolean)) {
    const abs = join(root, rcDir);
    const files = execSync(`ls ${abs}/*.js`, { encoding: 'utf8' }).trim().split('\n');
    for (const f of files) {
      const isConstants = f.endsWith('/constants.js');
      writeFileSync(f, isConstants ? CONSTANTS_SRC : STUB_SRC);
    }
    console.log(`[prepare-build] stubbed ${files.length} files in ${rcDir}`);
  }
} else {
  console.warn('[prepare-build] no matrix-js-sdk rust-crypto dir found; skipping.');
}

console.log('[prepare-build] done.');
