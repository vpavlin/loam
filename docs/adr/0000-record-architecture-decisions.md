# 0. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-13

## Context

`logos-shared-delivery` (the `co.logos.delivery` service) has a handful of
load-bearing, non-obvious decisions — why it's a separate *process*, how it decides
which apps may use it, and how it caches for apps that aren't running. The prose
lives in [`../../README.md`](../../README.md), [`SECURITY.md`](../../SECURITY.md) and
[`SERVICE-PLAN.md`](../../SERVICE-PLAN.md); these ADRs pin the *decisions* so a future
change can't quietly undo one.

The **transport mechanics** (broker seam, SDS channels, framing, Core/Edge, the
offline-cache *implementation*) are decided in the sibling library and recorded in
[`logos-transport`](https://github.com/vpavlin/logos-transport)'s `docs/adr/` — this
repo's ADRs cover only what is specific to the **service** that wraps it.

## The log

- [0001](0001-shared-node-in-its-own-process.md) — The shared node must live in its own process (service + AIDL)
- [0002](0002-consent-from-binder-identity.md) — Consent is per app, keyed by the caller's real identity
- [0003](0003-offline-cache.md) — Offline cache: hold a closed app's messages, opt-in per app
