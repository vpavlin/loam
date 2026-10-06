import { NativeModules, Platform, PermissionsAndroid } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as transport from "./logos-transport";
import { getDeviceId, getSenderSecret } from "./device";
import { LoamMeshRadio } from "./logos-transport-pkg/native/blemesh/loam-mesh-radio";
import { WsMeshRadio } from "./logos-transport-pkg/src/ws-mesh-radio";
import { startKeepAlive } from "./keepalive";
import { preloadGrants, initServiceBridge, pushMetrics } from "./service-bridge";

// HEADLESS BOOT. Loam's job is to host the device-wide shared node that other apps bind over AIDL
// (LogosDeliveryService). That must not depend on the UI being open: when a client binds and Android
// (re)creates Loam's process after a crash / OS kill / never-opened, LogosDeliveryService starts the
// React context in the background and this module brings the node up with NO Activity. index.js calls
// boot() at bundle load; the UI (App.tsx) is a pure view over getBootState()/onBootState().
//
// NB: with no resumed Activity, RN's JS timers are PAUSED unless a HeadlessJS task is running — and the
// node start awaits a settle setTimeout. So the service also starts the long-lived BOOT_TASK below
// (see LogosDeliveryService.ensureJs) to keep timers (settle, metrics, mesh ticks) alive headlessly.
export const BOOT_TASK = "LoamBoot";
const PROBE_TOPIC = "/logos-delivery/1/probe/proto";
export type Mode = "Core" | "Edge";
export type BleState = {
  armed: boolean; peers: number; tx: number; rx: number; forced: boolean; delivered: number; dropped: number;
  tx_t: string[]; own_t: string[]; del_t: string[]; drop_t: string[];
};
export type BootState = {
  status: string;
  fg: string;
  nodeMode: Mode | null;                 // the mode the node was STARTED with (UI selection may differ)
  net: { peers: number; mesh: number; rx: number };
  ble: BleState;
  radio: string;                         // native BLE link stats (LoamMeshModule.stats)
  crash: string;                         // last crash / recent process exits (LoamMesh.lastCrash)
  tele: { enabled: boolean; buffered?: number; lastFlush?: string };
  teleSecret: string;                    // persisted telemetry secret — kept even when off
  teleOn: boolean;                       // persisted explicit enable toggle
  meshForced: boolean;
  grantsTick: number;                    // bumped on any consent-list change (re-read lists())
  headless: boolean;                     // no UI attached (yet)
};

let state: BootState = {
  status: "starting…", fg: "foreground service: …", nodeMode: null,
  net: { peers: -1, mesh: -1, rx: 0 },
  ble: { armed: false, peers: 0, tx: 0, rx: 0, forced: false, delivered: 0, dropped: 0, tx_t: [], own_t: [], del_t: [], drop_t: [] },
  radio: "", crash: "", tele: { enabled: false }, teleSecret: "", teleOn: false, meshForced: false, grantsTick: 0,
  headless: true,
};
const listeners = new Set<(s: BootState) => void>();
function set(patch: Partial<BootState>) {
  state = { ...state, ...patch };
  for (const l of listeners) { try { l(state); } catch { /* a view bug must not stall the node */ } }
}
export function getBootState(): BootState { return state; }
export function onBootState(cb: (s: BootState) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
const bumpGrants = () => set({ grantsTick: state.grantsTick + 1 });
const mark = (m: string) => { try { (globalThis as any).__loamMark?.(m); } catch { /* */ } };

// ---- UI attachment: the few things that need a visible Activity ----
let uiMounts = 0;
// Android 12+ refuses a foreground-service start from the background, and react-native-background-
// actions calls startForeground() unguarded in onStartCommand — a refusal there CRASHES the process (a
// crash loop, since clients keep rebinding). So headless on API ≥ 31 we don't try: the bound client keeps
// the process alive and the BOOT_TASK keeps JS timers running. The keepalive starts once the UI opens.
const fgsFromBackgroundOk = () => Platform.OS === "android" && Number(Platform.Version) < 31;
let keepAliveP: Promise<void> | null = null;
function ensureKeepAlive(): Promise<void> {
  if (state.fg === "foreground service: on") return Promise.resolve();
  if (keepAliveP) return keepAliveP;
  keepAliveP = (async () => {
    let r = "";
    try { r = await startKeepAlive(); } catch (e: any) { r = "error: " + String((e && e.message) || e); }
    set({ fg: "foreground service: " + r });
    if (r !== "on") mark(`keepalive ${r.slice(0, 80)}`);
  })().finally(() => { keepAliveP = null; });
  return keepAliveP;
}
// Called by App.tsx on mount; returns the detach for its unmount. Re-evaluates the mesh so an arm that
// was held back headlessly (BLE permissions not yet granted) retries now — and prompts, as before.
export function uiAttached(): () => void {
  uiMounts++;
  if (state.headless) set({ headless: false });
  mark(bootedAt && Date.now() - bootedAt > 5000 ? "ui attached (after headless boot)" : "ui attached");
  void ensureKeepAlive();
  try { transport.forceMesh(transport.meshForcedOn()); } catch { /* re-runs the auto-arm decision */ }
  return () => { uiMounts = Math.max(0, uiMounts - 1); if (uiMounts === 0) mark("ui detached"); };
}

// The real BLE radio, minus the permission PROMPT when no UI is attached: LoamMeshRadio.start() asks
// for the Android 12+ BLE runtime permissions, which needs an Activity. Headless we only arm when they
// are already granted (requestMultiple then resolves without prompting); otherwise throw → the
// transport retries on its next mesh tick, and uiAttached() re-evaluates once the UI can ask.
const BLE_PERMS = ["android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT"];
async function blePermsGranted(): Promise<boolean> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 31) return true;
  try {
    for (const p of BLE_PERMS) if (!(await PermissionsAndroid.check(p as any))) return false;
    return true;
  } catch { return false; }
}
class BootMeshRadio extends LoamMeshRadio {
  async start(): Promise<void> {
    if (uiMounts === 0 && !(await blePermsGranted())) throw new Error("BLE permissions not granted — waiting for the Loam UI");
    return super.start();
  }
}

