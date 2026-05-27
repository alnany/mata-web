# Mata

> Element's security, Telegram's silk, your server.

Mata is a Matrix-protocol chat client that pairs Element's full E2EE feature set with the responsiveness of Telegram Web. Bring your own homeserver — Mata is the client, never the host.

## Status

Phase 0 (scaffold). Not yet usable.

## Stack

- **Language**: TypeScript 5.6 strict
- **UI**: Solid.js + Tailwind v4
- **Build**: Vite 6
- **Matrix SDK**: [matrix-rust-sdk](https://github.com/matrix-org/matrix-rust-sdk) compiled to WASM, executed in a dedicated Web Worker
- **Storage**: IndexedDB (worker only)
- **Lint/Format**: Biome
- **Tests**: Vitest (unit) + Playwright (E2E)
- **CI**: GitHub Actions
- **Deploy**: Vercel

## Architecture

The main thread does **rendering only**. All Matrix protocol work — sync, crypto, network, persistence — runs in a dedicated Web Worker behind a typed RPC contract (`packages/shared/src/rpc-contract.ts`). This is the architectural commitment that makes "silky" achievable.

See [`docs/plan/`](docs/plan/) for the full strategy + engineering review, and [`docs/adr/`](docs/adr/) for individual decisions.

## Repo layout

```
mata/
├── apps/web/             # Solid SPA (main thread)
├── workers/matrix/       # Web Worker hosting matrix-rust-sdk
├── packages/
│   ├── shared/           # RPC contract + shared types
│   ├── ui/               # Reusable Solid components
│   └── config/           # Shared TS / Biome configs
├── docs/
│   ├── adr/              # Architecture Decision Records
│   ├── plan/             # Strategy + eng review
│   └── research/         # Background investigation
└── .github/workflows/    # CI
```

## Getting started

```sh
nvm use                  # node 20.11
corepack enable          # pnpm 9.12
pnpm install
pnpm prepare             # install git hooks
pnpm dev                 # http://localhost:5173
```

### Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the web app in dev mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run unit tests across the workspace |
| `pnpm test:e2e` | Run Playwright E2E suite |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome auto-fix |
| `pnpm ci` | Full CI pipeline locally (typecheck + lint + test + build) |

## Engineering standards

These are non-negotiable from commit 1. See [`docs/plan/02-eng-review.md`](docs/plan/02-eng-review.md) §14 for the full list.

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- No `any` without a justification comment
- Conventional commits enforced via commitlint
- All async paths have explicit error handling
- Performance budgets enforced in CI (bundle size + Lighthouse)
- ADRs in `docs/adr/` for every architecturally significant decision

## License

Apache-2.0
