import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import * as Notifications from "expo-notifications";
import * as transport from "./src/lib/logos-transport";
import { getDeviceId } from "./src/lib/device";
import { startKeepAlive } from "./src/lib/keepalive";

// Increment 1: a standalone app that runs ONE liblogosdelivery node (via the shared
// logos-transport) inside a foreground service. No IPC yet — this proves the node comes
// up in its own app and survives backgrounding. AIDL (so other apps bind) is next.
const PROBE_TOPIC = "/logos-delivery/1/probe/proto";

export default function App() {
  const [status, setStatus] = useState("starting…");
  const [fg, setFg] = useState("foreground service: …");
  const [info, setInfo] = useState("");
  useEffect(() => {
    (async () => {
      try {
        // Android 13+ requires POST_NOTIFICATIONS at runtime, or the foreground-service
        // notification is silently suppressed (and the service can't keep us alive).
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
  return (
    <View style={s.c}>
      <Text style={s.title}>Logos Delivery</Text>
      <Text style={s.sub}>shared node · one per phone</Text>
      <View style={s.card}>
        <Text style={s.status}>{status}</Text>
        <Text style={s.info}>{info}</Text>
        <Text style={s.fg}>{fg}</Text>
      </View>
      <Text style={s.note}>Increment 1 — standalone node in a foreground service.{"\n"}Next: AIDL so qaku &amp; kym bind to this one node.</Text>
    </View>
  );
}
const s = StyleSheet.create({
  c: { flex: 1, backgroundColor: "#0d1117", alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#e6e9ef", fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  sub: { color: "#28c2d1", fontSize: 13, marginBottom: 28, fontFamily: "monospace", letterSpacing: 1 },
  card: { backgroundColor: "#151b23", borderColor: "#252d38", borderWidth: 1, borderRadius: 14, paddingVertical: 20, paddingHorizontal: 28, alignItems: "center", minWidth: 260 },
  status: { color: "#e6e9ef", fontSize: 18, marginBottom: 8 },
  info: { color: "#8b94a3", fontSize: 13, fontFamily: "monospace" },
  fg: { color: "#28c2d1", fontSize: 12, fontFamily: "monospace", marginTop: 8 },
  note: { color: "#57616e", fontSize: 12, marginTop: 36, textAlign: "center", lineHeight: 18 },
});
