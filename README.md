# Loam

**One `liblogosdelivery` (Logos) node per phone, shared by every Logos app** — instead of qaku, kym, the VPN, and each future app embedding its own in-process node.

**Loam** is the shared-node app — the soil your apps grow in: a sprout-and-mesh brand for the one node many apps root into. (The Android service namespace stays `co.logos.delivery`; only the app/product name is Loam.)

This repo is the **design doc**, the original **runnable prototype** (`demo/`, still passing), and now the **Loam service app** (`app/`, package `co.logos.delivery`) that implements it — a Kotlin foreground service + AIDL wrapping the shared `loam-transport` broker, which apps bind to over IPC.

```
node demo/demo.mjs        # proves the core thesis (broker/routing), no arm64 node needed
```

---

## Why

Every Logos app today embeds its own node. Three Logos apps on a phone = **three Logos nodes**: three meshes, three discovery loops, three copies of relaying the shared shard, three wakelocks — sharing nothing. It already bites: kym runs with peer discovery *off* so its discv5 doesn't collide with qaku's on UDP 9000.

The node code is *already* unified — qaku and kym ship a **byte-identical** `liblogosdelivery.so` + JNI + `LogosMessagingModule.kt`. The only reason there are many nodes is that each app process instantiates one.

## The decisive constraint

`liblogosdelivery` keeps **process-global** persistency state — a second `createNode` in one process fails with *"persistency already initialized,"* and destroy doesn't release it. **One process = one node.**

So sharing can't be a singleton library each app loads (that's today's duplication across app processes). The shared node must live in **its own process** — an Android foreground service — and the apps are **IPC clients**. The library makes the choice for us.

## Architecture

```
  qaku ─┐
  kym  ─┼─(AIDL/IPC)─▶  Loam service            ──▶  1 node  ──▶  Logos fleet
  vpn  ─┘                 broker + 1 node             (1 mesh, 1 discovery,
                                                        1 Core/Edge switch)
```

- **Node owner** — wraps the identical JNI; brings up exactly one node; owns the single Core/Edge choice, discovery, reconnection for the whole device.
- **Broker** — a `contentTopic → app` routing table. Each app registers its topics; inbound messages are dispatched to the owning app. Isolation is inherent: an app never receives a foreign topic, and couldn't decrypt it if it did (per-app AEAD key).
- **IPC** — a bound-service API (AIDL) gated by **per-caller user consent** ("Allow App X?"), not a signature permission. The service resolves each binding caller's `(package + signing-cert sha256)` and grants access per identity — so a repackaged/re-signed app is a new, unapproved caller, and third-party (different-key) apps can still bind *with the owner's consent*. Unapproved callers get `{authorized:false}` and no node health.
- **Client shim** — each app's `loam-transport` talks to the service when present, and **falls back to an embedded node** when it isn't, so every app still runs standalone.

> **Security / isolation** — how one app is prevented from reading, forging, or interfering with another's data (end-to-end AEAD, per-caller consent, broker routing) plus the residual risks and recommended changes: see [`SECURITY.md`](SECURITY.md).

This is the desktop host role (one component owns delivery, app cores are its clients) ported to an Android process boundary. Note: the desktop does **not** currently share a node either — each core creates its own — but it proves the enabler: **one node already multiplexes many content topics across many shards** (qaku: a channel per Q&A session; kym: per budget).

## What's in here

| Path | What it is | Status |
|------|-----------|--------|
| `app/` | **Loam — the shared node service** (package `co.logos.delivery`). Expo/RN app: runs `SharedDeliveryNode`+`RealNode` from the transport package behind a Kotlin **foreground service + AIDL** (`app/native/deliveryservice`); other apps bind as broker `Tenant`s | **Service 0.0.25 — on-device verified** (consent + multi-tenant + offline cache) |
| `app/src/lib/logos-transport-pkg` | The shared TS transport (submodule → `vpavlin/loam-transport`; on-disk dir kept as `logos-transport-pkg`): broker + `RealNode` + `ServiceNode` + JNI | **real, on-device proven** (qaku/kym ship it) |
| `src/broker.mjs` | `SharedDeliveryNode` + `Tenant` — the original broker prototype (the seam) | **real, tested** (superseded in prod by the submodule) |
| `src/shard.mjs` | `shardFor()` ported verbatim from the apps' transport | **real** (matches prod) |
| `src/mock-node.mjs` | In-memory `UnderlyingNode` for tests on any machine | **real** |
| `demo/demo.mjs` | Runnable proof of the four claims below | **real, 11/11 passing** |
| `aidl/*.aidl` | The Android IPC surface (service + callback) | **real** — shipped in `app/native/deliveryservice/aidl` |
| `client/logos-transport-client.mjs` | App-side shim: shared-if-present, else embedded | **real** — `ServiceNode` + `preferServiceBackend(true, appId)` in the transport pkg |

`UnderlyingNode` contract (what `MockNode` implements and `RealNode` wraps):

```
start() · subscribe(topic) · unsubscribe(topic) · send(topic, payload)
onReceive((topic, payload) => …)   // ONE global stream — the broker demuxes it
metrics()
```

Every one of these already exists in the FFI. The **only** thing native code lacks is receive-side demux — which is exactly what the broker adds.

## Offline cache (per app, opt-in)

