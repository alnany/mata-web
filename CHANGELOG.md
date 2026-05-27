# Changelog

All notable changes to Mata are recorded here. Format inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Phase 1

### Added
- Real matrix-js-sdk integration in `workers/matrix/src/sdk.ts`. The worker now owns the entire SDK lifecycle behind the `@mata/shared` RPC contract.
- Rust crypto backend via `@matrix-org/matrix-sdk-crypto-wasm`, initialized with IndexedDB-backed key storage (per ADR-003).
- Session persistence in `workers/matrix/src/session-store.ts` (IndexedDB, worker-only).
- Login flow:
  - `apps/web/src/routes/login.tsx` — homeserver + username + password form, browser-native validation, typed error rendering.
  - Worker handler in `bridge.ts` translates `login` RPC to `MatrixCore.login()`.
- Room list:
  - `apps/web/src/routes/home.tsx` — paneled layout, virtualized-ready row component (`content-visibility: auto`), live updates on `syncUpdate` / `syncStatus` events.
- Session-aware routing in `apps/web/src/App.tsx`: restore on boot, redirect anonymous users to `/login`, authenticated users away from it.
- ADR-001 (worker boundary), ADR-002 (SDK choice), ADR-003 (session storage).
- Playwright smoke test for the login screen.

### Changed
- `workers/matrix/src/bridge.ts` now dispatches against a single `MatrixCore` instance. Non-Phase-1 RPCs still throw typed `protocol` errors for clean dev failures.
- `App.tsx` boots the worker, restores the session, then routes.

### Notes
- Phase 1 gate (per `docs/plan/02-eng-review.md`): "log in to a homeserver from worker + see room list, CI green." The code path is wired end-to-end; in-repo verification requires running `pnpm dev` against a real homeserver (matrix.org or self-hosted) — that smoke test is left as the first task after pulling.
- Sliding sync detection lands in Phase 2 along with timeline rendering, send pipeline, and reaction/edit/redaction RPCs.

## [0.0.0] — Phase 0 (scaffold)

### Added
- pnpm monorepo: `apps/web`, `workers/matrix`, `packages/shared`.
- Typed RPC contract (`packages/shared/src/rpc-contract.ts`) with compile-time 1:1 request/response guarantee.
- Worker bridge dispatcher with 21 RPC stubs.
- Solid + Vite 6 + Tailwind v4 app shell with COEP/COOP headers for SharedArrayBuffer.
- TypeScript strict, Biome, lefthook, commitlint, GitHub Actions CI, Playwright + Vitest configs.
- Apache-2.0 license, README, .nvmrc, .gitignore.
