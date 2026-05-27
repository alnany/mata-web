# Mata — Deploy

The Vercel project `mata-web` (team `chris-projects-65ad77d7`) is already
created. There are two equally valid ways to ship a new build to it; both
produce the same artifact at <https://mata-web-chris-projects-65ad77d7.vercel.app>.

The build pipeline (`vercel.json` + `scripts/prepare-build.mjs`) is
self-contained: install → stub crypto-wasm → build. Vercel will run it
unmodified; running it locally produces an identical bundle.

## Path A — Vercel CLI from your laptop (fastest, ~60 s)

```sh
tar -xzf mata-phase2-deployable.tar.gz
cd mata
pnpm install --frozen-lockfile     # 6–10 s
node scripts/prepare-build.mjs      # < 1 s
pnpm -r --filter=@mata/web build    # ~20 s
cd apps/web
vercel deploy --prod                # whatever account is already linked to mata-web
```

## Path B — Push to GitHub, let Vercel rebuild

```sh
tar -xzf mata-phase2-deployable.tar.gz
cd mata
git init && git add . && git commit -m "phase 2"
git remote add origin git@github.com:Cagetest/mata-web.git    # create the repo first
git push -u origin main
```

Then in the Vercel dashboard, connect the project `mata-web` to that
repository (Project Settings → Git). Every push to `main` auto-deploys.

## What this build contains

- **Real `matrix-js-sdk@34.11.1` core** wired through `workers/matrix/src/sdk-impl.ts`.
  Login, sync, room list, timeline pagination, send/edit/redact, reactions,
  typing, receipts, media upload — all live, all typed.
- **Rust crypto stubbed at build time.** `MATA_ENABLE_E2EE=false` (the
  default) removes the ~9 MB WASM chunk from the bundle. The build prep
  script regenerates the stub from any clean `node_modules`, so a fresh
  `pnpm install` followed by `node scripts/prepare-build.mjs` is always
  reproducible.
- **Bundle**: ~1.2 MB total, ~250 KB gzipped. Main thread bundle is 11 KB
  — all SDK weight lives behind the worker boundary.

## Re-enabling E2EE later

```sh
MATA_ENABLE_E2EE=true pnpm -r --filter=@mata/web build
```

Skips the stubbing step and ships the real rust-crypto adapter +
`@matrix-org/matrix-sdk-crypto-wasm`. Adds the 9 MB WASM chunk back; the
chunk is loaded lazily at the moment `initRustCrypto()` is called, so
cold start is unaffected for non-encrypted rooms.
