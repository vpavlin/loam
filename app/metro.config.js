// Metro config for the Logos Delivery service app. It bundles only the shared
// logos-transport (vendored under src/lib/logos-transport-pkg) — no external monorepo
// packages — so, unlike qaku, there is no ../packages watchFolder. The node:crypto shim
// is kept (harmless; the transport itself uses @noble, not node:crypto).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.resolver.useWatchman = false;
config.watcher = config.watcher || {};
config.watcher.unstable_lazySha1 = false;

config.resolver.sourceExts = Array.from(new Set([...config.resolver.sourceExts, "mjs"]));
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];

const cryptoShim = path.resolve(projectRoot, "shims/crypto.js");
const EXPLICIT = { "node:crypto": cryptoShim, crypto: cryptoShim };
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = EXPLICIT[moduleName];
  if (target) return { type: "sourceFile", filePath: target };
  if (defaultResolveRequest) return defaultResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
