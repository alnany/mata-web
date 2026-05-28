/**
 * @mata/worker-matrix — entry point of the dedicated Web Worker that hosts
 * matrix-rust-sdk (via WASM, wired up in Phase 1) and exposes the
 * @mata/shared RPC contract to the main thread.
 *
 * Phase 0: bridge scaffolding only. `ping` and `restoreSession` are wired
 * so we can prove the worker boundary works end-to-end. Login / sync /
 * crypto land in Phase 1, behind this same interface.
 */

// MUST be the first import — installs globalThis.Buffer before any
// matrix-js-sdk module's top-level code runs. See buffer-polyfill.ts.
import './buffer-polyfill.js';

import { installBridge } from './bridge.js';

declare const self: DedicatedWorkerGlobalScope;

installBridge(self);
