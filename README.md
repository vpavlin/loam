# logos-shared-delivery

**One `liblogosdelivery` (Waku) node per phone, shared by every Logos app** — instead of qaku, kym, the VPN, and each future app embedding its own in-process node.

This repo is both the **design doc** and a **runnable prototype** of the sharing layer.

```
node demo/demo.mjs        # proves the core thesis, no arm64 node needed
```

---

## Why

Every Logos app today embeds its own node. Three Logos apps on a phone = **three Waku nodes**: three meshes, three discovery loops, three copies of relaying the shared shard, three wakelocks — sharing nothing. It already bites: kym runs with peer discovery *off* so its discv5 doesn't collide with qaku's on UDP 9000.

The node code is *already* unified — qaku and kym ship a **byte-identical** `liblogosdelivery.so` + JNI + `LogosMessagingModule.kt`. The only reason there are many nodes is that each app process instantiates one.

## The decisive constraint

`liblogosdelivery` keeps **process-global** persistency state — a second `createNode` in one process fails with *"persistency already initialized,"* and destroy doesn't release it. **One process = one node.**

So sharing can't be a singleton library each app loads (that's today's duplication across app processes). The shared node must live in **its own process** — an Android foreground service — and the apps are **IPC clients**. The library makes the choice for us.

## Architecture

```
  qaku ─┐
  kym  ─┼─(AIDL/IPC)─▶  Logos Delivery service  ──▶  1 node  ──▶  Logos fleet
  vpn  ─┘                 broker + 1 node             (1 mesh, 1 discovery,
                                                        1 Core/Edge switch)
```

- **Node owner** — wraps the identical JNI; brings up exactly one node; owns the single Core/Edge choice, discovery, reconnection for the whole device.
- **Broker** — a `contentTopic → app` routing table. Each app registers its topics; inbound messages are dispatched to the owning app. Isolation is inherent: an app never receives a foreign topic, and couldn't decrypt it if it did (per-app AEAD key).
- **IPC** — a bound-service API (AIDL) gated by a **signature permission**, so only trusted Logos apps may bind.
- **Client shim** — each app's `logos-transport` talks to the service when present, and **falls back to an embedded node** when it isn't, so every app still runs standalone.

This is the desktop host role (one component owns delivery, app cores are its clients) ported to an Android process boundary. Note: the desktop does **not** currently share a node either — each core creates its own — but it proves the enabler: **one node already multiplexes many content topics across many shards** (qaku: a channel per Q&A session; kym: per budget).

## What's in here

| Path | What it is | Status |
|------|-----------|--------|
| `src/broker.mjs` | `SharedDeliveryNode` + `Tenant` — the multi-tenant broker (the seam) | **real, tested** |
| `src/shard.mjs` | `shardFor()` ported verbatim from the apps' transport | **real** (matches prod) |
| `src/mock-node.mjs` | In-memory `UnderlyingNode` for tests on any machine | **real** |
| `demo/demo.mjs` | Runnable proof of the four claims below | **real, passing** |
| `src/real-node.mjs` | Adapter mapping the broker onto the arm64 JNI bridge | **sketch** (phone) |
| `aidl/*.aidl` | The Android IPC surface (service + callback) | **sketch** |
| `client/logos-transport-client.mjs` | App-side shim: shared-if-present, else embedded | **sketch** |

`UnderlyingNode` contract (what `MockNode` implements and `RealNode` wraps):

```
start() · subscribe(topic) · unsubscribe(topic) · send(topic, payload)
onReceive((topic, payload) => …)   // ONE global stream — the broker demuxes it
metrics()
```

Every one of these already exists in the FFI. The **only** thing native code lacks is receive-side demux — which is exactly what the broker adds.

## What the demo proves (`node demo/demo.mjs` — 11/11)

1. **One node, two shards.** A real qaku topic hashes to shard 0 and a real kym topic to shard 7; the single node spans `{0, 7}` at once.
2. **Routing isolation.** qaku receives only qaku traffic, kym only kym.
3. **Payload isolation (defence in depth).** A foreign payload opened with the wrong app key is garbage.
4. **Refcounted teardown.** Closing one app unsubscribes only its topics; the other's survive.

## Open question to validate on hardware

The prototype proves the *routing/subscription* layer spans shards. The one thing it can't prove off-device is whether a single **Core** node forms relay meshes on shard 0 **and** shard 7 on a phone. **Edge mode dissolves this** — filter-subscribe fetches any content topic regardless of shard — which is why the on-device Edge test already underway doubles as validation for this whole design. Prove it before building the service: run Edge and watch a qaku topic and a kym topic both deliver, or run Core and confirm `/waku/2/rs/2/0` and `/waku/2/rs/2/7` mesh gauges are both non-zero.

## Migration (nothing breaks)

1. **Roll Edge** across apps — cheap N nodes now (in flight).
2. **Refactor** each app's `logos-transport` off global singletons onto this broker interface (topic→callback). A win even against a still-embedded node.
3. **Build the service** — wrap the identical JNI in a foreground service; expose the AIDL with a signature-permission gate.
4. **Ship the client shim** per app (shared-if-present, else embedded). Migrate one app at a time; mixed states keep working.
5. **Converge with logos-vpn** long term, so the device runs exactly one Logos node.

## Provenance

Grounded in the actual code: qaku_core / kym_core delivery callers; mobile `logos-transport.ts` + JNI + Kotlin bridge (byte-identical across apps); the `liblogosdelivery` FFI surface; logos-vpn `internal/waku`, `DESIGN.md`, `mobile.go` (the process-global-state finding). `liblogosdelivery` itself is arm64-only, so the shared node runs on a phone or the Linux hubs — this prototype validates the broker logic that sits above it.
