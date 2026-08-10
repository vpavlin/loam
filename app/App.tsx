import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import * as transport from "./src/lib/logos-transport";
import { getDeviceId } from "./src/lib/device";
import { startKeepAlive } from "./src/lib/keepalive";

// Increment 1: a standalone app that runs ONE liblogosdelivery node (via the shared
// logos-transport) inside a foreground service. This IS the device-wide node, so its
// Core/Edge choice is the whole phone's battery/data setting. AIDL (other apps bind) is next.
const PROBE_TOPIC = "/logos-delivery/1/probe/proto";
type Mode = "Core" | "Edge";

export default function App() {
  const [status, setStatus] = useState("starting…");
  const [fg, setFg] = useState("foreground service: …");
  const [info, setInfo] = useState("");
  const [mode, setMode] = useState<Mode>("Core");   // the mode the node STARTED with
  useEffect(() => {
    (async () => {
      try {
        // Core/Edge is read only at node start — load + apply BEFORE transport.start.
        let m: Mode = "Core";
        try { m = ((await SecureStore.getItemAsync("logos-delivery-nodemode")) as Mode) || "Core"; } catch { /* */ }
        setMode(m); transport.setNodeMode(m);
        try { await Notifications.requestPermissionsAsync(); } catch { /* */ }
        const deviceId = await getDeviceId();
        await transport.start({ deviceId, topics: [PROBE_TOPIC], onReceive: () => false, onStatus: setStatus });
        setFg("foreground service: " + (await startKeepAlive()));
      } catch (e: any) { setStatus("error: " + String((e && e.message) || e)); }
    })();
    const t = setInterval(async () => {
      try { await transport.refreshPeerInfo(); } catch { /* */ }
      const c = transport.counters;
      setInfo(`peers ${c.peers}   mesh ${c.mesh}   rx ${c.rxRaw}`);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  // Persist a new mode; it takes effect on next launch (mode is read at node start).
  const pick = async (m: Mode) => { try { await SecureStore.setItemAsync("logos-delivery-nodemode", m); } catch { /* */ } setMode(m); };

  return (
    <View style={s.c}>
      <Text style={s.title}>Logos Delivery</Text>
      <Text style={s.sub}>shared node · one per phone</Text>
      <View style={s.card}>
        <Text style={s.status}>{status}</Text>
        <Text style={s.info}>{info}</Text>
        <Text style={s.fg}>{fg}</Text>
      </View>

      <Text style={s.label}>NODE MODE</Text>
      <View style={s.row}>
        {(["Core", "Edge"] as Mode[]).map((m) => (
          <TouchableOpacity key={m} style={[s.chip, mode === m && s.chipOn]} onPress={() => pick(m)}>
            <Text style={[s.chipT, mode === m && s.chipTOn]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.hint}>{mode === "Edge"
        ? "Edge: lighter on battery/data — no shard relay, publishes via lightpush. Relaunch to apply."
        : "Core: full relay node — the reliable default for the device-wide node. Relaunch to apply a change."}</Text>

      <Text style={s.note}>Increment 1 — standalone node in a foreground service.{"\n"}Next: AIDL so qaku &amp; kym bind to this one node.</Text>
    </View>
  );
}
const s = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0d1117", alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#e6e9ef", fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  sub: { color: "#28c2d1", fontSize: 13, marginBottom: 24, fontFamily: "monospace", letterSpacing: 1 },
  card: { backgroundColor: "#151b23", borderColor: "#252d38", borderWidth: 1, borderRadius: 14, paddingVertical: 20, paddingHorizontal: 28, alignItems: "center", minWidth: 260 },
  status: { color: "#e6e9ef", fontSize: 18, marginBottom: 8 },
  info: { color: "#8b94a3", fontSize: 13, fontFamily: "monospace" },
  fg: { color: "#28c2d1", fontSize: 12, fontFamily: "monospace", marginTop: 8 },
  label: { color: "#57616e", fontSize: 11, fontFamily: "monospace", letterSpacing: 1.5, marginTop: 28, marginBottom: 8 },
  row: { flexDirection: "row", gap: 10 },
  chip: { borderColor: "#252d38", borderWidth: 1, borderRadius: 9, paddingVertical: 9, paddingHorizontal: 28 },
  chipOn: { backgroundColor: "#0b8f9c", borderColor: "#0b8f9c" },
  chipT: { color: "#8b94a3", fontSize: 15, fontWeight: "700" },
  chipTOn: { color: "#ffffff" },
  hint: { color: "#57616e", fontSize: 11, marginTop: 10, textAlign: "center", lineHeight: 16, maxWidth: 300 },
  note: { color: "#57616e", fontSize: 12, marginTop: 30, textAlign: "center", lineHeight: 18 },
});
