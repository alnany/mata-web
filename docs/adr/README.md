# Architecture Decision Records

Each ADR captures one architecturally significant decision: the context, the choice, the consequences. Once accepted, ADRs are immutable — supersede with a new ADR rather than editing.

| # | Title | Status |
|---|---|---|
| [001](./ADR-001-worker-boundary.md) | Main thread renders, worker does Matrix | Accepted |
| [002](./ADR-002-sdk-choice.md) | matrix-js-sdk + matrix-sdk-crypto-wasm (Element model) | Accepted |
| [003](./ADR-003-session-storage.md) | Sessions in IndexedDB inside the worker | Accepted |

## Template

```md
# ADR-NNN: Title

**Status:** Proposed | Accepted | Superseded by ADR-XXX
**Date:** YYYY-MM-DD

## Context
What's the problem and forces at play.

## Decision
What we chose.

## Consequences
Good and bad. Be honest about the bad.

## Alternatives considered
What we didn't pick and why.
```
