# 4. Identity is a loam service (keys + signing in loam; UI in each app)

- **Status:** accepted — **implemented in `loam_core` 0.3.0 (desktop), including Keycard**
  (2026-08-18); on-card verification + mobile migration pending
- **Date:** 2026-08-18

## Context

Every Loam app signs its events — authorship + integrity are universal. Today each app reimplements
identity: on mobile, a per-app `identities.ts`/registry (scala, kym, qaku each carry one); on desktop
it doesn't exist at all (scala's C++ core signs with a single device key). That is the exact
duplication the **shared delivery node** (ADR [0001](0001-shared-node-in-its-own-process.md)) was
created to end — and both sides now depend on loam the same way (mobile on loam-transport, desktop on
the `loam_core` Basecamp module), so loam is the natural home.

Two facts make this pressing:
- **Keycard is already a shared service.** Alisher's `keycard` Basecamp module is a single signing
  service any app calls via `requestSign` — not per-app. So hardware identity is *already* a
  shared-module concern; software identity should match.
- **The engine already exists.** `loam-keycard`'s `createIdentityRegistry({storagePrefix, soft,
  keycard})` is the generic device/soft/keycard registry + per-container binding + `authorEvent`
  routing, extracted from scala. This is "move it down into loam and share it," not "write it again."

## Decision

**Identity is a loam service; the identity UI stays in each app.** Same split as transport: loam_core
*delivers*, the app's view renders the calendar — now loam_core also *signs*, the app's view renders
the identities panel.

- **The service lives in loam** — `loam_core` on desktop (a C++ Basecamp module), loam-transport /
  loam-keycard on mobile. It owns key custody (device / named-soft / Keycard), the per-container
  binding (`containerId → identityId`), the default, and the signing operation. The **Keycard kind
  delegates to Alisher's `keycard` module** (`requestSign`) — so loam is the *one* place that talks to
  the card, and apps talk to loam.
- **The UI stays in each app's view** — scala renders its own Identities panel + per-calendar
  "author as"; kym/qaku render theirs. They call loam's identity methods over the module IPC; they do
  **not** re-implement custody or signing.
- **loam_core identity API** (universal-authoring `std::string` methods — no `Q_OBJECT`/QML — called
  via `callModule("loam_core", …)` from a view or `modules().loam_core.method()` from a core), mirroring
  the mobile registry: `listIdentities`, `addSoftIdentity(label)`, `renameSoftIdentity`,
  `removeSoftIdentity`, `getDefaultIdentityId`/`setDefaultIdentityId`, `bindingFor(containerId)`,
  `bindContainer(containerId, identityId)`, `identityForContainer(containerId)`, and the load-bearing
  one — **`signDigest(containerId, digestHex) → {sig, pub, address}`**: sign a 32-byte digest with the
  container's bound identity (device/soft keys locally). An app builds its canonical digest, asks loam
  to sign, stamps `pub`/`sig` — it never handles a private key. Keys live in an `IdentityStore`
  (`~/.loam-core/identities.json`); address = `"0x"+sha256(compressed-pub)[24:64]`, byte-identical to
  mobile.
- **Keycard kind — async, delegated (implemented, `loam_core` 0.3.0).** `keycard` is a **declared
  (mandatory) dependency** of loam_core; a keycard identity holds **no private key**. `signDigest`
  returns a `keycard-delegated` sentinel; instead the app calls the async surface:
  **`enrollKeycard(label, domain, ref)`**, **`keycardSign(containerId, digestHex, ref)`**,
  `removeKeycardIdentity(id)`, with results delivered on the **`keycardSignResult(ref, json)`** event
  (non-blocking `requestSignAsync`/`checkSignStatusAsync` poll — never stalls the module thread).
  Signing is on-card at **`m/43'/60'/1582'/…`** — the same non-exportable `domainToSignPath` the phone
  uses, so **one card is one identity across phone + desktop**. Enrol recovers the card's public
  address from a 65-byte `R‖S‖V` (`ecdsaRecover`, no extra API); signatures are normalised to 64-byte
  low-S (`compact64LowS`). The PIN/tap live in Alisher's `keycard-ui`, never in loam. See scala ADR
  0016 for the desktop-authoring detail.

### Shared-by-default, per-app opt-in
loam holds *your* identities once. By default an app authors with the shared default identity; an app
may **mint a compartmentalised key** scoped to itself when the user wants work/personal separation —
gated by the same **binder-consent** model as the node (ADR [0002](0002-consent-from-binder-identity.md)):
loam holds the keys, an app asks to use one (or make its own), you approve. One Keycard enrolment
serves every app; compartmentalisation stays available for those who want it.

## Consequences

- **One custody surface.** Keys + the Keycard integration live in loam, audited once, not smeared
  across every app's core. Apps can't leak a private key they never hold.
- **Desktop parity comes for free-ish.** scala's desktop identities = consume loam_core's identity
  API from the view + route the core's authoring through `loam_core.signDigest` — no bespoke
  multi-key C++ in scala. Same for kym/qaku later.
- **A cross-app identity model.** Shared-by-default means "one you" across apps unless you opt a key
  into a single app — matching how the shared node already feels.
- **Not free:** `loam_core` grows an identity subsystem (key store, binding store, `signDigest`, the
  keycard delegation) + a consent prompt; each app routes signing through it (scala core: replace its
  local `ecdsaSignLowS` with `loam_core.signDigest`). Mobile migrates `identities.ts` consumers onto
  the loam-provided service over time (the engine is already shared via loam-keycard).
- **Sequencing:** (1) this ADR ✅; (2) `loam_core` identity service — device/soft **and** Keycard,
  via the `keycard` module per scala ADR 0016 ✅ (loam_core 0.3.0); (3) scala view Identities panel
  calling loam_core + scala core routing authoring through `loam_core.signDigest`/`keycardSign` ✅
  (scala 0.9.0 / scala_ui 0.8.0, compile- + render-verified); (4) **still to do:** on-card
  verification (enrolled address == the phone's card address for a domain), then roll to kym/qaku and
  converge the mobile registry onto the same service.
