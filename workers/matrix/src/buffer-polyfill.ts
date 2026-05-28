/**
 * Node Buffer polyfill for the browser worker.
 *
 * matrix-js-sdk's secret-storage / key-backup bootstrap paths
 * (SSSS recovery-key encode/decode, server-side AES wrappers, a few
 * crypto-helper modules) call `Buffer.from(...)` / `Buffer.alloc(...)`
 * directly without importing `buffer`. In Node those resolve to the
 * built-in `Buffer` global; in the browser there is no such global and
 * Vite does not auto-inject one. Result on prod: clicking "Set up
 * secure backup" surfaces `ReferenceError: Buffer is not defined`
 * inside the worker bridge.
 *
 * This module installs the standards-compatible feross/buffer
 * implementation as `globalThis.Buffer` *before* any matrix-js-sdk
 * module loads. It MUST be the first import in the worker entry —
 * importing it later (e.g. lazily inside the encryption module) is
 * too late, because matrix-js-sdk's module top-level may already have
 * captured a `Buffer` reference into a const.
 *
 * Idempotent: re-importing or a host that already provides `Buffer`
 * is a no-op.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
