// Config plugin: the shared-delivery IPC surface. Survives `expo prebuild` by copying
// the AIDL + Kotlin out of native/deliveryservice/ into the generated android/ each time,
// registering the RN package, enabling AIDL, and adding the exported service + a
// signature-level permission (only apps signed with the same key may bind).
const { withDangerousMod, withMainApplication, withAppBuildGradle, withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PERMISSION = "co.logos.delivery.permission.BIND";
const SERVICE = "co.logos.delivery.svc.LogosDeliveryService";
const PACKAGE = "co.logos.delivery.svc.DeliveryBridgePackage";

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const withCopy = (config) =>
  withDangerousMod(config, ["android", (cfg) => {
    const root = cfg.modRequest.projectRoot;
    const nativeRoot = path.join(root, "native", "deliveryservice");
    const main = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main");
    copyDir(path.join(nativeRoot, "aidl"), path.join(main, "aidl"));
    copyDir(path.join(nativeRoot, "android", "java"), path.join(main, "java"));
    return cfg;
  }]);

const withPackage = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(PACKAGE)) return cfg;
    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(src)) {
      src = src.replace(/(PackageList\(this\)\.packages\.apply\s*\{)/, `$1\n            add(${PACKAGE}())`);
    } else if (/return\s+PackageList\(this\)\.packages\b(?!\.)/.test(src)) {
      src = src.replace(/return\s+PackageList\(this\)\.packages\b(?!\.)/, `return PackageList(this).packages.apply {\n            add(${PACKAGE}())\n          }`);
    } else { throw new Error("withDeliveryService: could not find PackageList(this).packages"); }
    cfg.modResults.contents = src;
    return cfg;
  });

const withAidlFeature = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes("aidl true")) return cfg;
    // AGP 8 disables AIDL by default — turn it on.
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /android\s*\{/, `android {\n    buildFeatures { aidl true }`
    );
    return cfg;
  });

const withManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults;
    // Exported bound service with NO permission gate: ANY app may bind, but a bind alone
    // does nothing — the real gate is USER CONSENT ("Allow App X?") + the server-verified
    // caller signing cert (see LogosDeliveryService). A signature permission would block
    // third-party (different-key) apps, defeating the consent model, so we don't use one.
    // Strip any previously-added top-level permission definition.
    if (Array.isArray(m.manifest.permission)) {
      m.manifest.permission = m.manifest.permission.filter((p) => !(p.$ && p.$["android:name"] === PERMISSION));
    }
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(m);
    app.service = app.service || [];
    let svc = app.service.find((s) => s.$ && s.$["android:name"] === SERVICE);
    if (!svc) {
      svc = { $: { "android:name": SERVICE }, "intent-filter": [{ action: [{ $: { "android:name": "co.logos.delivery.ILogosDelivery" } }] }] };
      app.service.push(svc);
    }
    svc.$["android:exported"] = "true";
    delete svc.$["android:permission"];   // no permission gate — consent is the gate (idempotent)
    return cfg;
  });

module.exports = (config) => withManifest(withAidlFeature(withPackage(withCopy(config))));
