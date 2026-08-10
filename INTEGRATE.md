# Integrating with Logos Delivery (the shared node)

**Logos Delivery** runs **one** Waku/`liblogosdelivery` node for the whole phone, in a
foreground service. Your app **binds** it over Android IPC (AIDL) and sends/receives through
that one node instead of embedding its own — saving battery, data, and duplicate meshes. The
device owner **approves your app once** ("Allow *App X*?"); you never coordinate keys with us.

This guide is for **other developers** who want their app to use it.

---

## What you get, and the trust model

- **One node, many apps.** You subscribe to your content topics and send on them; the node is
  shared. Each bound app is isolated by content topic.
- **You keep your crypto.** The service moves **opaque, already-sealed bytes**. It never has
  your keys and can't read your traffic. Encrypt before `send`, decrypt after `onMessage`.
- **User consent is the gate.** On first bind the owner sees **"Allow *App X*?"** with your
  app name, package, and signing-cert fingerprint. Approve once; revocable anytime.
- **Spoof-proof identity.** The service identifies you by your **verified signing certificate +
  package** (resolved from the binder UID), *not* by anything your app claims. A re-signed or
  repackaged build is a new, unapproved identity.
- **No key sharing, no allowlist to manage.** You sign with **your own** key. The owner just taps
  Allow. (Requires **Logos Delivery ≥ 0.0.6** — earlier builds gated binding to same-key apps.)

**What binding does *not* buy you:** the owner's trust is app-wide — an approved app may
subscribe/send on any topic through the node. Fine among apps a person chooses to run; it is
not a sandbox between mutually-distrusting tenants.

---

## Two ways to integrate

### A. React Native / Expo app on `logos-transport` (easiest)

If your app already uses the shared **`logos-transport`** package (the same transport qaku/kym
use), the node is behind an `UnderlyingNode` seam — switching to the shared node is one call.

1. **Use `logos-transport` ≥ 0.4.0** (submodule or dep). It ships `ServiceNode` +
   `preferServiceBackend()`.
2. **Add the client native module + plugin** (binds the AIDL service). Copy from the reference
   app (`qaku-logos`, branch `feat/shared-delivery-client`):
   - `mobile/native/deliveryclient/` (the AIDL + `LogosDeliveryClientModule.kt` + package)
   - `mobile/plugins/withDeliveryClient.js` — add it to `app.json` `plugins`. It copies the
     files, registers the module, enables `aidl`, and declares the `<queries>` package
     visibility needed to bind another app.
3. **Opt in before the first transport call:**
   ```ts
   import * as transport from "logos-transport";   // your import path
   transport.preferServiceBackend(true, "your-app-id");   // BEFORE transport.start(...)
   await transport.start({ deviceId, topics, onReceive, onStatus });
   ```
   If the service isn't installed, `ServiceNode.available()` is false and the transport
   **falls back to an embedded node** automatically — your app still works standalone.
4. On `start`, the client binds + registers, which triggers the owner's **"Allow?"** prompt.
   Until approved, your subscribes are queued and nothing is delivered; after approval it flows.

That's it — `publishSealed` / `onReceive` / `join` behave exactly as with an embedded node.

### B. Any app, directly over AIDL

You don't need `logos-transport` (or even RN). Speak the AIDL yourself.

**1. Declare package visibility + copy the AIDL** into your app (same package path, so the proxy
resolves):
```xml
<!-- AndroidManifest.xml -->
<queries><package android:name="co.logos.delivery" /></queries>
```
`co/logos/delivery/ILogosDelivery.aidl` + `ILogosDeliveryCallback.aidl` (verbatim below), and
enable AIDL in Gradle: `android { buildFeatures { aidl true } }`.

**2. Bind the service:**
```kotlin
val intent = Intent().apply {
  component = ComponentName("co.logos.delivery", "co.logos.delivery.svc.LogosDeliveryService")
}
context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
// in onServiceConnected: val svc = ILogosDelivery.Stub.asInterface(binder)
```

**3. Register (triggers consent), subscribe, send; receive via the callback:**
```kotlin
svc.registerClient("your-app-id", object : ILogosDeliveryCallback.Stub() {
  override fun onMessage(topic: String, candidatesJson: String) { /* decode + open, see below */ }
})
svc.subscribe("your-app-id", "/yourapp/1/<room>/proto")
svc.send("your-app-id", topic, sealedBytes)      // sealedBytes = YOUR AEAD ciphertext
```

`appId` is a **display label only** — identity is your verified signing cert. Nothing works
until the owner approves; unapproved `send`s are dropped, `subscribe`s queued.

---

## The AIDL contract

```aidl
// co/logos/delivery/ILogosDelivery.aidl
package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);   // triggers "Allow App X?"
    void subscribe(String appId, String topic);                     // content topic
    void send(String appId, String topic, in byte[] sealed);        // YOUR sealed bytes
    void unregisterClient(String appId);
}
```
```aidl
// co/logos/delivery/ILogosDeliveryCallback.aidl
package co.logos.delivery;
interface ILogosDeliveryCallback {
    oneway void onMessage(String topic, String candidatesJson);
}
```

## Payload & topic conventions

- **`sealed`** — opaque bytes you produce. The service does not interpret them. Use per-app AEAD
  (e.g. XChaCha20-Poly1305) keyed by a secret only your app/peers hold. A foreign app that
  received your topic couldn't open it.
- **`candidatesJson`** — a JSON array of **base64 strings**, each a candidate decoding of the wire
  payload (the transport tries single- and double-base64 to absorb a historical wire ambiguity).
  **Try to `open()` each candidate with your key; use the first that authenticates.**
- **`topic`** — a Waku content topic, conventionally `"/<app>/<version>/<name>/proto"`. RFC-51
  autosharding derives the shard from `<app>+<version>`; the shared node covers any shard
  (in Edge mode it filter-subscribes regardless of shard), so different apps coexist fine.
- **Ordering/history** — live delivery is via SDS reliable channels under the hood. Store-history
  backfill through the service is not proxied yet (embed a node if you need `storeQuery` today).

## Consent, from the owner's side

A bound app appears in Logos Delivery as a **request** (name · package · cert). The owner taps
**Allow** or **Deny**; approvals persist and are revocable from **Approved apps**. Denied/pending
apps can bind but do nothing. Approve **before** sending — pre-approval sends are dropped.

## Checklist

- [ ] `logos-transport` ≥ 0.4.0 **or** the AIDL copied verbatim (path `co/logos/delivery/`).
- [ ] `android { buildFeatures { aidl true } }`.
- [ ] `<queries><package android:name="co.logos.delivery"/></queries>`.
- [ ] Bind `co.logos.delivery/.svc.LogosDeliveryService`; keep the `ILogosDelivery` proxy.
- [ ] `registerClient` → owner approves → `subscribe` your topics → `send` sealed bytes.
- [ ] On `onMessage`, try each base64 candidate with your key.
- [ ] Fallback: run your own node if the service isn't installed.
- [ ] Requires **Logos Delivery ≥ 0.0.6**.

## Reference implementation

`github.com/vpavlin/qaku-logos`, branch **`feat/shared-delivery-client`** — the client native
module, the `withDeliveryClient` plugin, and the one-line `preferServiceBackend(true, "qaku")`
opt-in with an in-app "Own node / Shared" toggle. The service itself is in this repo (`app/`).
