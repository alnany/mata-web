#!/usr/bin/env node
/**
 * Rewrite @matrix-org/matrix-sdk-crypto-wasm's pkg/index.js as a stub.
 * Preserves the original named exports as throwing shims so Vite/Rollup
 * can still resolve `import { UserId, RoomId, ... } from '@matrix-org/...'`.
 * Required when ENABLE_E2EE=false; the real WASM never executes anyway.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const targetPath = process.argv[2];
if (!targetPath) {
  console.error('usage: stub-crypto-wasm.mjs <path-to-pkg-index.js>');
  process.exit(2);
}

const source = readFileSync(targetPath, 'utf8');
const names = new Set();
// ESM declarations
for (const m of source.matchAll(/export\s+(?:class|const|function|async\s+function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
  names.add(m[1]);
}
// CommonJS-style (wasm-bindgen output)
for (const m of source.matchAll(/module\.exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
  names.add(m[1]);
}
// Defensive: skip wasm-bindgen internals (start with __wbg or __wbindgen) —
// they're never imported by matrix-js-sdk and bloat our stub for no reason.
for (const n of [...names]) {
  if (n.startsWith('__wbg') || n.startsWith('__wbindgen')) names.delete(n);
}

const header = `// Auto-generated stub: ENABLE_E2EE=false build path.
// The real wasm-bindgen file is replaced so Vite/Rollup never bundle the
// 9 MB WASM payload. If anything actually invokes these at runtime we
// want a loud, easy-to-grep failure, not silent corruption.
const ERR = 'matrix-sdk-crypto-wasm is stubbed for ENABLE_E2EE=false builds';
function shim() { throw new Error(ERR); }
class Stub { constructor() { throw new Error(ERR); } }
export async function initAsync() { throw new Error(ERR); }
export async function getVersions() { throw new Error(ERR); }
export async function start() { throw new Error(ERR); }
`;

const exportLines = [...names]
  .filter((n) => !['initAsync', 'getVersions', 'start'].includes(n))
  .map((n) => `export const ${n} = Stub;`)
  .join('\n');

const footer = `\nexport default { __stub: true };\n`;

writeFileSync(targetPath, header + exportLines + footer);
console.log(`stubbed ${targetPath} (${names.size} exports)`);
