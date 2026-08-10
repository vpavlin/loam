import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import * as FileSystem from "expo-file-system";
import * as Notifications from "expo-notifications";
import * as transport from "./logos-transport";

// The consent-gated IPC bridge. Apps bind the AIDL service and are identified by their
// VERIFIED signing cert + package (callerKey, resolved natively). The device owner approves
// each app once ("Allow App X?"); until then the app's subscribes are queued and nothing is
// delivered. Grants persist and are revocable. The service never sees plaintext (opaque bytes).
const Bridge = (NativeModules as any).LogosDeliveryBridge;
const emitter = Bridge ? new NativeEventEmitter(Bridge) : null;
export function serviceBridgeAvailable(): boolean { return !!Bridge; }
// Cache the node's live peers/mesh natively so bound clients can read it over AIDL.
export function pushMetrics(peers: number, mesh: number) { try { Bridge?.setMetrics(JSON.stringify({ peers, mesh })); } catch { /* */ } }

const GRANTS = (FileSystem.documentDirectory || "") + "logos-delivery-grants.json";
export type Client = { callerKey: string; appId: string; pkg: string; cert: string; label: string };
type Grant = Client & { granted: boolean };

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
async function loadGrants() {
  try {
    const info = await FileSystem.getInfoAsync(GRANTS);
    if (info.exists) for (const g of JSON.parse(await FileSystem.readAsStringAsync(GRANTS))) grants.set(g.callerKey, g);
  } catch { /* */ }
}

function activate(callerKey: string) {
  if (active.has(callerKey)) return;
  active.add(callerKey);
  transport.registerClient(callerKey, (topic, cands) => {
    Bridge.deliver(callerKey, topic, JSON.stringify(cands.map((c: Uint8Array) => fromByteArray(c))));
    return true;   // service is a blind pipe; the client opens with its own key
  });
}

export async function initServiceBridge(change: () => void): Promise<boolean> {
  if (!Bridge || !emitter) return false;
  onChange = change;
  await loadGrants();
  pushAuthorized();
  emitter.addListener("logosDeliveryRequest", async (r: any) => {
    try {
      const ck = r.callerKey as string;
      if (r.kind === "register") {
        const client: Client = { callerKey: ck, appId: r.appId, pkg: r.pkg, cert: r.cert, label: r.label };
        if (grants.get(ck)?.granted) { activate(ck); return; }           // already approved
        if (!pending.has(ck)) {
          pending.set(ck, client);
          try { await Notifications.scheduleNotificationAsync({ content: { title: "Allow an app to use Logos Delivery?", body: `${client.label} wants to use the shared node — tap to review.` }, trigger: null }); } catch { /* */ }
          onChange && onChange();
        }
      } else if (r.kind === "subscribe") {
        if (active.has(ck)) await transport.clientSubscribe(ck, r.topic);
        else { const q = queued.get(ck) || []; q.push(r.topic); queued.set(ck, q); }   // buffer until approved
      } else if (r.kind === "send") {
        if (active.has(ck)) await transport.publishSealed(r.topic, toByteArray(r.sealedB64));   // ungranted sends dropped
      } else if (r.kind === "touch") {
        if (!grants.get(ck)?.granted && !pending.has(ck)) {
          pending.set(ck, { callerKey: ck, appId: r.appId || "", pkg: r.pkg, cert: r.cert, label: r.label });
          try { await Notifications.scheduleNotificationAsync({ content: { title: "Allow an app to use Logos Delivery?", body: `${r.label} wants to use the shared node — tap to review.` }, trigger: null }); } catch { /* */ }
          onChange && onChange();
        }
      } else if (r.kind === "unregister") {
        active.delete(ck); await transport.unregisterClient(ck); onChange && onChange();
      }
    } catch { /* never throw in the bridge */ }
  });
  return true;
}

// ---- consent actions (called from the UI) ----
export async function approve(callerKey: string) {
  const c = pending.get(callerKey); if (!c) return;
  grants.set(callerKey, { ...c, granted: true }); await persist(); pushAuthorized();
  pending.delete(callerKey);
  activate(callerKey);
  for (const t of queued.get(callerKey) || []) { try { await transport.clientSubscribe(callerKey, t); } catch { /* */ } }
  queued.delete(callerKey);
  onChange && onChange();
}
export async function deny(callerKey: string) { pending.delete(callerKey); queued.delete(callerKey); onChange && onChange(); }
export async function revoke(callerKey: string) {
  grants.delete(callerKey); await persist(); pushAuthorized();
  active.delete(callerKey); try { await transport.unregisterClient(callerKey); } catch { /* */ }
  onChange && onChange();
}
export function lists(): { pending: Client[]; granted: Grant[] } {
  return { pending: [...pending.values()], granted: [...grants.values()].filter((g) => g.granted) };
}
