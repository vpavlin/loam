# Rename to Loam — cutover runbook

Goal: `logos-shared-delivery` → **Loam** (app id `xyz.vpavlin.loam`); shared libs
`logos-transport` → `loam-transport`, `logos-sync` → `loam-sync`; every consumer updated.

**Why a runbook, not an auto-run:** two steps rename *public* GitHub repos and touch six
repos (scala/kym/qaku-logos/perun are separate products). GitHub keeps a redirect on rename,
so old submodule URLs keep resolving during the cutover — but do the steps in order and
verify each. **Do the appId cut only after BLE 0.0.22 is confirmed on-device** (it reinstalls
the app as a new package, resetting the test).

Consumers (verified 2026-08-14):
- `logos-transport` submodule → **scala, kym, qaku-logos, perun, logos-shared-delivery**
- `logos-sync` → **scala** (+ the lib repo itself)
- `logos-skills` → one doc reference

## Constraints & scope (refined 2026-08-14 — READ FIRST)

Rename what's **ours**; keep genuine **Logos Delivery** references (the upstream Waku node +
the shared IPC contract). Three tiers:

- **RENAME (ours):** `co.logos.mesh` → `xyz.vpavlin.loam.mesh` ✅ DONE+built; `logos-transport`
  → `loam-transport`; `logos-sync` → `loam-sync`; C++ `logos_transport.hpp` → `loam_transport.hpp`;
  TS `logos-transport.ts` → `loam-transport.ts` + package names; app id/label → Loam ✅.
- **KEEP (Logos Delivery, on purpose):** the AIDL package/interface `co.logos.delivery` /
  `ILogosDelivery` — it's the shared IPC contract every client app binds to; renaming it would
  force a **lockstep** flip across the service + all 4 clients for zero benefit. Also the app
  namespace `co.logos.delivery` (MainApplication/svc) stays — appId (`xyz.vpavlin.loam`) is
  independent of namespace.
- **PINNED — cannot rename:** `com.receiverandroid.LogosMessagingModule`. The prebuilt
  `liblogos_messaging_jni.so` exports `Java_com_receiverandroid_LogosMessagingModule_*` symbols;
  renaming the Java package → `UnsatisfiedLinkError`. (Only movable by recompiling the JNI shim
  `logos_messaging_ffi.c` against the prebuilt `liblogosdelivery.so` — a later stretch, not now.)

---

## Stage A — the libs (do first; redirects keep consumers working)

1. **Rename the GitHub repos** (irreversible, outward):
   ```sh
   gh repo rename loam-transport -R vpavlin/logos-transport
   gh repo rename loam-sync      -R vpavlin/logos-sync
   ```
2. In **each** lib's own repo: `package.json` `"name"` → `loam-transport` / `loam-sync`;
   README/CHANGELOG/HANDOVER titles; the C++ umbrella `basecamp/logos_transport.hpp` →
   `loam_transport.hpp` (+ include guards) — grep `logos_transport`, `logos-transport`,
   `logos_sync`, `logos-sync`. Commit + push. (Tag a version so consumers can pin.)

## Stage B — rewire every consumer (scala, kym, qaku-logos, perun, logos-shared-delivery)

Per repo:
1. `.gitmodules`: `url` → `.../loam-transport` (and `loam-sync` for scala); optionally rename
   the submodule `path` `logos-transport-pkg` → `loam-transport-pkg` then
   `git mv` + `git submodule sync`.
2. Grep-replace import paths / references: `logos-transport-pkg` → `loam-transport-pkg`,
   `logos-transport` → `loam-transport`, `logos_transport` → `loam_transport` (and the `-sync`
   variants in scala). Files seen: mobile `App.tsx`, `src/lib/delivery.ts`,
   `src/lib/logos-transport.ts`; C++ `*_engine.hpp`, `*_impl.cpp`, `flake.nix`.
3. `git submodule update --init --remote`; build-verify (device/nix as applicable); commit+push.

Counts to expect (files touching the names): scala 53, kym 19, qaku-logos 21, perun 20,
logos-shared-delivery 38.

## Stage C — this repo becomes Loam

1. **Display** (DONE): `app/app.json` name→"Loam", slug/scheme→`loam`.
2. **Android namespace + appId** (reinstalls the app):
   - `app/app.json` `android.package` `co.logos.delivery` → `xyz.vpavlin.loam`.
   - `app/android/app/build.gradle` `applicationId` + `namespace` → `xyz.vpavlin.loam`.
   - Move native pkg dirs + declarations: `co/logos/mesh` → `xyz/vpavlin/loam/mesh`,
     `co/logos/delivery` → `xyz/vpavlin/loam/delivery`; AIDL package `co.logos.delivery`;
     `AndroidManifest`; the Expo plugins (`withLogosDelivery.js`, `withDeliveryService.js`,
     `withLoamMesh.js`) that copy/register them. Prefer regenerating via `expo prebuild`
     after updating the plugins, then re-verify the BLE native lands under the new package.
   - Keep `LoamMesh*` class names (already "Loam").
3. Rename the repo dir `logos-shared-delivery` → `loam` and `gh repo rename loam` if the
   GitHub repo exists.
4. Bump version, build, verify BLE still works under the new package.

## Stage D — republish

- F-Droid: publish the new `xyz.vpavlin.loam` APK (new package = new entry, not an update to
  `co.logos.delivery`); update metadata name "Loam". Catalog/storefront card if listed.

## Verify

- All six repos build; submodules resolve to `loam-*`; a fresh `git clone --recursive` of each
  works (redirect or updated URL).
- Loam app installs as `xyz.vpavlin.loam`, BLE mesh still delivers (node-keyed counters).
