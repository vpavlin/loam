import { AppRegistry } from "react-native";
import { registerRootComponent } from "expo";
import { boot, BOOT_TASK } from "./src/lib/boot";
import App from "./App";

// Loam mobile entry point. This bundle runs whenever the React context is created — with the
// Activity (user opened Loam) OR without it (LogosDeliveryService started JS because a client app
// bound while Loam's process wasn't running). So the node boots HERE, not in the UI: fire-and-forget
// before registerRootComponent, which only matters if an Activity later mounts App.
boot().catch(() => { /* boot() records its own errors in its state */ });
// The service starts this long-lived HeadlessJS task on a headless boot: while any task is active RN
// keeps JS timers running without a resumed Activity (the node's settle wait + metrics loop need them).
// It never resolves — it lives as long as the process.
AppRegistry.registerHeadlessTask(BOOT_TASK, () => () => boot().then(() => new Promise(() => { /* keep timers alive */ })));
// registerRootComponent calls AppRegistry.registerComponent and sets up the Expo environment for
// both Expo Go and a native (prebuild) build.
registerRootComponent(App);
