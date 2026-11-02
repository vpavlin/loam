import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import * as FileSystem from "expo-file-system";
import * as Notifications from "expo-notifications";
import * as transport from "./logos-transport";
import { hdHandle } from "./hd-root";

// The consent-gated IPC bridge. Apps bind the AIDL service and are identified by their
// VERIFIED signing cert + package (callerKey, resolved natively). The device owner approves
// each app once ("Allow App X?"); until then the app's subscribes are queued and nothing is
// delivered. Grants persist and are revocable. The service never sees plaintext (opaque bytes).
const Bridge = (NativeModules as any).LogosDeliveryBridge;
const emitter = Bridge ? new NativeEventEmitter(Bridge) : null;
export function serviceBridgeAvailable(): boolean { return !!Bridge; }
// Cache the node's live peers/mesh natively so bound clients can read it over AIDL.
// Expose the node's live health to bound clients over AIDL. `ble` carries the BLE mesh bearer's
// liveness + counters so a client (which runs no mesh of its own) isn't blind to Bluetooth: it can
// show the mesh in its status/LoamDebug and, crucially, treat a nearby BLE peer as reachability so
// its publishes confirm over BLE-only. The service stays a blind pipe — this is node health, not data.
export function pushMetrics(peers: number, mesh: number, ble?: { peers: number; armed: boolean; forced: boolean; tx: number; rx: number; delivered: number; dropped: number }) {
  try { Bridge?.setMetrics(JSON.stringify({ peers, mesh, ble })); } catch { /* */ }
}

const GRANTS = (FileSystem.documentDirectory || "") + "logos-delivery-grants.json";
// Offline cache ring size per approved app (ADR 0011). Bounded; on overflow the
// oldest are dropped and the app reconciles the gap. Per-app toggle = future UI.
const CACHE_LIMIT = 1000;
export type Client = { callerKey: string; appId: string; pkg: string; cert: string; label: string };
// topics: every topic the approved app subscribed (Loam 0.0.66), kept until the app unsubscribes it or the
// app is unapproved. At start Loam joins them for the app and caches what arrives, whoever started Loam.
type Grant = Client & { granted: boolean; cache?: boolean; mainSign?: boolean; topics?: string[] };
const MAX_SAVED_TOPICS = 256;   // per app (the AIDL layer caps the same)

// ── HD identity namespace (audit L-1) ────────────────────────────────────────────────────────────
// The app id a client sends is only a claim. Identities derive under a namespace, so the namespace
// must belong to the VERIFIED package: the shipped apps' ids are pinned to their packages (their users'
// identities already derive under these ids); any other id must equal the caller's own package name,
// else the caller gets its package as namespace. A client can never land in another app's namespace.
// Pins are (package, signing certificate) — a package name alone can be taken by a sideloaded fake
// when the real app isn't installed (re-check R-1). Certificates are base64(sha256(cert)), as in the
// callerKey. Freequencies is built on Scala's and Kith's data (scala-sdk, kith-sdk) and signs in their
// spaces, so it is the one app allowed into those two namespaces besides their own.
const CERT = {
  scalaPerun: "Te8ucZrdRI0Crcq2t5v8K/a8B/jOb+IsViftMJztCmw=", kith: "s3XXlaEvuHts+AQlEhGa2HcdFjtm6e8FJtvgGqB316g=",
  kym: "zmTIXku7QPy69H0qe6DxShWdfv1wukujlnYNYayGZCU=", qaku: "61elU6XiS1kG3r/c8UPiQ5lrnUFJZJ6aGqx2dLArXi8=",
  whisperbox: "yrDMBe1NeVbyWcAP5wy3dMLDpOac22TOQhv3Eg0BK9Q=", foray: "T6GWnPhagqMV7Qy8JGhnqMZwUe6K+j3O+PVXx3f88uc=",
  freequencies: "ByUZdvBIIDF2j5x66boQz9NhBaTFvVj55ubudpk9Zwg=",
};
const FQ = `xyz.vpavlin.freequencies|${CERT.freequencies}`;
const PINNED_IDS: Record<string, string[]> = {
  scala: [`xyz.vpavlin.scala|${CERT.scalaPerun}`, FQ], kith: [`xyz.vpavlin.kith|${CERT.kith}`, FQ],
  kym: [`xyz.vpavlin.kym|${CERT.kym}`], qaku: [`xyz.vpavlin.qaku|${CERT.qaku}`], perun: [`xyz.vpavlin.perun|${CERT.scalaPerun}`],
  whisperbox: [`xyz.vpavlin.whisperbox|${CERT.whisperbox}`], foray: [`xyz.vpavlin.foray|${CERT.foray}`], freequencies: [FQ],
};
/** Every other app gets a namespace bound to its package AND certificate, so a re-signed or fake copy
 *  of an app never lands in the real one's identities. */
