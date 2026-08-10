# Integrating with Logos Delivery (the shared node)

**Logos Delivery** runs **one** Waku/`liblogosdelivery` node for the whole phone, in a
foreground service. Your app **binds** it over Android IPC and syncs through that one node
instead of embedding its own — saving battery, data, and duplicate meshes. The device owner
**approves your app once** ("Allow *App X*?"); you never coordinate keys with us.

Proven with two independently-built apps (qaku on shard 0, KYM on shard 7) sharing one node.

---

## What you get, and the trust model

- **One node, many apps.** Subscribe your content topics, send on them; the node is shared.
- **You keep your crypto.** The service moves **opaque, already-sealed bytes**. It never has
  your keys and can't read your traffic. Encrypt before send, decrypt after receive.
- **User consent is the gate.** On first bind the owner sees **"Allow *App X*?"** with your
  name, package, and signing-cert fingerprint. Approve once; revocable anytime. Until then,
  your sends are dropped, subscribes queued, and **you can't even read the node's health**
  (that request just re-surfaces the prompt).
- **Spoof-proof identity.** The service identifies you by your **verified signing cert +
  package** (from the binder UID) — not by anything your app claims. Sign with **your own**
  key; the owner just taps Allow. **No key sharing, no cert exchange, no allowlist.**

**Requires Logos Delivery ≥ 0.0.10.**

---

## The easy path: an RN/Expo app on `logos-transport` (the SDK)

If your app uses the shared **`logos-transport`** package (the same transport qaku/kym use),
integrating is ~4 steps — no vendored native, the SDK ships it all. **This is what KYM did.**

**1. Add the package as a git submodule** (≥ 0.8.0):
```sh
git submodule add https://github.com/vpavlin/logos-transport mobile/src/lib/logos-transport-pkg
```

**2. Import the transport from it.** If you already `import * as transport from "./logos-transport"`,
make `logos-transport.ts` a one-line shim:
```ts
export * from "./logos-transport-pkg/src/logos-transport";
```

**3. Enable the client plugin** in `app.json` `plugins` (copies the AIDL + bind module,
enables `aidl`, adds the `<queries>` + permission — all from the package):
```json
"./src/lib/logos-transport-pkg/plugins/withDeliveryClient.js"
```

**4. Opt in before your first transport call:**
```ts
const shared = (await SecureStore.getItemAsync("myapp-shared-node")) === "1";
transport.preferServiceBackend(shared, "myapp");   // BEFORE transport.start(...)
await transport.start({ deviceId, topics, onReceive, onStatus });
```
If Logos Delivery isn't installed, it **falls back to an embedded node** automatically — your
app still works standalone. On start it binds + registers, triggering the "Allow?" prompt;
after approval it flows. **Reconnect is automatic** (service updated/killed → re-bind +
re-register + re-subscribe; the grant persists, so no re-prompt).

**Nice-to-haves (optional), all provided by the SDK:**
- A **Core/Edge** device-mode is owned by the Logos Delivery app — you don't set it.
- Status: `transport.counters.peers` / `.mesh` reflect the shared node once approved.
- A **prompt banner** — show when the node needs attention:
  ```ts
  import { usingServiceBackend, serviceNodeDown, serviceAwaitingApproval, launchSharedService } from "…/logos-transport";
  // if (usingServiceBackend() && (serviceNodeDown() || serviceAwaitingApproval()))
  //   render a banner → onPress: launchSharedService()   // opens Logos Delivery
  ```
  `serviceNodeDown()` = installed but not running; `serviceAwaitingApproval()` = not approved yet.

That's the whole integration. See **KYM's `feat/shared-delivery-client` branch** for a complete,
shipping example (submodule + shim + the plugin line + `preferServiceBackend` + a Setup toggle
+ the banner).

---

## The raw path: any app, directly over AIDL

Don't use `logos-transport` (or even RN)? Speak the AIDL yourself.

**Declare visibility + copy the AIDL** (`package co.logos.delivery`), enable
`android { buildFeatures { aidl true } }`, and:
```xml
<queries><package android:name="co.logos.delivery" /></queries>
```
**Bind** `co.logos.delivery/.svc.LogosDeliveryService` (action `co.logos.delivery.ILogosDelivery`),
then `registerClient` (triggers consent) / `subscribe` / `send(topic, sealedBytes)`; receive via
the callback. `metrics()` returns `{"authorized":false}` until the owner approves you.

```aidl
package co.logos.delivery;
import co.logos.delivery.ILogosDeliveryCallback;
interface ILogosDelivery {
    void registerClient(String appId, ILogosDeliveryCallback cb);   // triggers "Allow App X?"
    void subscribe(String appId, String topic);
    void send(String appId, String topic, in byte[] sealed);        // YOUR sealed bytes
    void unregisterClient(String appId);
    String metrics();                                               // {authorized:false} until approved
}
interface ILogosDeliveryCallback { oneway void onMessage(String topic, String candidatesJson); }
```

## Payload & topic conventions

- **`sealed`** — opaque bytes you produce (per-app AEAD, e.g. XChaCha20-Poly1305). A foreign
  app that received your topic couldn't open it.
- **`candidatesJson`** — a JSON array of **base64** payload candidates (the wire has a single/
  double-base64 ambiguity). **Try each with your key; use the first that authenticates.**
- **`topic`** — a Waku content topic, conventionally `"/<app>/<version>/<name>/proto"`.
  RFC-51 autosharding derives the shard from `<app>+<version>`; the shared node covers any
  shard (Edge filter-subscribes regardless of shard), so different apps coexist.
- History/backfill through the service isn't proxied yet (live delivery only).

## Checklist

- [ ] `logos-transport` ≥ 0.8.0 submodule **or** the AIDL copied verbatim.
- [ ] `withDeliveryClient` plugin enabled (SDK path) or `aidl`+`<queries>` set (raw path).
- [ ] `preferServiceBackend(true, "appId")` before `start()` (SDK), or bind + registerClient (raw).
- [ ] `send` your **sealed** bytes; on receive, try each base64 candidate with your key.
- [ ] Logos Delivery ≥ 0.0.10 installed.

## Reference implementations
`github.com/vpavlin/qaku-logos` and `github.com/vpavlin/kym`, branch **`feat/shared-delivery-client`**.
The service is in this repo (`app/`); the SDK is `github.com/vpavlin/logos-transport`.