Because the service keeps running while an app is closed, it can **hold that app's
messages instead of dropping them** — so the app reopens fast without re-syncing
everything. Each approved app has a **"Cache while closed"** toggle in the consent UI,
with a live **"N waiting"** count.

How it works (details in [`docs/adr/0003`](docs/adr/0003-offline-cache.md) /
[loam-transport ADR 0011](https://github.com/vpavlin/loam-transport/blob/main/docs/adr/0011-per-tenant-offline-cache.md)):

- When a caching app goes away the broker **`detach`es** its tenant — **keeps the
  subscription** (so the one node keeps receiving on its topic) and **buffers** the
  still-sealed messages into a bounded ring, instead of `close`ing (which would
  unsubscribe). A **binder-death** hook auto-detaches an app that was *killed* (it can't
  unregister itself).
- On reopen the app **drains the buffer in order**, then reconciles only the remainder
  — so "backgrounded but node alive" reopens do **no** reconciliation at all.
- The cache holds **only opaque sealed bytes**; the service never sees plaintext. RBSR
  catch-up remains the backstop for "phone was off" / ring overflow.

**Verified on-device:** the "N waiting" count climbs while an app is killed and drains on
reopen.

## Second bearer & client UI (in `loam-transport`)

Beyond pooling the one Logos node, the transport can move the **same sealed bytes** over
a **BLE offline mesh** as a second bearer — so nearby phones sync with no fleet and no
internet (loam-transport ADRs [0012](https://github.com/vpavlin/loam-transport/blob/main/docs/adr/0012-ble-mesh-bearer.md) BLE mesh bearer,
[0013](https://github.com/vpavlin/loam-transport/blob/main/docs/adr/0013-desktop-ble-relay-gateway.md) desktop relay gateway,
[0014](https://github.com/vpavlin/loam-transport/blob/main/docs/adr/0014-identity-first-ble-connections.md) identity-first connections).
The SDK also ships ready-made React components so consuming apps don't hand-roll status UI:
**`SharedNodeBanner`** (prompt to open/approve Loam), **`SharedNodeStatus`** (live
peers/mesh/approval state), and **`LoamDebug`** (diagnostics panel).

## Design decisions

See [`docs/adr/`](docs/adr/) — why it's a separate process (0001), how consent is keyed
to the caller's real identity (0002), the offline cache (0003), and **identity as a loam
service (0004)**. Transport-layer decisions live in the
[`loam-transport`](https://github.com/vpavlin/loam-transport) ADRs.

## Identity is a loam service too (ADR 0004)

Beyond pooling the node, loam also **holds your keys and signs for you** — so an app never
handles a private key. Same split as transport: **loam owns custody, the app renders the UI.**
loam knows three identity kinds — the built-in **device** key, extra named **software** keys,
and a **Keycard** — and binds each container (a calendar, a budget, a room) to one; an app calls
`signDigest(container, digest)` and stamps the returned `pub`/`sig`. The desktop implementation
ships in **[`loam-basecamp`](https://github.com/vpavlin/loam-basecamp)**'s `loam_core` **0.3.0**,
with Keycard delegated on-card to Alisher's `keycard` module at `m/43'/60'/1582'` — **the same path
the phone signs at, so one physical card is one identity across phone + desktop.** The mobile
registry converges onto the same service over time.

## What the demo proves (`node demo/demo.mjs` — 11/11)

1. **One node, two shards.** A real qaku topic hashes to shard 0 and a real kym topic to shard 7; the single node spans `{0, 7}` at once.
2. **Routing isolation.** qaku receives only qaku traffic, kym only kym.
3. **Payload isolation (defence in depth).** A foreign payload opened with the wrong app key is garbage.
4. **Refcounted teardown.** Closing one app unsubscribes only its topics; the other's survive.

## Open question to validate on hardware

The prototype proves the *routing/subscription* layer spans shards. The one thing it can't prove off-device is whether a single **Core** node forms relay meshes on shard 0 **and** shard 7 on a phone. **Edge mode dissolves this** — filter-subscribe fetches any content topic regardless of shard — which is why the on-device Edge test already underway doubles as validation for this whole design. Prove it before building the service: run Edge and watch a qaku topic and a kym topic both deliver, or run Core and confirm `/waku/2/rs/2/0` and `/waku/2/rs/2/7` mesh gauges are both non-zero.

## Migration (nothing breaks)

1. **Roll Edge** across apps — cheap N nodes now (in flight).
2. **Refactor** each app's `loam-transport` off global singletons onto this broker interface (topic→callback). A win even against a still-embedded node.
3. **Build the service** — wrap the identical JNI in a foreground service; expose the AIDL gated by **per-caller user consent** ("Allow App X?"), keyed to the binding caller's `(package + signing-cert)` — *not* a signature permission (see [`SECURITY.md`](SECURITY.md) / ADR 0002).
4. **Ship the client shim** per app (shared-if-present, else embedded). Migrate one app at a time; mixed states keep working.
5. **Converge with logos-vpn** long term, so the device runs exactly one Logos node.

## Provenance

Grounded in the actual code: qaku_core / kym_core delivery callers; mobile `logos-transport.ts` + JNI + Kotlin bridge (byte-identical across apps); the `liblogosdelivery` FFI surface; logos-vpn `internal/waku`, `DESIGN.md`, `mobile.go` (the process-global-state finding). `liblogosdelivery` itself is arm64-only, so the shared node runs on a phone or the Linux hubs — this prototype validates the broker logic that sits above it.
