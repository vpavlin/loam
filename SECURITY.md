# Security model — logos-shared-delivery

How the device-wide shared Waku node (`co.logos.delivery`) keeps one app from
reading, forging, or interfering with another app's data — and the residual risks
worth an explicit decision.

## TL;DR

**The shared node is untrusted infrastructure; confidentiality is end-to-end at the
app layer, above the node.** Every app seals its payload (AEAD) inside its own
process before handing bytes to the service, so the service, the broker, and any
co-resident app only ever see **ciphertext + a content topic** — keys and plaintext
never cross the IPC boundary. Pooling one node therefore gives the **same
content-confidentiality guarantee as N separate nodes** (Waku is a public network —
content security was never the transport's job), plus an admission gate (per-caller
consent) and routing isolation (the broker demuxes by content topic).

The one genuinely new surface sharing introduces is *local*: a **consented** app
could actively subscribe to another app's topics and harvest **ciphertext +
metadata** (never plaintext). Closing that is the main open decision (§5).

## 1. Trust boundaries & actors

```
  ┌ App A (tenant) ┐   ┌ App B (tenant) ┐          seal/open + keys live HERE,
  │ seal/open      │   │ seal/open      │          never cross the line below
  │ keys, plaintext│   │ keys, plaintext│
  └───────┬────────┘   └───────┬────────┘
          │ AIDL: (appId, topic, byte[] sealed)     ◄── only opaque bytes cross IPC
  ┌───────▼───────────────────▼────────┐
  │  co.logos.delivery  (its own proc)  │  consent gate ─ (package+cert) identity
  │  broker: contentTopic → {tenants}   │  routing demux ─ foreign topics dropped
  │  one liblogosdelivery node          │  sees only ciphertext + topics
  └───────────────┬─────────────────────┘
                  │  public Waku wire (ciphertext + metadata, visible to anyone)
          ┌───────▼────────┐
          │  Logos fleet    │
          └─────────────────┘
```

Actors we defend against: a **malicious co-resident app**, a **consented-but-nosy
app**, the **service/node operator** (defence in depth), and a **network/fleet
observer**.

## 2. The core guarantee — the node is a blind pipe

The AIDL surface (`app/native/deliveryservice/aidl/…/ILogosDelivery.aidl`) carries
only:

```
void   registerClient(String appId, ILogosDeliveryCallback cb)
void   subscribe(String appId, String topic)
void   send(String appId, String topic, in byte[] sealed)   // note: "sealed"
void   unregisterClient(String appId)
String metrics()                                            // node health JSON only
```

There is **no parameter that carries a key or plaintext.** The `byte[]` is already
AEAD-sealed by the app; the transport is crypto-agnostic (each core owns its
keys/envelope). This makes "the node reads app data" **structurally impossible**,
not merely "doesn't currently." *Keep it that way — never add a plaintext/key
parameter to the AIDL.*

## 3. Defense layers