export function hdNamespace(appId: string, pkg: string, cert: string): string {
  // own keys only: "__proto__", "constructor"… must not reach Object.prototype (re-check R-6)
  if (typeof appId === "string" && Object.prototype.hasOwnProperty.call(PINNED_IDS, appId) && PINNED_IDS[appId].includes(`${pkg}|${cert}`)) return appId;
  return `${pkg}|${cert}`;
}
const MAX_QUEUED_TOPICS = 64;   // per unapproved caller (audit L-4)

const grants = new Map<string, Grant>();                       // callerKey -> grant (persisted)
const pending = new Map<string, Client>();                     // awaiting user decision
const queued = new Map<string, string[]>();                    // callerKey -> topics buffered pre-grant
const active = new Set<string>();                              // callerKey registered as a tenant
let onChange: (() => void) | null = null;

function pushAuthorized() {
  try { Bridge?.setAuthorized(JSON.stringify([...grants.values()].filter((g) => g.granted).map((g) => g.callerKey))); } catch { /* */ }
}
async function persist() {
  try { await FileSystem.writeAsStringAsync(GRANTS, JSON.stringify([...grants.values()])); } catch { /* */ }
}
// Topic changes come in bursts (an app joining its rooms): write once, a moment later.
let persistTimer: any = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 2000);
}
function rememberTopic(ck: string, topic: string) {
  const g = grants.get(ck); if (!g?.granted) return;
  const ts = g.topics ?? (g.topics = []);
  if (ts.includes(topic) || ts.length >= MAX_SAVED_TOPICS) return;
  ts.push(topic); persistSoon();
}
function forgetTopic(ck: string, topic: string) {
  const g = grants.get(ck); if (!g?.topics) return;
  const i = g.topics.indexOf(topic); if (i < 0) return;
  g.topics.splice(i, 1); persistSoon();
}
const cacheLimitOf = (ck: string) => grants.get(ck)?.cache === false ? 0 : CACHE_LIMIT;

// Loam 0.0.66: at start, every approved app that isn't connected gets its tenant back DETACHED with its saved
// topics, so Loam receives and caches its messages whether or not the app (or which app) started Loam.
// Then one store pull per app fills the cache with what was sent while Loam was down. Spaced out, after the
// node had time to find peers; an app that connects meanwhile gets the pull's results live.
const RESTORE_PULL_DELAY_MS = 15_000;
async function restoreApprovedApps() {
  const todo: string[] = [];
  for (const g of grants.values()) {
    if (!g.granted || cacheLimitOf(g.callerKey) === 0 || !g.topics?.length) continue;
    if (active.has(g.callerKey)) continue;
    try { await transport.restoreClient(g.callerKey, g.topics, CACHE_LIMIT); todo.push(g.callerKey); } catch { /* */ }
  }
  try { (globalThis as any).__loamMark?.(`restored ${todo.length} app(s) for caching`); } catch { /* */ }
  setTimeout(async () => {
    for (const ck of todo) { try { await transport.clientStoreSync(ck); } catch { /* */ } }
  }, RESTORE_PULL_DELAY_MS);
}
let grantsLoaded = false;
async function loadGrants() {
  if (grantsLoaded) return;
  try {
    const info = await FileSystem.getInfoAsync(GRANTS);
    if (info.exists) for (const g of JSON.parse(await FileSystem.readAsStringAsync(GRANTS))) grants.set(g.callerKey, g);
  } catch { /* */ }
  grantsLoaded = true;
}

// Load the persisted approved-apps list from disk WITHOUT waiting for the node. Call this first,
// before transport.start(), so the "Approved apps" list paints instantly on launch instead of
// only after the node connects. The live request/route wiring still happens in initServiceBridge
// (below) once the node is up — routing to clients genuinely needs a started node.
export async function preloadGrants(change: () => void): Promise<boolean> {
  if (!Bridge) return false;
  onChange = change;
  await loadGrants();
  pushAuthorized();
  change();
  return true;
}

