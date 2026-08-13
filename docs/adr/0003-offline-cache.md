# 3. Offline cache: hold a closed app's messages, opt-in per app

- **Status:** accepted
- **Date:** 2026-08-13
- **Implements:** [logos-transport ADR 0011](https://github.com/vpavlin/logos-transport/blob/main/docs/adr/0011-per-tenant-offline-cache.md)

## Context

The service keeps running while an individual app is backgrounded or killed, and it is
still subscribed to that app's topics on its behalf. Historically it **dropped** that
traffic, so the app did a full catch-up (RBSR reconciliation) on every reopen. But the
node already *had* the messages — for the common "app closed a few minutes, node stayed
up" case, that re-sync is pure waste.

## Decision

Give each approved app an **opt-in, bounded offline cache**, surfaced as a **"Cache while
closed"** toggle per app in the consent UI. When a caching app's client goes away, the
broker **`detach`es** the tenant instead of `close`ing it: it **keeps the subscription**
and **buffers** incoming (still-sealed) messages into a bounded ring. On reopen it
**`reattach`es** — drains the buffer in order through the app, then reconciles only the
remainder (`dropped > 0` ⇒ the ring overflowed, so catch-up still runs).

Two service-specific pieces make it actually work:

- **`detach`, never `close`.** `close` unsubscribes the topic; `detach` leaves it in the
  broker's ownership table, so the one node keeps receiving on a closed app's topic. This
  distinction *is* the feature.
- **Binder-death auto-unregister.** A swiped-away app can't call `unregisterClient` itself,
  so the service `linkToDeath`s the client's callback binder: when the app's process dies,
  the service auto-unregisters it → the tenant detaches → the cache begins to fill. Without
  this, a killed app stayed "attached" to a dead callback and nothing buffered.

The cache holds **only opaque sealed bytes** (ADR 0002) — the boundary is intact; a
"cache off" toggle or a `revoke` fully closes and clears it.

## Rejected

- **Cache for everyone, always** — unbounded memory, caches for apps that never return;
  the per-app opt-in + ring bound are load-bearing.
- **Rely on Waku Store** — not exposed on desktop, unreliable on mobile; a local cache is
  faster and always available while the node runs.
- **Decrypt/fold in the service** — breaks the blind-pipe boundary; the app folds.

## Consequences

- "Backgrounded but node alive" reopens are **drain-and-go, no reconciliation**; RBSR
  catch-up remains the backstop for node-was-down / overflow.
- In-memory today (survives app close, not a service restart); disk-persisting the ring
  is a clean follow-up. The "N waiting" counter in the UI shows it working.
