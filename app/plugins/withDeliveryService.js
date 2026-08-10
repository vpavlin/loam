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
    // top-level signature permission
    m.manifest.permission = m.manifest.permission || [];
    if (!m.manifest.permission.find((p) => p.$ && p.$["android:name"] === PERMISSION)) {
      m.manifest.permission.push({ $: { "android:name": PERMISSION, "android:protectionLevel": "signature" } });
    }
    // exported bound service, gated by the permission
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(m);
    app.service = app.service || [];
    if (!app.service.find((s) => s.$ && s.$["android:name"] === SERVICE)) {
      app.service.push({
        $: { "android:name": SERVICE, "android:exported": "true", "android:permission": PERMISSION },
        "intent-filter": [{ action: [{ $: { "android:name": "co.logos.delivery.ILogosDelivery" } }] }],
      });
    }
    return cfg;
  });

module.exports = (config) => withManifest(withAidlFeature(withPackage(withCopy(config))));