function activate(callerKey: string) {
  if (active.has(callerKey)) return;
  active.add(callerKey);
  // Approved apps get offline caching (ADR 0011): while the app is unbound the
  // node keeps its subscription and buffers (opaque) messages, drained on rebind.
  transport.registerClient(callerKey, (topic, cands, meta) => {
    const candidatesJson = JSON.stringify(cands.map((c: Uint8Array) => fromByteArray(c)));
    // The network timestamp (ns) + source, for clients that asked for them (DeliveryHub decides).
    if (meta && typeof Bridge.deliverMeta === "function")
      Bridge.deliverMeta(callerKey, topic, candidatesJson, JSON.stringify({ ts: meta.ts, source: meta.source, bearer: meta.bearer }));
    else Bridge.deliver(callerKey, topic, candidatesJson);
    return true;   // service is a blind pipe; the client opens with its own key
  }, { cacheLimit: cacheLimitOf(callerKey) });
}

export async function initServiceBridge(change: () => void): Promise<boolean> {
  if (!Bridge || !emitter) return false;
  onChange = change;
  await loadGrants();
  pushAuthorized();
  emitter.addListener("logosDeliveryRequest", async (r: any) => {
    try {
      const ck = r.callerKey as string;
      // Breadcrumb for client requests. Not send (too frequent) and not touch (every metrics poll of an
      // unapproved app: noise that pushed the useful lines out of the trail).
      if (r.kind !== "send" && r.kind !== "touch" && r.kind !== "hd") { try { (globalThis as any).__loamMark?.(`client ${r.kind} ${String(r.label || r.appId || ck).slice(0, 16)}${r.topic ? " " + String(r.topic).slice(-12) : ""}`); } catch { /* */ } }
      if (r.kind === "register") {
        const client: Client = { callerKey: ck, appId: r.appId, pkg: r.pkg, cert: r.cert, label: r.label };
        if (grants.get(ck)?.granted) { activate(ck); return; }           // already approved
        if (process.env.EXPO_PUBLIC_AUTO_APPROVE === "1") {              // TEST/CI: skip the consent tap
          grants.set(ck, { ...client, granted: true, cache: true }); await persist(); pushAuthorized();
          activate(ck);
          for (const t of queued.get(ck) || []) { try { await transport.clientSubscribe(ck, t); } catch { /* */ } }
          queued.delete(ck);
          onChange && onChange();
          return;
        }
        if (!pending.has(ck)) {
          pending.set(ck, client);
          try { await Notifications.scheduleNotificationAsync({ content: { title: "Allow an app to use Loam?", body: `${client.label} wants to use the shared node — tap to review.` }, trigger: null }); } catch { /* */ }
          onChange && onChange();
        }
      } else if (r.kind === "subscribe") {
        const granted = !!grants.get(ck)?.granted;
        // An approved app whose register this JS never saw (Loam's JS restarted, or it missed it): the
        // native layer says it is connected (live) → treat it as active instead of queueing forever.
        if (!active.has(ck) && granted && r.live === "1") activate(ck);
        if (active.has(ck)) { await transport.clientSubscribe(ck, r.topic); rememberTopic(ck, r.topic); }
        else if (granted) {   // approved but not connected: join it for the app and cache (Loam 0.0.66)
          rememberTopic(ck, r.topic);
          if (cacheLimitOf(ck) > 0) { try { await transport.restoreClient(ck, [r.topic], CACHE_LIMIT); } catch { /* */ } }
        }
        else { const q = queued.get(ck) || []; if (q.length < MAX_QUEUED_TOPICS && !q.includes(r.topic)) q.push(r.topic); queued.set(ck, q); }   // buffer until approved (bounded)
      } else if (r.kind === "unsubscribe") {
        forgetTopic(ck, r.topic);
        const q = queued.get(ck); if (q) queued.set(ck, q.filter((t) => t !== r.topic));
        try { await transport.clientUnsubscribe(ck, r.topic); } catch { /* */ }
      } else if (r.kind === "send") {
        if (active.has(ck)) await transport.publishSealed(r.topic, toByteArray(r.sealedB64));   // ungranted sends dropped
      } else if (r.kind === "storeSync") {
        // Cold-start history pull for this client: run the node's store query and route each stored
        // message back to the client through the normal receive callback (folded like a live msg).
        // An approved app that isn't active (its register was missed) still gets its pull: the results
        // land in its cache and reach it as soon as it is connected (Loam 0.0.66; was silently dropped).
        if (!active.has(ck) && grants.get(ck)?.granted) {
          const saved = grants.get(ck)?.topics ?? [];
          if (cacheLimitOf(ck) > 0 && saved.length) { try { await transport.restoreClient(ck, saved, CACHE_LIMIT); } catch { /* */ } }
          if (transport.clientCacheInfo(ck).cacheLimit > 0) await transport.clientStoreSync(ck);
        } else if (active.has(ck)) await transport.clientStoreSync(ck);
      } else if (r.kind === "hd") {
        // HD identity request (ADR 0001). Only approved apps, and ONLY in the app namespace recorded when
        // the owner approved them — a client can't ask for another app's identities by naming its appId.
        const g = grants.get(ck);
        const reply = (j: unknown) => { try { Bridge.hdReply(r.reqId, JSON.stringify(j)); } catch { /* */ } };
        if (!g?.granted) { reply({ error: "not approved" }); return; }
        reply(await hdHandle(hdNamespace(g.appId, g.pkg, g.cert), r.request || "{}", { mainSign: g.mainSign === true }));
      } else if (r.kind === "touch") {
        if (!grants.get(ck)?.granted && !pending.has(ck)) {
          pending.set(ck, { callerKey: ck, appId: r.appId || "", pkg: r.pkg, cert: r.cert, label: r.label });
          try { await Notifications.scheduleNotificationAsync({ content: { title: "Allow an app to use Loam?", body: `${r.label} wants to use the shared node — tap to review.` }, trigger: null }); } catch { /* */ }
          onChange && onChange();
        }
      } else if (r.kind === "unregister") {
        active.delete(ck); await transport.unregisterClient(ck); onChange && onChange();
      }
    } catch { /* never throw in the bridge */ }
  });
  // Approved apps get their topics joined + cached before any of them connects (Loam 0.0.66).
  try { await restoreApprovedApps(); } catch { /* */ }
  // The request listener is now attached — tell native to replay any register/subscribe/send that
  // was buffered while the JS/node was down (an app that bound & subscribed before Loam was running),
  // and (0.0.66) the register + topics of every app already connected, so a restarted JS knows them.
  try { (Bridge as any).jsReady?.(); } catch { /* */ }
  return true;
}

