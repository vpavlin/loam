// Config plugin: Logos Storage in Loam (loam-transport ADR 0020). Survives `expo prebuild` by copying,
// on every prebuild:
//   - native/loamstorage/arm64-v8a/{libstorage.so, liblogos_storage_jni.so} -> jniLibs/arm64-v8a/
//     (libc++_shared.so comes from native/logosdelivery: byte-identical, NDK r27);
//   - native/loamstorage/android/java/**.kt -> app/src/main/java/** (StorageNative + StorageEngine; the
//     AIDL methods live in native/deliveryservice).
// LOAM_EMU=1 also copies the x86_64 build (emulator tests of the Storage side only: the Delivery node
// is arm64-only and won't start there) and adds x86_64 to the ABI filter.
const { withDangerousMod, withAppBuildGradle } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const LIBS = ["libstorage.so", "liblogos_storage_jni.so"];
const EMU = process.env.LOAM_EMU === "1";

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
    const root = path.join(cfg.modRequest.projectRoot, "native", "loamstorage");
    const main = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main");
    for (const abi of EMU ? ["arm64-v8a", "x86_64"] : ["arm64-v8a"]) {
      const dst = path.join(main, "jniLibs", abi);
      fs.mkdirSync(dst, { recursive: true });
      for (const so of abi === "x86_64" ? [...LIBS, "libc++_shared.so"] : LIBS) {
        const s = path.join(root, abi, so);
        if (!fs.existsSync(s)) throw new Error(`withLoamStorage: missing ${s} (run native/loamstorage/build-jni.sh)`);
        fs.copyFileSync(s, path.join(dst, so));
      }
    }
    copyDir(path.join(root, "android", "java"), path.join(main, "java"));
    return cfg;
  }]);

const withEmuAbi = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (EMU && !cfg.modResults.contents.includes('"x86_64"')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(/defaultConfig\s*\{/, `defaultConfig {\n        ndk { abiFilters "arm64-v8a", "x86_64" }`);
    }
    return cfg;
  });

module.exports = (config) => withEmuAbi(withCopy(config));
