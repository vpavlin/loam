import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import * as transport from "./src/lib/logos-transport";
import { getDeviceId } from "./src/lib/device";
import { LoamMeshRadio } from "./src/lib/logos-transport-pkg/native/blemesh/loam-mesh-radio";
import { startKeepAlive } from "./src/lib/keepalive";
import { initServiceBridge, serviceBridgeAvailable, lists, approve, deny, revoke, setCache, pushMetrics, Client } from "./src/lib/service-bridge";

// The device-wide shared delivery node. It runs ONE liblogosdelivery node in a foreground
// service; other apps bind over AIDL and — once YOU approve them — sync through this one node.
const PROBE_TOPIC = "/logos-delivery/1/probe/proto";
type Mode = "Core" | "Edge";
const shortCert = (c: string) => (c ? c.slice(0, 10) + "…" : "?");

export default function App() {
  const [status, setStatus] = useState("starting…");
  const [fg, setFg] = useState("foreground service: …");
  const [info, setInfo] = useState("");
  const [mesh, setMesh] = useState("off");
  const [meshForced, setMeshForced] = useState(false);
  const [mode, setMode] = useState<Mode>("Core");
  const [tick, setTick] = useState(0);   // bump to re-read consent lists
  useEffect(() => {
    (async () => {
      try {
        let m: Mode = "Edge";
        try { m = ((await SecureStore.getItemAsync("logos-delivery-nodemode")) as Mode) || "Edge"; } catch { /* */ }
        setMode(m); transport.setNodeMode(m);
        try { await Notifications.requestPermissionsAsync(); } catch { /* */ }
        const deviceId = await getDeviceId();
        await transport.start({ deviceId, topics: [PROBE_TOPIC], onReceive: () => false, onStatus: setStatus });
        // Device-wide BLE offline mesh (ADR 0012). The shared node owns it: register the radio
        // once and the transport auto-arms the mesh when the fleet path drops — so EVERY bound
        // app (scala/qaku/kym) keeps syncing over Bluetooth with no mesh code of its own.
        try { transport.setMeshRadio(LoamMeshRadio.available() ? () => new LoamMeshRadio() : null); } catch { /* */ }
        setFg("foreground service: " + (await startKeepAlive()));
        await initServiceBridge(() => setTick((n) => n + 1));
      } catch (e: any) { setStatus("error: " + String((e && e.message) || e)); }
    })();
    const t = setInterval(async () => {
      try { await transport.refreshPeerInfo(); } catch { /* */ }
      const c = transport.counters;
      // Edge has no relay mesh by design (filter/lightpush) — report deliverable peers
      // as "mesh" so clients read Edge as connected, not "forming". Core keeps real mesh.
      const edge = transport.getNodeMode() === "Edge";
      const meshVal = edge && c.peers > 0 ? c.peers : c.mesh;
      setInfo(`peers ${c.peers}   mesh ${c.mesh}${edge ? " (edge)" : ""}   rx ${c.rxRaw}`);
      pushMetrics(c.peers, meshVal);   // expose to bound clients over AIDL
      // BLE offline mesh state (ADR 0012) — armed? how many Bluetooth peers?
      const t = transport as any;
      const armed = t.meshEnabled?.() ?? false;
      setMesh(armed ? `armed · ${t.meshPeers?.() ?? 0} BLE peer(s)${t.meshForcedOn?.() ? " · forced" : ""}` : "off");
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const pick = async (m: Mode) => { try { await SecureStore.setItemAsync("logos-delivery-nodemode", m); } catch { /* */ } setMode(m); };
  const { pending, granted } = serviceBridgeAvailable() ? lists() : { pending: [] as Client[], granted: [] as any[] };

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.c}>
      <Text style={s.title}>Logos Delivery</Text>
      <Text style={s.sub}>shared node · one per phone</Text>
      <View style={s.card}>
        <Text style={s.status}>{status}</Text>
        <Text style={s.info}>{info}</Text>
        <Text style={[s.info, mesh !== "off" && { color: "#7ee787" }]}>BLE offline mesh: {mesh}</Text>
        <Text style={s.fg}>{fg}</Text>
      </View>

      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>FORCE OFFLINE MESH (BLE)</Text>
          <Text style={s.hint}>Auto-arms when the fleet drops. Force it on to test the Bluetooth mesh with the internet up.</Text>
        </View>
        <Switch
          value={meshForced}
          onValueChange={(v) => { setMeshForced(v); try { (transport as any).forceMesh?.(v); } catch { /* */ } }}
        />
      </View>

      <Text style={s.label}>NODE MODE</Text>
      <View style={s.row}>
        {(["Edge", "Core"] as Mode[]).map((m) => (
          <TouchableOpacity key={m} style={[s.chip, mode === m && s.chipOn]} onPress={() => pick(m)}>
            <Text style={[s.chipT, mode === m && s.chipTOn]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.hint}>{mode === "Edge" ? "Edge (default) — light on battery & data; works on mobile and WiFi. Relaunch to apply." : "Core — relays the shard for the network; best on stable WiFi/power. Relaunch to apply."}</Text>

      {pending.length > 0 && <>
        <Text style={s.label}>REQUESTS</Text>
        {pending.map((c) => (
          <View key={c.callerKey} style={s.reqCard}>
            <Text style={s.appName}>{c.label}</Text>
            <Text style={s.appMeta}>{c.pkg}{"\n"}id {c.appId} · cert {shortCert(c.cert)}</Text>
            <Text style={s.ask}>wants to use the shared node</Text>
            <View style={s.row2}>
              <TouchableOpacity style={[s.btn, s.deny]} onPress={() => deny(c.callerKey)}><Text style={s.btnT}>Deny</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.allow]} onPress={() => approve(c.callerKey)}><Text style={[s.btnT, { color: "#fff" }]}>Allow</Text></TouchableOpacity>
            </View>
          </View>
        ))}
      </>}

      <Text style={s.label}>APPROVED APPS {granted.length ? `(${granted.length})` : ""}</Text>
      {granted.length === 0
        ? <Text style={s.empty}>No apps approved yet. When an app asks, you'll see a request above.</Text>
        : granted.map((g: any) => (
          <View key={g.callerKey} style={s.grantRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.appName}>{g.label}</Text>
              <Text style={s.appMeta}>{g.pkg} · {shortCert(g.cert)}</Text>
              {/* Offline cache: hold this app's messages while it's closed, so it
                  doesn't have to re-sync everything on reopen. */}
              <View style={s.cacheRow}>
                <Switch
                  value={g.cache !== false}
                  onValueChange={(v) => setCache(g.callerKey, v)}
                  trackColor={{ true: "#0b8f9c", false: "#3a2530" }}
                />
                <Text style={s.cacheLabel}>
                  {g.cache === false ? "Cache off" : `Cache while closed · ${g.buffered} waiting`}
                </Text>
              </View>
            </View>
            <TouchableOpacity style={[s.btn, s.deny]} onPress={() => revoke(g.callerKey)}><Text style={s.btnT}>Revoke</Text></TouchableOpacity>
          </View>
        ))}

      <Text style={s.note}>Apps you approve sync through this one node. Traffic stays end-to-end encrypted per app — the service only moves sealed bytes. “Cache while closed” lets the node hold an app's messages while it isn't running, so it opens faster with less re-sync.</Text>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#0d1117" },
  c: { alignItems: "center", padding: 24, paddingTop: 64, paddingBottom: 48 },
  title: { color: "#e6e9ef", fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  sub: { color: "#28c2d1", fontSize: 13, marginBottom: 22, fontFamily: "monospace", letterSpacing: 1 },
  card: { backgroundColor: "#151b23", borderColor: "#252d38", borderWidth: 1, borderRadius: 14, paddingVertical: 18, paddingHorizontal: 26, alignItems: "center", minWidth: 280 },
  status: { color: "#e6e9ef", fontSize: 17, marginBottom: 6 },
  info: { color: "#8b94a3", fontSize: 13, fontFamily: "monospace" },
  fg: { color: "#28c2d1", fontSize: 12, fontFamily: "monospace", marginTop: 6 },
  label: { color: "#57616e", fontSize: 11, fontFamily: "monospace", letterSpacing: 1.5, marginTop: 26, marginBottom: 8, alignSelf: "flex-start" },
  row: { flexDirection: "row", gap: 10, alignSelf: "flex-start" },
  row2: { flexDirection: "row", gap: 10, marginTop: 12 },
  chip: { borderColor: "#252d38", borderWidth: 1, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 26 },
  chipOn: { backgroundColor: "#0b8f9c", borderColor: "#0b8f9c" },
  chipT: { color: "#8b94a3", fontSize: 15, fontWeight: "700" }, chipTOn: { color: "#fff" },
  hint: { color: "#57616e", fontSize: 11, marginTop: 8, alignSelf: "flex-start" },
  reqCard: { backgroundColor: "#151b23", borderColor: "#0b8f9c", borderWidth: 1, borderRadius: 12, padding: 16, width: "100%", marginBottom: 10 },
  appName: { color: "#e6e9ef", fontSize: 16, fontWeight: "700" },
  appMeta: { color: "#8b94a3", fontSize: 11, fontFamily: "monospace", marginTop: 3 },
  cacheRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  cacheLabel: { color: "#8a7580", fontSize: 12 },
  ask: { color: "#28c2d1", fontSize: 13, marginTop: 8 },
  btn: { flex: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center" },
  allow: { backgroundColor: "#0b8f9c" }, deny: { borderColor: "#3a2530", borderWidth: 1, backgroundColor: "#1a1116", flex: 0, paddingHorizontal: 20 },
  btnT: { color: "#c99", fontSize: 14, fontWeight: "700" },
  grantRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#151b23", borderColor: "#252d38", borderWidth: 1, borderRadius: 12, padding: 14, width: "100%", marginBottom: 8, gap: 10 },
  empty: { color: "#57616e", fontSize: 13, alignSelf: "flex-start", lineHeight: 18 },
  note: { color: "#57616e", fontSize: 11, marginTop: 32, textAlign: "center", lineHeight: 17 },
});