// ---- consent actions (called from the UI) ----
export async function approve(callerKey: string) {
  const c = pending.get(callerKey); if (!c) return;
  grants.set(callerKey, { ...c, granted: true, cache: true }); await persist(); pushAuthorized();
  pending.delete(callerKey);
  activate(callerKey);
  for (const t of queued.get(callerKey) || []) { try { await transport.clientSubscribe(callerKey, t); rememberTopic(callerKey, t); } catch { /* */ } }
  queued.delete(callerKey);
  onChange && onChange();
}
export async function setCache(callerKey: string, on: boolean) {
  const g = grants.get(callerKey); if (!g) return;
  g.cache = on; grants.set(callerKey, g); await persist();
  try { transport.setClientCache(callerKey, on ? CACHE_LIMIT : 0); } catch { /* */ }
  onChange && onChange();
}
/** Allow (or stop) an approved app to sign with the owner's MAIN identity (audit L-2). Off by default:
 *  approving an app lets it use Loam and its own derived identities, not sign as you. */
export async function setMainSign(callerKey: string, on: boolean) {
  const g = grants.get(callerKey); if (!g) return;
  g.mainSign = on; grants.set(callerKey, g); await persist();
  onChange && onChange();
}
export async function deny(callerKey: string) { pending.delete(callerKey); queued.delete(callerKey); onChange && onChange(); }
export async function revoke(callerKey: string) {
  grants.delete(callerKey); await persist(); pushAuthorized();
  active.delete(callerKey); try { await transport.unregisterClient(callerKey, { hard: true }); } catch { /* */ }
  onChange && onChange();
}
export function lists(): { pending: Client[]; granted: (Grant & { buffered: number })[] } {
  const granted = [...grants.values()].filter((g) => g.granted).map((g) => {
    let buffered = 0; try { buffered = transport.clientCacheInfo(g.callerKey).buffered; } catch { /* */ }
    return { ...g, buffered };
  });
  return { pending: [...pending.values()], granted };
}
