# ADR-002: matrix-js-sdk + matrix-sdk-crypto-wasm (Element model)

**Status:** Accepted
**Date:** 2026-05-27

## Context

The CEO review locked in "matrix-rust-sdk via WASM in a Web Worker" as the SDK choice because of native-speed crypto, no-GC-jank, and alignment with Element X. The engineering review needs to translate that intent into a shippable package list — and the matrix-rust-sdk JavaScript story is more nuanced than "use it."

State of the ecosystem (May 2026):

- **`matrix-js-sdk`** — battle-tested, what Element Web ships, broad feature coverage (sync, rooms, media, push, search, threads, edits, redactions, spaces). Pure JS, but the crypto path delegates to a WASM module by default.
- **`@matrix-org/matrix-sdk-crypto-wasm`** — Rust-implemented Olm/Megolm/cross-signing/SSSS compiled to WASM, with a JS shim. This is the same code Element X mobile clients use. matrix-js-sdk loads it via its Rust crypto backend (`OlmMachine`).
- **`matrix-rust-sdk` end-to-end WASM binding** — the longer-term "everything in Rust" path. Exists as `@matrix-org/matrix-sdk-wasm` but is still rough around the edges for the full sliding-sync + push + media flow we need. Element Web has not yet migrated.

The CEO promise of "native-speed crypto" is satisfied by `matrix-sdk-crypto-wasm`. The CEO promise of "no GC jank" is satisfied by **putting the SDK in a worker** (ADR-001), not by language choice — JS heap pressure in a worker doesn't pause the main thread.

## Decision

For Phase 1 we ship with:

- **`matrix-js-sdk`** as the protocol surface (sync, rooms, send, media, push, search).
- **`@matrix-org/matrix-sdk-crypto-wasm`** as the crypto backend, wired via `matrix-js-sdk`'s Rust crypto enablement (`initRustCrypto({ storageKey, useIndexedDB: true })`).
- The entire stack runs inside `workers/matrix`. The main thread never sees it.

The worker exposes only the contract in `packages/shared/src/rpc-contract.ts`. Internally it owns the SDK lifecycle, sync loop, and IndexedDB stores.

## Consequences

**Good:**
- We ship a known-working stack on day 1. Element runs this same combination in production at scale.
- Crypto is Rust/WASM as promised. The non-crypto JS surface is small and only ever runs in the worker thread.
- All upstream bug fixes for Matrix-spec edge cases come for free.
- Migration path to full Rust SDK (when it stabilizes) is a worker-internal swap — see ADR-001's boundary discipline.

**Bad:**
- We carry the JS SDK's API design, which is event-emitter-heavy. We isolate this in `workers/matrix/src/sdk.ts` and never let it leak past the RPC contract.
- The JS SDK ships ~250KB minified inside the worker bundle. Worker bundle size doesn't count against the main-thread budget but does affect first-load time. We accept this; future migration to full Rust SDK reclaims it.

## Alternatives considered

- **Pure `matrix-rust-sdk` WASM binding (Element X model).** Closer to the original "rust-sdk in a worker" wording, but the JS binding is not yet feature-complete for our v1 scope (push gateways and media flows lag). We revisit when upstream marks it stable for web.
- **Hydrogen SDK** (formerly Hydrogen Web). Minimal and very fast, but its scope is narrower than our v1 (e.g. spaces and threads are not first-class) and the project's maintenance velocity has slowed. Rejected.
- **Build our own thin Matrix client.** A multi-month detour with no perf upside once the SDK is in a worker. Rejected.

## Implementation notes

- The SDK is constructed in `workers/matrix/src/sdk.ts`. Nothing else in the worker constructs SDK objects directly.
- Crypto storage uses IndexedDB with a per-user pickle key derived from the session passphrase (Phase 1: derived from password; Phase 2: from passkey/biometric).
- We disable the SDK's `console.log` chatter via its built-in logger and pipe structured logs to a worker-side ring buffer that the main thread can drain on demand.