1. **Content confidentiality (the hard boundary).** Per-app AEAD (e.g. AES-256-GCM
   / ChaCha20-Poly1305) with a key derived in-app from a pre-shared secret (pairing
   QR / invite). Even a foreign message delivered by mistake is garbage without the
   key (proven by `demo/demo.mjs` claim #3). Keys never leave the app process.
2. **Admission control (who may bind).** `LogosDeliveryService` resolves the calling
   **package + signing-cert sha256 from the binder UID** (the OS supplies the UID —
   a caller cannot spoof it) and keys both the broker tenant and the consent grant by
   `(package|cert)`. The owner approves each app once ("Allow App X?"); a
   repackaged/re-signed app is a **new, unapproved** caller. Unapproved callers get
   `{authorized:false}` and no node health. (This replaced an earlier
   signature-permission gate, so third-party different-key apps can bind *with the
   owner's consent*.)
3. **Routing isolation (what you passively receive).** The broker keeps
   `owners: contentTopic → {tenantId}` and `_route` dispatches an inbound message
   only to tenants that registered that topic; an unowned/foreign topic is
   **dropped** (`demo` claim #2: qaku receives only qaku traffic). An app never
   *passively* sees another app's messages.

## 4. Threat table

| # | Threat | Vector | Mitigated by | Residual |
|---|--------|--------|--------------|----------|
| T1 | Node/operator reads app data | It relays everything | §2 blind pipe + §3.1 AEAD — sees only ciphertext | Metadata (T5) |
| T2 | Random malicious app binds & reads | Any app calls `bind()` | §3.2 consent + `(pkg,cert)` identity — needs owner approval | User approves a bad app (consent-UX) |
| T3 | Consented app **passively** gets B's traffic | Shared receive stream | §3.3 broker demux — foreign topics dropped | None passively |
| T4 | Consented app **actively** subscribes to B's topics | `subscribe(appId, B_topic)` | *Nothing today* — `_subscribe` has no namespace ACL | **Ciphertext + metadata of B** (not plaintext) — §5.1 |
| T5 | Network/fleet observer | Public Waku wire | Inherent; content is AEAD | Topic, size, timing, sender-id metadata — §5.2 |
| T6 | Spoof/inject into B's channel | Publish on B's topic | AEAD integrity — forgery fails B's open | Garbage/DoS spam — §5.4 |
| T7 | Impersonate another app | Assert a foreign `appId` | Tenant/grant keyed by binder `(pkg,cert)`, not the self-asserted `appId` | `appId` is a routing label only; keep security decisions on `(pkg,cert)` |

## 5. Residual risks & recommended changes (prioritized)

### 5.1 Broker has no topic-namespace ACL (the one real gap)
`_subscribe(tenantId, contentTopic)` lets any tenant subscribe to **any** content
topic, including another app's. Routing isolation today means "you get what you
subscribed to," not "you may not subscribe to a foreign topic." A consented app can
thus harvest another app's **ciphertext + metadata**.

Two fixes (do at least one; they compose):
- **(a) Namespace/capability ACL at the broker.** At `registerClient`, an app
  declares its topic namespace (or the service derives one from `(pkg,cert)`);
  `_subscribe` rejects topics outside it. Cheap, deterministic, and it also blunts
  cross-app publish (T6).
- **(b) Secret-derived topics (recommended, primary).** Derive the content topic
  from the dataset secret: `topic = HMAC(datasetKey, "…/topic/v1|"+epoch)`. Then a
  topic **can't be subscribed to without already holding the secret**, which makes
  the missing ACL moot *and* defeats enumeration (T5). This is already the
  best-practice in `logos-multiwriter-sync`. Note some apps use predictable topics
  today (e.g. scala's `/scala/1/<calId>/json`); those should migrate.

### 5.2 Metadata / traffic analysis
Even without decrypting, a co-tenant or any Waku observer sees topic, message size,
timing, and sender-id. Mitigations: secret-derived + epoch-rotating topics (5.1b),
size padding, and per-epoch sender-id rotation. Partial by nature — document the
residual rather than claim resistance.

### 5.3 Keep the pipe blind (invariant to enforce)
The AIDL's opaque-`sealed`-bytes contract is the load-bearing invariant. Guard it in
review: no method may ever take a key or plaintext, and `metrics()` must stay
node-health-only ("blind pipe stays blind").

### 5.4 Spoofing / DoS
An app can't forge a *valid* B message (no key → fails AEAD open), but a consented
app could spam garbage on a known topic or churn subscriptions. Add per-tenant
publish rate-limits and (with 5.1a) confine publish to the tenant's namespace.

### 5.5 Consent UX
Approval is the human trust anchor, so the prompt must show the real
`(package, label, cert)` and support **revocation**; grants are per `(pkg,cert)` so a
re-signed build re-prompts. Avoid dialog fatigue (batch, remember, clear copy).

## 6. Non-goals

- **Traffic-analysis resistance** beyond topic unlinkability — Waku is a public
  broadcast network by design.
- **Protecting an app from its own device owner** — the owner runs the service and
  grants consent; this is a multi-*app* isolation model, not anti-forensics.
- **Confidentiality from a compromised app process** — if App A's own process is
  compromised, its keys are compromised; that's outside the shared-node boundary.

## Provenance (grounded in code)

- Blind AIDL surface: `app/native/deliveryservice/aidl/co/logos/delivery/ILogosDelivery.aidl`.
- Consent + `(package,cert)` identity: `…/svc/LogosDeliveryService.kt`, `DeliveryHub.kt`.
- Broker routing + the missing topic ACL: `src/broker.mjs` (`_subscribe`/`_route`),
  proven by `demo/demo.mjs` (routing + payload isolation).
- AEAD / secret-derived topics best-practice: the `logos-multiwriter-sync` skill.
