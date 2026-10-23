// StorageCard — Logos Storage in Loam (loam-transport ADR 0020): one fetch client for the phone that
// apps (Backpack, later Scala…) use for files, as background jobs that keep going when the app closes.
// Shows what it's doing and lets the owner turn it off or clear its cache.
import React, { useEffect, useState } from "react";
import { View, Text, Switch, TouchableOpacity, NativeModules, Alert } from "react-native";

const LS: any = (NativeModules as any).LoamStorage;

interface Job { cid: string; state: string; bytes?: number; total?: number; apps?: string[] }
interface Info { enabled?: boolean; state?: string; running?: boolean; online?: boolean; cacheBytes?: number; cacheFiles?: number; cacheCap?: number; jobs?: Job[]; nodeError?: string }

const mb = (n = 0) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const STATE: Record<string, { label: string; color: string }> = {
  off: { label: "off", color: "#7C6D58" },
  idle: { label: "idle", color: "#7C6D58" },
  running: { label: "ready", color: "#5CB636" },
  fetching: { label: "downloading", color: "#5CB636" },
  failed: { label: "failed", color: "#D2894E" },
};

export function StorageCard({ s, C }: { s: any; C: any }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    if (!LS) return;
    let live = true;
    const poll = async () => { try { const i = JSON.parse(await LS.info()); if (live) setInfo(i); } catch { /* */ } };
    poll(); const iv = setInterval(poll, 2000);
    return () => { live = false; clearInterval(iv); };
  }, []);
  if (!LS) return null;
  const st = STATE[info?.state ?? "idle"] ?? STATE.idle;
  const enabled = info?.enabled !== false;
  const jobs = info?.jobs ?? [];

  return (
    <View style={s.bearer}>
      <View style={s.bHead}>
        <View style={[s.dot, { backgroundColor: st.color }]} />
        <Text style={s.bName}>Logos Storage</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.bState}>{st.label}</Text>
      </View>
      <Text style={s.bStats}>
        {!enabled ? "off — apps use their own Storage node"
          : info?.state === "failed" ? `node failed: ${info.nodeError ?? "?"}`
          : info?.running ? `node running · ${info.online ? "online" : "offline"}`
          : "starts when an app asks for a file"}
      </Text>
      {jobs.map((j) => {
        const pct = j.total ? Math.floor(((j.bytes ?? 0) / j.total) * 100) : 0;
        return (
          <View key={j.cid} style={{ marginTop: 8 }}>
            <Text style={[s.bStats, { marginTop: 0 }]} numberOfLines={1}>
              {`${(j.apps ?? []).map((a) => a.split(".").pop()).join(", ") || "app"} · …${j.cid.slice(-8)} · ${j.state === "queued" ? "queued" : `${mb(j.bytes)} / ${mb(j.total)} · ${pct}%`}`}
            </Text>
            <View style={{ height: 5, borderRadius: 3, backgroundColor: C.tileTop, overflow: "hidden", marginTop: 4 }}>
              <View style={{ height: 5, width: `${pct}%`, backgroundColor: C.green }} />
            </View>
          </View>
        );
      })}
      <Text style={[s.bStats, { color: C.inkFaint }]}>
        {`cache ${mb(info?.cacheBytes)} of ${mb(info?.cacheCap)} · ${info?.cacheFiles ?? 0} file${info?.cacheFiles === 1 ? "" : "s"}`}
      </Text>
      <View style={s.ctrlRow}>
        <Text style={s.ctrlLabel}>Run Storage for apps</Text>
        <Switch value={enabled} trackColor={{ true: "#4E8A3C", false: "#3A2E20" }}
          onValueChange={async (on) => { await LS.setEnabled(on); setInfo((i) => ({ ...(i ?? {}), enabled: on, state: on ? "idle" : "off" })); }} />
      </View>
      <TouchableOpacity style={{ marginTop: 10 }} disabled={!info?.cacheBytes}
        onPress={() => Alert.alert("Clear the Storage cache?", "Files apps already downloaded through Loam are deleted; apps download them again when they need them.", [
          { text: "Cancel", style: "cancel" },
          { text: "Clear", style: "destructive", onPress: async () => { await LS.clearCache(); } },
        ])}>
        <Text style={{ color: info?.cacheBytes ? C.clay : C.inkFaint, fontSize: 13, fontWeight: "700" }}>Clear cache</Text>
      </TouchableOpacity>
      <Text style={s.why}>
        Files from Logos Storage, for every app that asks. Downloads run here, in Loam's background
        service, so they keep going when the app that asked is closed, and a file fetched once is served
        to any app from this phone's cache. Loam only moves bytes: each app checks what it gets (Backpack
        checks the signature and checksum of every APK). Turn it off and apps fall back to their own node.
      </Text>
    </View>
  );
}
