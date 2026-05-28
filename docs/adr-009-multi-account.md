# ADR-009 — Multi-account support

## Decision

Mata web supports multiple Matrix accounts in a single browser tab. UX
patterned after Element X / FluffyChat / SchildiChat — workspace rail
on the left shows one tile per signed-in account, "+" tile opens a
login modal in "add account" mode.

## Staging

### Stage A — switchable identity (this commit)

- One MatrixClient instance lives at a time. Switching account is
  `core.stop() → boot stored credentials for picked userId → resume`.
- Session registry already lives in `mata/session` IDB (keyed by
  `userId`); we just stop hardcoding "active = most recent" and let
  the UI pick.
- Crypto-store constraint: matrix-js-sdk 34.x hardcodes
  `storePrefix: RUST_SDK_STORE_PREFIX`, so two clients in the same
  origin can't both hold open crypto stores. Stage A sidesteps the
  conflict by stopping one before booting the next. Stage B bypasses
  `client.initRustCrypto` and calls `RustCrypto.initRustCrypto` from
  `matrix-js-sdk/lib/rust-crypto` directly with a per-session
  `storePrefix: 'mata-crypto-${userId}'`, enabling parallel clients.
- UX limitation accepted for v1: background accounts don't receive
  realtime sync; switching does a fresh `/sync` boot. Element classic
  shipped this for years; users tolerate it. Stage B lifts it.

### Stage B — parallel background sync

- Worker holds `Map<userId, MatrixClient>`; each client uses a
  unique crypto store prefix.
- Bridge envelope tags every request/event with `userId`; routing
  inside the worker dispatches to the right client.
- UI subscribes to events for `activeUserId` only; background events
  bump rail-tile unread counts.

### Stage C — polish

- Per-session display name + avatar surfaced on rail tiles.
- Per-session sign-out (right-click → menu).
- Tab badge sums unread across accounts.
- Per-session push-rule + notification routing.
- Key backup gated per session (each account has its own SSSS).

## Data shape

```ts
// packages/shared/src/rpc-contract.ts
export interface SessionSummary {
  userId: UserId;
  deviceId: DeviceId;
  homeserverBaseUrl: string;
  displayName: string | null;
  avatarUrl: MxcUri | null;
  lastSeenAt: number;
}
```

`SessionRecord` in `workers/matrix/src/session-store.ts` gains
`displayName?: string | null` and `avatarUrl?: MxcUri | null` columns,
written whenever the active client's profile loads.

## New RPCs

- `listSessions() → { sessions: SessionSummary[] }`
- `switchSession({ userId }) → { activeUserId, deviceId }` — stops
  current, boots stored credentials for picked userId.
- `signOutSession({ userId })` — clears the stored record; if the
  signed-out session was active, behaves like `logout`.
- Existing `restoreSession` continues to return the most-recently-used
  record. Existing `login` continues to insert/update a record; the
  UI treats successful login as "add or refresh the picked account
  and make it active".

## UI surfaces

- `apps/web/src/components/workspace-rail.tsx` — owns the left rail.
  Tile per session, "+" tile at bottom, active highlight, click →
  `setActiveSession(userId)`.
- `apps/web/src/routes/login.tsx` — accepts `?mode=add` query param
  to render "Add account" header instead of "Sign in".
- `apps/web/src/stores/sessions.ts` (new) — holds session list +
  active pointer; subscribes to worker events.

## Storage layout (no migration needed)

- `mata/session` (IDB) — already multi-record, keyed by `userId`.
- `matrix-js-sdk:*` (crypto store) — Stage A: single store, swapped
  on session switch. Stage B: per-account prefix.
- `mata-cache` (room-list snapshot) — Stage A: single namespace,
  cleared on switch. Stage B: keyed by `userId`.
