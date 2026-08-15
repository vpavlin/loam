# Loam — the shared delivery node service (build plan)

> **Historical plan — now partly superseded.** This is the original build plan for the
> service (app namespace `co.logos.delivery`, product now **Loam**). Some of it shipped
> differently than written: the *"signature-permission gate"* increment below actually
> shipped as **per-caller user consent** (keyed to the caller's `(package + signing-cert)`),
> and the AIDL surface differs from the sketch here. For the shipped behavior see the ADRs
> and [`SECURITY.md`](SECURITY.md).

**Confirmed architecture (2026-08-09):** the service **reuses the shared TS transport**
(`vpavlin/loam-transport`). It is an Expo/RN app that runs `SharedDeliveryNode` + `RealNode`
from the package (one embedded node) and wraps them in a **Kotlin foreground service + AIDL**,
so other apps bind over IPC and each becomes a real `Tenant` in the broker. One transport
implementation, no Kotlin re-port, no parity problem — this is the payoff of the broker seam.

Only genuinely new native code: the **AIDL ↔ JS bridge** (binder calls → the JS broker;
JS receives → AIDL callbacks). Everything else is the proven package.

## Reality of testing
`liblogosdelivery` is **arm64-only** — the service *runs only on a phone*, never on an x86
dev box — and it only fully proves out with a **second app binding to it**. So this is
necessarily **build → test on-device → iterate**, not a single drop.

## Increments (each testable on the phone)
1. **Standalone node app** — Expo app, submodule `loam-transport`, bring up ONE node via
   the shared transport, keep it alive in a **foreground service** (persistent notification).
   *Test: connects and survives backgrounding.*
2. **AIDL surface** (`ILogosDelivery` + `ILogosDeliveryCallback`) + the binder↔JS bridge +
   a tiny built-in test client. *Test: subscribe/send/receive across the binder in-process.*
3. **Admission gate** + external binding. *Test: a second app binds and syncs.*
   *(Shipped as per-caller user consent, not a signature permission — see SECURITY.md / ADR 0002.)*
4. **qaku as first real client** — add a `ServiceNode` (AIDL-backed `UnderlyingNode`) beside
   `RealNode`; if the service is installed, qaku routes through it, else embeds (today's
   behaviour). *Test: qaku syncs via the service.*
5. **Release.**

## Validation sequence (agreed)
1. Get **qaku** working through the service (increment 4).
2. **Update KYM** to be the second client — this is the real test: **two apps, one node,
   two shards** (qaku shard 0 + kym shard 7 on a single node). This is where the multi-tenant
   / multi-shard thesis is finally proven on hardware.
3. Then **other apps** (scala, lope, …) bind the same way.

## The AIDL ↔ JS bridge (the one hard part)
- External app → `ILogosDelivery.{registerClient,subscribe,channelSend,storeQuery,close}`
  on the service's binder (Kotlin, binder threads).
- Kotlin marshals each call onto the RN JS thread → drives the broker:
  `broker.registerTenant(appId)` / `tenant.subscribe(topic)` / `tenant.send(topic, bytes)`.
- The tenant's `onMessage(topic, bytes)` → a native module call → Kotlin invokes that
  appId's `ILogosDeliveryCallback.onMessage` (oneway).
- appId ↔ Tenant is 1:1; the broker already isolates by content topic, and per-app AEAD keys
  mean a mis-route is unreadable anyway.

## Client split (increment 4)
The service moves **opaque bytes** only — no crypto. Per-app `open()`/`payloadCandidates`/
counters stay in the client's transport. `ServiceNode` (AIDL-backed) is a thinner sibling of
`RealNode`: same `UnderlyingNode` interface, but subscribe/send/receive cross the binder
instead of the JNI. Swapping `RealNode → ServiceNode` is the only change in the app — the
whole reason the seam exists.
