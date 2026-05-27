# ADR-001: Main thread renders, worker does Matrix

**Status:** Accepted
**Date:** 2026-05-27

## Context

The headline product promise is "silky" — Telegram-Web-A-grade responsiveness on chat switches, scrolls, and media. The dominant source of jank in JS chat clients is:

1. **Crypto on the main thread.** Olm/Megolm decryption, key signature checks, session derivation — every message in an E2EE room. JS implementations stall the main thread in 5–50ms bursts.
2. **Sync parsing on the main thread.** `/sync` responses for active accounts can be hundreds of KB of JSON containing thousands of events.
3. **IndexedDB churn on the main thread.** Persisting events, room state, and crypto keys causes layout-blocking IDB transactions.
4. **GC pauses.** Allocating thousands of event objects every sync round triggers JS GC pauses (16–50ms) that drop frames.

Element Web fights all four problems. We can sidestep them by structure.

## Decision

**The main thread does rendering only.** All Matrix-protocol work — SDK calls, sync, crypto, network I/O, persistence — runs in a dedicated `Worker`. The UI thread communicates with the worker exclusively through a typed RPC contract in `packages/shared/src/rpc-contract.ts`.

Rules:

- `apps/web` MUST NOT import `matrix-js-sdk`, `@matrix-org/matrix-sdk-crypto-wasm`, or any Matrix protocol code. Enforced by ESLint-equivalent rules in Biome (or a custom check if Biome can't express it).
- `workers/matrix` MUST NOT import Solid, the DOM, or any rendering library.
- The boundary is `@mata/shared`. Both sides depend on it; it depends on nothing.
- Every request has a typed response. Every push from worker → main is a typed `WorkerEvent`. The contract is the source of truth — a vitest in `@mata/shared` fails the build if request and response kinds drift apart.
- Errors cross the boundary as `SerializedError` (plain objects), reconstructed with `MataError.from()`. Error subclass identity does not survive `postMessage`.

## Consequences

**Good:**
- Main thread frame budget is reserved for paint + composition. Scroll and click jank become bugs we can fix locally, not architectural penalties.
- The worker can be killed and restarted on crash without losing the UI's state. The bridge re-resolves pending requests as `aborted` errors.
- The contract is small enough to fit on one screen. New features land as new RPC variants — type errors block any UI that forgets to handle them.
- Swapping the SDK later (e.g., to a pure `matrix-rust-sdk` WASM binding once mature — see ADR-002) is a worker-internal change, invisible to the UI.

**Bad:**
- Every message-related operation crosses a serialization boundary. We pay structured-clone cost on every send and every sync delta. We mitigate with batched `syncUpdate` events (one envelope per sync round, not one per event) and `Transferable` ArrayBuffers for media.
- Debugging is harder. Stack traces stop at the boundary. We log structured events on both sides with correlated `rpc.id`.
- The worker has a slow startup (~100–300ms). The UI shows a `BootScreen` until `ping` resolves; we ping first to avoid racing the worker's `message` listener attachment.

## Alternatives considered

- **No worker, everything on main thread.** Element Web's original model. Rejected — measurably janky on 10k-message rooms, irreconcilable with the perf targets.
- **`SharedWorker` so multiple tabs share one Matrix client.** Tempting (one sync, less battery), but `SharedWorker` is not supported on iOS Safari and has thorny lifecycle issues across tab refresh / private windows. We keep it as a future ADR if multi-tab is requested.
- **OffscreenCanvas + rendering inside the worker.** Overkill for a chat client; the wins are in compositor-bound workloads, not DOM-bound ones.
