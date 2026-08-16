import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import * as Clipboard from "expo-clipboard";
import * as transport from "./src/lib/logos-transport";
import { getDeviceId } from "./src/lib/device";
import { LoamMeshRadio } from "./src/lib/logos-transport-pkg/native/blemesh/loam-mesh-radio";
import { WsMeshRadio } from "./src/lib/logos-transport-pkg/src/ws-mesh-radio";
import { startKeepAlive } from "./src/lib/keepalive";
import * as telemetry from "./src/lib/telemetry";
import { preloadGrants, initServiceBridge, serviceBridgeAvailable, lists, approve, deny, revoke, setCache, pushMetrics, Client } from "./src/lib/service-bridge";

// The device-wide shared delivery node runs ONE Loam node in a foreground service; other apps
// bind over AIDL and — once YOU approve them — sync through it. This screen presents the node as
// what it is: a TRANSPORT with several bearers. Each bearer is a card (live stats + its control +
// when/why you'd use it). Matches the desktop loam_ui panel.
const PROBE_TOPIC = "/logos-delivery/1/probe/proto";
type Mode = "Core" | "Edge";
const shortCert = (c: string) => (c ? c.slice(0, 10) + "…" : "?");

export default function App() {
  const [status, setStatus] = useState("starting…");
  const [copied, setCopied] = useState(false);
  const [fg, setFg] = useState("foreground service: …");
  const [meshForced, setMeshForced] = useState(false);
  const [mode, setMode] = useState<Mode>("Core");
  const [tick, setTick] = useState(0);   // bump to re-read consent lists
  // per-bearer live state
  const [net, setNet] = useState({ peers: -1, mesh: -1, rx: 0 });
  const [ble, setBle] = useState({ armed: false, peers: 0, tx: 0, rx: 0, forced: false, delivered: 0, dropped: 0, tx_t: [] as string[], own_t: [] as string[], del_t: [] as string[], drop_t: [] as string[] });

  useEffect(() => {
    (async () => {
      try {
        // Paint the approved-apps list from disk FIRST — it's persisted and needs no node.
        try { await preloadGrants(() => setTick((n) => n + 1)); } catch { /* */ }
        let m: Mode = "Edge";
        try { m = ((await SecureStore.getItemAsync("logos-delivery-nodemode")) as Mode) || "Edge"; } catch { /* */ }
        setMode(m); transport.setNodeMode(m);
        try { await Notifications.requestPermissionsAsync(); } catch { /* */ }
        const deviceId = await getDeviceId();
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
        // Don't let a node-start failure skip the service bridge + keepalive below. On an x86_64
        // emulator start throws (no native Waku lib), but the mesh + AIDL approval flow must still run.
        try {
          await transport.start({ deviceId, topics: [PROBE_TOPIC], onReceive: () => !!meshWsUrl, onStatus: setStatus });
        } catch (e: any) { setStatus("node start failed (mesh/AIDL still up): " + String((e && e.message) || e)); }
        // Device-wide BLE offline mesh (ADR 0012): register the radio once; the transport auto-arms
        // the mesh when the fleet path drops — so EVERY bound app keeps syncing over Bluetooth.
        if (!meshWsUrl) {
          try { transport.setMeshRadio(LoamMeshRadio.available() ? () => new LoamMeshRadio(deviceId) : null); } catch { /* */ }
        }
        setFg("foreground service: " + (await startKeepAlive()));
        await initServiceBridge(() => setTick((n) => n + 1));
        // Offline-first telemetry (opt-in via EXPO_PUBLIC_TELEMETRY_SECRET): own the device id +
        // subscribe the telemetry topic so buffered snapshots can flush to the fleet when it returns.
        if (telemetry.telemetryEnabled()) {
          telemetry.setDevice(deviceId);
          try { await transport.join([telemetry.TELEMETRY_TOPIC]); } catch { /* */ }
        }
      } catch (e: any) { setStatus("error: " + String((e && e.message) || e)); }
    })();
    const iv = setInterval(async () => {
      try { await transport.refreshPeerInfo(); } catch { /* */ }
      const c = transport.counters;
      const edge = transport.getNodeMode() === "Edge";
      // Edge has no relay mesh by design (filter/lightpush) — report deliverable peers as "mesh".
      const meshVal = edge && c.peers > 0 ? c.peers : c.mesh;
      setNet({ peers: c.peers, mesh: meshVal, rx: c.rxRaw });
      pushMetrics(c.peers, meshVal);   // expose to bound clients over AIDL
      const t = transport as any;
      const d = t.meshRouteDiag?.() ?? { tx: [], owned: [], deliv: [], drop: [] };
      setBle({
        armed: t.meshEnabled?.() ?? false,
        peers: t.meshPeers?.() ?? 0,
        tx: c.bleTx, rx: c.bleRx,
        forced: t.meshForcedOn?.() ?? false,
        delivered: c.bleRxDelivered ?? 0, dropped: c.bleRxDropped ?? 0,
        tx_t: d.tx, own_t: d.owned, del_t: d.deliv, drop_t: d.drop,
      });
      // telemetry: snapshot every tick (durable, offline-safe); flush to the fleet when it's up
      if (telemetry.telemetryEnabled()) {
        telemetry.record({
          peers: c.peers, mesh: meshVal, rxRaw: c.rxRaw, mode: transport.getNodeMode(),
          bleTx: c.bleTx, bleRx: c.bleRx, bleDelivered: c.bleRxDelivered ?? 0, bleDropped: c.bleRxDropped ?? 0,
          armed: t.meshEnabled?.() ?? false, forced: t.meshForcedOn?.() ?? false,
        }).catch(() => {});
        if (c.peers > 0) telemetry.flush().catch(() => {});
      }
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  const pick = async (m: Mode) => { try { await SecureStore.setItemAsync("logos-delivery-nodemode", m); } catch { /* */ } setMode(m); };
  const { pending, granted } = serviceBridgeAvailable() ? lists() : { pending: [] as Client[], granted: [] as any[] };
  const netUp = net.peers > 0;
  const bleColor = ble.armed ? (ble.peers > 0 ? C.green : C.amber) : C.inkFaint;

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.c}>
      <Text style={s.title}>Loam</Text>
      <Text style={s.sub}>the soil your apps grow in</Text>

      {/* overall — tap to copy a full stats dump (on-device bug reports without retyping) */}
      <TouchableOpacity style={s.statusRow} activeOpacity={0.6} onPress={async () => {
        const dump = [
          `Loam  ${new Date().toISOString()}`,
          `status: ${status}`,
          `${fg}`,
          `[logos network] peers:${net.peers} mesh:${net.mesh} rx:${net.rx} mode:${mode}`,
          `[ble mesh] armed:${ble.armed} forced:${ble.forced} nearby:${ble.peers} tx:${ble.tx} rx:${ble.rx} delivered:${ble.delivered} dropped:${ble.dropped}`,
          `  own:  ${ble.own_t.join("  ") || "—"}`,
          `  tx:   ${ble.tx_t.join("  ") || "—"}`,
          `  del:  ${ble.del_t.join("  ") || "—"}`,
          `  drop: ${ble.drop_t.join("  ") || "—"}`,
        ].join("\n");
        try { await Clipboard.setStringAsync(dump); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
      }}>
        <View style={[s.dot, { backgroundColor: netUp ? C.green : C.amber }]} />
        <Text style={s.status}>{status}</Text>
        <Text style={s.copyHint}>{copied ? "  copied ✓" : "  ⧉ copy"}</Text>
      </TouchableOpacity>

      <Text style={s.label}>BEARERS</Text>

      {/* ── Logos network (the internet path) ───────────────────────────── */}
      <View style={s.bearer}>
        <View style={s.bHead}>
          <View style={[s.dot, { backgroundColor: netUp ? C.green : C.amber }]} />
          <Text style={s.bName}>Logos network</Text>
          <View style={{ flex: 1 }} />
          <Text style={s.bState}>{netUp ? "connected" : "connecting…"}</Text>
        </View>
        <Text style={s.bStats}>
          {net.peers < 0 ? "—" : `${net.peers} peer${net.peers === 1 ? "" : "s"}`}
          {`   ${net.mesh >= 0 ? net.mesh : 0} in mesh   rx ${net.rx}`}
        </Text>
        <View style={s.modeRow}>
          {(["Edge", "Core"] as Mode[]).map((m) => (
            <TouchableOpacity key={m} style={[s.chip, mode === m && s.chipOn]} onPress={() => pick(m)}>
              <Text style={[s.chipT, mode === m && s.chipTOn]}>{m}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.why}>
          The internet path — reaches anyone on the Logos network, anywhere there's a connection.
          It's how apps sync by default.{"\n"}
          <Text style={s.whyB}>{mode === "Edge" ? "Edge" : "Core"}</Text>
          {mode === "Edge"
            ? " (selected): light on battery & data — right for a phone on mobile or WiFi."
            : " (selected): relays the shard for the whole network — best on stable WiFi + power."}
          {"  Relaunch to apply a change."}
        </Text>
      </View>

      {/* ── Bluetooth mesh (offline path) ───────────────────────────────── */}
      <View style={s.bearer}>
        <View style={s.bHead}>
          <View style={[s.dot, { backgroundColor: bleColor }]} />
          <Text style={s.bName}>Bluetooth mesh</Text>
          <View style={{ flex: 1 }} />
          <Text style={s.bState}>{ble.forced ? "forced on" : ble.armed ? "armed" : "idle"}</Text>
        </View>
        <Text style={s.bStats}>
          {ble.armed ? `${ble.peers} nearby   tx ${ble.tx}   rx ${ble.rx}` : "not active — arms automatically when needed"}
        </Text>
        {ble.armed && (ble.rx > 0 || ble.dropped > 0) ? (
          <Text style={[s.bStats, { color: ble.dropped > 0 && ble.delivered === 0 ? C.clay : C.inkFaint }]}>
            {`routed: ${ble.delivered} delivered · ${ble.dropped} dropped (unowned topic)`}
          </Text>
        ) : null}
        {ble.armed ? (
          <View style={{ marginTop: 4 }}>
            <Text style={[s.bStats, { color: C.inkFaint }]}>{`own:  ${ble.own_t.join("  ") || "—"}`}</Text>
            <Text style={[s.bStats, { color: C.inkFaint }]}>{`tx:   ${ble.tx_t.join("  ") || "—"}`}</Text>
            <Text style={[s.bStats, { color: C.green }]}>{`del:  ${ble.del_t.join("  ") || "—"}`}</Text>
            <Text style={[s.bStats, { color: C.clay }]}>{`drop: ${ble.drop_t.join("  ") || "—"}`}</Text>
          </View>
        ) : null}
        <View style={s.ctrlRow}>
          <Text style={s.ctrlLabel}>Force on</Text>
          <Switch
            value={meshForced}
            trackColor={{ true: "#4E8A3C", false: "#3A2E20" }}
            onValueChange={(v) => { setMeshForced(v); try { (transport as any).forceMesh?.(v); } catch { /* */ } }}
          />
        </View>
        <Text style={s.why}>
          No internet needed — nearby phones sync directly, phone-to-phone, over Bluetooth. It
          auto-arms when the Logos path drops (a dead zone, a basement, a conference WiFi that's
          drowning) and heals back to the network the moment it returns. Force it on to test the
          mesh with the internet still up.
        </Text>
      </View>

      {/* ── LoRa (planned) ──────────────────────────────────────────────── */}
      <View style={[s.bearer, s.bearerPlanned]}>
        <View style={s.bHead}>
          <View style={[s.dot, { backgroundColor: C.inkFaint }]} />
          <Text style={[s.bName, { color: C.inkSoft }]}>LoRa</Text>
          <View style={{ flex: 1 }} />
          <Text style={s.bState}>planned</Text>
        </View>
        <Text style={s.why}>
          Long-range, low-power radio — kilometres, off-grid, no phones-in-a-room required. A future
          bearer: apps won't change, it just becomes another pipe Loam fans writes across.
        </Text>
      </View>

      <Text style={s.fg}>{fg}</Text>

      {pending.length > 0 && <>
        <Text style={s.label}>REQUESTS</Text>
        {pending.map((c) => (
          <View key={c.callerKey} style={s.reqCard}>
            <Text style={s.appName}>{c.label}</Text>
            <Text style={s.appMeta}>{c.pkg}{"\n"}id {c.appId} · cert {shortCert(c.cert)}</Text>
            <Text style={s.ask}>wants to use the shared node</Text>
            <View style={s.row2}>
              <TouchableOpacity style={[s.btn, s.deny]} onPress={() => deny(c.callerKey)}><Text style={s.btnT}>Deny</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.allow]} onPress={() => approve(c.callerKey)}><Text style={[s.btnT, { color: "#14100C" }]}>Allow</Text></TouchableOpacity>
            </View>
          </View>
        ))}
      </>}

      <Text style={s.label}>APPROVED APPS {granted.length ? `(${granted.length})` : ""}</Text>
      {granted.length === 0
        ? <Text style={s.empty}>No apps approved yet. When an app asks to use this node, you'll see a request above.</Text>
        : granted.map((g: any) => (
          <View key={g.callerKey} style={s.grantRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.appName}>{g.label}</Text>
              <Text style={s.appMeta}>{g.pkg} · {shortCert(g.cert)}</Text>
              <View style={s.cacheRow}>
                <Switch
                  value={g.cache !== false}
                  onValueChange={(v) => setCache(g.callerKey, v)}
                  trackColor={{ true: "#4E8A3C", false: "#3A2E20" }}
                />
                <Text style={s.cacheLabel}>
                  {g.cache === false ? "Cache off" : `Cache while closed · ${g.buffered} waiting`}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={[s.btn, s.deny]} onPress={() => revoke(g.callerKey)}><Text style={s.btnT}>Revoke</Text></TouchableOpacity>
          </View>
        ))}

      <Text style={s.note}>One shared Loam node per phone, behind a consent gate — so ten apps don't each run ten radios. Every sealed write is fanned across all bearers and deduped, so a message over the network and the same over Bluetooth fold to one. Data lives on your device as sealed bytes; Loam only ever moves ciphertext. “Cache while closed” lets the node hold an app's messages while it isn't running, so it opens faster with less re-sync.</Text>
    </ScrollView>
  );
}

// Loam design language — the warm "soil & sprout" palette from vpavlin.github.io/loam.
const C = {
  ground: "#14100C", surface: "#1E1813", tileMid: "#2C2318", tileTop: "#3A2E20",
  ink: "#ECE5D6", inkSoft: "#A08E76", inkFaint: "#7C6D58",
  green: "#5CB636", sprout: "#8ECB6F", greenBright: "#9CE873", clay: "#D2894E", amber: "#D2894E",
};
const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.ground },
  c: { alignItems: "stretch", padding: 20, paddingTop: 60, paddingBottom: 48 },
  title: { color: C.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.5, textAlign: "center" },
  sub: { color: C.sprout, fontSize: 13, marginBottom: 20, fontFamily: "monospace", letterSpacing: 1, textAlign: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  status: { color: C.inkSoft, fontSize: 14 },
  copyHint: { color: C.green, fontSize: 11, fontFamily: "monospace" },
  dot: { width: 9, height: 9, borderRadius: 5 },
  label: { color: C.inkFaint, fontSize: 11, fontFamily: "monospace", letterSpacing: 1.5, marginTop: 26, marginBottom: 10 },
  // bearer card
  bearer: { backgroundColor: C.surface, borderColor: C.tileMid, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 12 },
  bearerPlanned: { opacity: 0.6, borderStyle: "dashed" },
  bHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  bName: { color: C.ink, fontSize: 16, fontWeight: "700" },
  bState: { color: C.inkFaint, fontSize: 11, fontFamily: "monospace" },
  bStats: { color: C.inkSoft, fontSize: 13, fontFamily: "monospace", marginTop: 8 },
  modeRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  chip: { borderColor: C.tileTop, borderWidth: 1, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 24 },
  chipOn: { backgroundColor: C.green, borderColor: C.green },
  chipT: { color: C.inkSoft, fontSize: 14, fontWeight: "700" }, chipTOn: { color: C.ground },
  ctrlRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  ctrlLabel: { color: C.inkSoft, fontSize: 14, fontWeight: "600" },
  why: { color: C.inkFaint, fontSize: 12, lineHeight: 18, marginTop: 12 },
  whyB: { color: C.sprout, fontWeight: "700" },
  fg: { color: C.inkFaint, fontSize: 11, fontFamily: "monospace", marginTop: 8, textAlign: "center" },
  // requests / approved apps
  reqCard: { backgroundColor: C.surface, borderColor: C.green, borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 10 },
  appName: { color: C.ink, fontSize: 16, fontWeight: "700" },
  appMeta: { color: C.inkSoft, fontSize: 11, fontFamily: "monospace", marginTop: 3 },
  ask: { color: C.sprout, fontSize: 13, marginTop: 8 },
  row2: { flexDirection: "row", gap: 10, marginTop: 12 },
  cacheRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  cacheLabel: { color: C.inkSoft, fontSize: 12 },
  btn: { flex: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center" },
  allow: { backgroundColor: C.green }, deny: { borderColor: C.tileTop, borderWidth: 1, backgroundColor: C.tileMid, flex: 0, paddingHorizontal: 20 },
  btnT: { color: C.inkSoft, fontSize: 14, fontWeight: "700" },
  grantRow: { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderColor: C.tileMid, borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 8, gap: 10 },
  empty: { color: C.inkFaint, fontSize: 13, lineHeight: 18 },
  note: { color: C.inkFaint, fontSize: 11, marginTop: 28, textAlign: "center", lineHeight: 17 },
});