// ---- the metrics loop: clients read pushMetrics over AIDL, UI or not ----
function startMetricsLoop() {
  let beat = 0;
  setInterval(async () => {
    try { await transport.refreshPeerInfo(); } catch { /* */ }
    const c = transport.counters;
    const edge = transport.getNodeMode() === "Edge";
    // Edge has no relay mesh by design (filter/lightpush) — report deliverable peers as "mesh".
    const meshVal = edge && c.peers > 0 ? c.peers : c.mesh;
    const t = transport as any;
    const bleNow = {
      armed: t.meshEnabled?.() ?? false,
      peers: t.meshPeers?.() ?? 0,
      tx: c.bleTx, rx: c.bleRx,
      forced: t.meshForcedOn?.() ?? false,
      delivered: c.bleRxDelivered ?? 0, dropped: c.bleRxDropped ?? 0,
    };
    // Expose to bound clients over AIDL, WITH the mesh state: a client runs no mesh itself, and
    // without `ble` it saw mesh=0 over Bluetooth-only and showed every post as "queued".
    pushMetrics(c.peers, meshVal, bleNow);
    const d = t.meshRouteDiag?.() ?? { tx: [], owned: [], deliv: [], drop: [] };
    let r = state.radio;
    try { r = await LoamMeshRadio.stats(); } catch { /* */ }
    if (beat++ % 10 === 0) mark(`beat peers=${c.peers} ble=${bleNow.armed ? bleNow.peers : "off"} tx=${c.bleTx} rx=${c.bleRx} | ${r.replace(/lastFrag=\S*/, "").slice(0, 110)}`);
    // telemetry self-drives inside the transport now — just read its status for the UI.
    let tele = state.tele;
    try { tele = transport.telemetryStatus(); } catch { /* */ }
    set({ net: { peers: c.peers, mesh: meshVal, rx: c.rxRaw }, ble: { ...bleNow, tx_t: d.tx, own_t: d.owned, del_t: d.deliv, drop_t: d.drop }, radio: r, tele });
  }, 3000);
}

