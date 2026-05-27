# ADR-003: Sessions in IndexedDB inside the worker

**Status:** Accepted
**Date:** 2026-05-27

## Context

After login we have a Matrix access token, refresh token, device id, user id, homeserver URL, and the Rust crypto store's pickle. All of these need to survive a page reload and a worker restart. None of them should ever touch the main-thread `localStorage` (synchronous + globally readable + smaller quota + replicated by some browser sync features).

## Decision

All persistent state lives in IndexedDB, owned by the worker. The main thread never reads or writes Matrix-related storage. We use two IDB databases:

1. **`mata/session`** — small DB, one record per logged-in account: `{ userId, deviceId, accessToken, refreshToken, homeserverBaseUrl, pickleKeyRef, createdAt, lastSeenAt }`.
2. **`mata/crypto`** — owned exclusively by matrix-sdk-crypto-wasm. We pass the database name; the SDK manages schema.

A third DB, **`mata/cache`**, will be added in Phase 2 for room timeline / media cache.

The session pickle key is derived from a per-account secret stored under `crypto.subtle`-wrapped form inside the session DB; the unwrap key is derived from the user's password using PBKDF2 + a per-account salt and lives only in worker memory for the session's lifetime.

## Consequences

**Good:**
- Storage operations never block the main thread.
- A compromised renderer (XSS via misbehaving Tailwind CDN, malicious extension content script) cannot exfiltrate tokens or crypto material from `localStorage` or `sessionStorage` — there is nothing there.
- Crypto store and session store are separated so we can wipe crypto independently when verification is reset.

**Bad:**
- IndexedDB has corner cases (Safari ITP eviction after 7 days of inactivity, private-mode quotas). We surface a clear `storage` error category through `SerializedError` and reauthenticate the user on quota loss.
- The pickle-key wrapping adds startup latency (one PBKDF2 derivation, ~50–200ms on slow devices). Acceptable; happens once per session.

## Alternatives considered

- **`localStorage` (Element Web's original approach).** Synchronous, blocks paint on read, accessible to any script in the renderer, smaller quota. Rejected.
- **Single IndexedDB database with multiple object stores.** Simpler, but couples session lifecycle to crypto lifecycle — wiping crypto would mean a migration to preserve the session record. Rejected.
- **No persistence; re-login every reload.** Hostile UX. Rejected.