// ---- boot: everything non-visual that used to live in App.tsx's startup effect ----
let booting: Promise<void> | null = null;
let bootedAt = 0;
export function boot(): Promise<void> {
  if (!booting) booting = run().catch((e: any) => { set({ status: "error: " + String((e && e.message) || e) }); });
  return booting;
}
async function run(): Promise<void> {
  bootedAt = Date.now();
  (globalThis as any).__loamMark = (m: string) => { try { (NativeModules as any).LoamMesh?.mark?.(m); } catch { /* */ } };
  mark("app start");
  (globalThis as any).__loamOnline = async () => { try { return (await (NativeModules as any).LoamMesh?.online?.()) ?? true; } catch { return true; } };
  // Headless vs UI can't be known at bundle load (the Activity, if any, mounts App a moment later).
  setTimeout(() => mark(uiMounts > 0 ? "boot (ui)" : "boot (headless)"), 5000);
  startMetricsLoop();
  try { set({ crash: (await (NativeModules as any).LoamMesh?.lastCrash?.()) || "" }); } catch { /* */ }
  try {
    // Paint the approved-apps list from disk FIRST — it's persisted and needs no node.
    try { await preloadGrants(bumpGrants); } catch { /* */ }
    let m: Mode = "Edge";
    try { m = ((await SecureStore.getItemAsync("logos-delivery-nodemode")) as Mode) || "Edge"; } catch { /* */ }
    set({ nodeMode: m }); transport.setNodeMode(m);
    const deviceId = await getDeviceId();
    const senderSecret = await getSenderSecret();
    // EXPO_PUBLIC_MESH_WS_URL (a test/CI build flag) swaps the native GATT radio for a mock
    // WebSocket radio pointed at test/tools/mesh-relay.js — two nodes then mesh with no Bluetooth,
    // so bearer switching is provable headlessly. Unset in prod → real BLE (registered after start).
    const meshWsUrl = process.env.EXPO_PUBLIC_MESH_WS_URL;
    if (meshWsUrl) {
      // TEST BUILD: arm the mock mesh + heartbeat BEFORE start. The mesh bearer is independent of
      // the Waku node (which never settles on an x86_64 emulator — no native delivery lib), so the
      // whole transport (broker route, fan-out, dedup) is exercised over the mock radio regardless.
      try { transport.setMeshRadio(() => new WsMeshRadio(deviceId, meshWsUrl)); transport.forceMesh(true); } catch { /* */ }
      try { transport.join([PROBE_TOPIC]); } catch { /* */ }  // own the probe topic so received frames route (delivered, not "unowned")
      let hb = 0;
      setInterval(() => { try { transport.publishSealed(PROBE_TOPIC, new TextEncoder().encode("hb:" + deviceId + ":" + hb++)); } catch { /* */ } }, 4000);
    }
    // Keepalive BEFORE the node start (it used to follow it): its HeadlessJS task also un-pauses JS
    // timers, which the node's settle wait needs. Deferred to the UI where a background FGS start is
    // refused (see fgsFromBackgroundOk); uiAttached() may already have started it.
    if (uiMounts > 0 || fgsFromBackgroundOk()) await ensureKeepAlive();
    else if (state.fg === "foreground service: …") set({ fg: "foreground service: deferred until Loam is opened (headless)" });
    // Don't let a node-start failure skip the service bridge below. On an x86_64 emulator start
    // throws (no native Waku lib), but the mesh + AIDL approval flow must still run.
    try {
      await transport.start({ deviceId, senderSecret, topics: [PROBE_TOPIC], onReceive: () => !!meshWsUrl, onStatus: (s) => set({ status: s }) });
    } catch (e: any) { set({ status: "node start failed (mesh/AIDL still up): " + String((e && e.message) || e) }); }
    // Device-wide BLE offline mesh (ADR 0012): register the radio once; the transport auto-arms
    // the mesh when the fleet path drops — so EVERY bound app keeps syncing over Bluetooth.
    if (!meshWsUrl) {
      try { transport.setMeshRadio(LoamMeshRadio.available() ? () => new BootMeshRadio(deviceId) : null); } catch { /* */ }
      // Force mesh is a deliberate choice (e.g. a demo room): restore it, don't reset it on restart.
      try {
        if ((await SecureStore.getItemAsync("loam-mesh-forced")) === "1") { set({ meshForced: true }); transport.forceMesh(true); }
      } catch { /* */ }
    }
    // Attaches the AIDL request listener and calls jsReady → native flushes client requests queued
    // while no JS was running (the whole point of booting headless).
    await initServiceBridge(bumpGrants);
    mark(`bridge ready (${uiMounts > 0 ? "ui" : "headless"})`);
    // Offline-first telemetry is a transport FEATURE: the node buffers its own diagnostics offline +
    // flushes to a sealed topic when the fleet returns. Configured at RUNTIME (persisted secret, set
    // in the UI) with a build-time EXPO_PUBLIC_TELEMETRY_SECRET fallback. Empty = off.
    try {
      let sec = "";
      try { sec = (await SecureStore.getItemAsync("loam-telemetry-secret")) || ""; } catch { /* */ }
      if (!sec) sec = process.env.EXPO_PUBLIC_TELEMETRY_SECRET || "";
      let on = false;
      try { on = (await SecureStore.getItemAsync("loam-telemetry-enabled")) === "1"; } catch { /* */ }
      set({ teleSecret: sec, teleOn: on });
      if (on && sec) await transport.enableTelemetry(sec);   // enabled only when explicitly toggled on
    } catch { /* */ }
  } catch (e: any) { set({ status: "error: " + String((e && e.message) || e) }); }
}

// ---- user actions (from the UI) ----
export function setMeshForced(on: boolean) {
  set({ meshForced: on });
  try { transport.forceMesh(on); } catch { /* */ }
  SecureStore.setItemAsync("loam-mesh-forced", on ? "1" : "0").catch(() => { /* */ });
}
// Persist the secret (kept even when telemetry is off, so it survives updates + toggling); if
// telemetry is currently on, reconfigure it onto the new secret.
export async function setTelemetrySecret(secret: string) {
  set({ teleSecret: secret });
  try { await SecureStore.setItemAsync("loam-telemetry-secret", secret); } catch { /* */ }
  if (state.teleOn && secret) { try { await transport.enableTelemetry(secret); } catch { /* */ } }
}
// Explicit enable/disable. Turning off keeps the secret. Turning on needs a secret set.
export async function setTelemetryEnabled(on: boolean, secret: string) {
  set({ teleOn: on });
  try { await SecureStore.setItemAsync("loam-telemetry-enabled", on ? "1" : "0"); } catch { /* */ }
  try { await transport.enableTelemetry(on ? secret : ""); } catch { /* */ }
}
export async function dismissCrash() {
  try { await (NativeModules as any).LoamMesh?.clearCrash?.(); } catch { /* */ }
  set({ crash: "" });
}
