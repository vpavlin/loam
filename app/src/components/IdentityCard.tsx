// Loam identity card (loam-keycard ADR 0001): set up the ONE root this phone keeps for all your Loam apps.
// Create (shows the 12 words once) or restore from 12 words; then show the main identity — the one you
// share with family and friends — with copy. Each app's other identities are derived on demand and never
// listed here (listing them together would be exactly the link the design avoids).
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { hdStatus, hdCreate, hdImport, hdExport, hdForget, onHdChange } from "../lib/hd-root";

const C = {
  surface: "#1E1813", tileMid: "#2C2318", tileTop: "#3A2E20",
  ink: "#ECE5D6", inkSoft: "#A08E76", inkFaint: "#7C6D58", green: "#5CB636", clay: "#D2894E",
};

type St = { exists: boolean; mainAddress?: string; mainPubHex?: string };

export function IdentityCard() {
  const [st, setSt] = useState<St | null>(null);
  const [words, setWords] = useState<string | null>(null);      // shown once after create / on reveal
  const [restoring, setRestoring] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const refresh = () => { hdStatus().then(setSt).catch(() => setSt({ exists: false })); };
  useEffect(() => { refresh(); return onHdChange(refresh); }, []);

  const run = async (fn: () => Promise<void>) => {
    setErr(""); setBusy(true);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const copy = async (label: string, v: string) => {
    try { await Clipboard.setStringAsync(v); setCopied(label); setTimeout(() => setCopied(""), 1500); } catch { /* */ }
  };

  if (!st) return null;

  // Freshly created / revealed words: the only time they're on screen.
  if (words) {
    const list = words.split(" ");
    return (
      <View style={s.card}>
        <Text style={s.name}>Your recovery words</Text>
        <Text style={s.why}>Write these 12 words down, in order, and keep them somewhere safe. They restore every identity on a new phone or computer. Anyone who has them can act as you.</Text>
        <View style={s.grid}>
          {list.map((w, i) => (
            <View key={i} style={s.word}><Text style={s.wordN}>{i + 1}</Text><Text style={s.wordT}>{w}</Text></View>
          ))}
        </View>
        <TouchableOpacity style={[s.btn, s.primary]} onPress={() => setWords(null)}>
          <Text style={[s.btnT, { color: "#14100C" }]}>I've written them down</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!st.exists) {
    return (
      <View style={s.card}>
        <Text style={s.name}>Your identity</Text>
        <Text style={s.why}>One set of 12 recovery words gives you a separate identity in every app and every shared calendar or room, so they can't be linked, plus one main identity you share with people you know.</Text>
        {restoring ? (
          <>
            <TextInput style={s.input} value={draft} onChangeText={setDraft} placeholder="your 12 recovery words" placeholderTextColor={C.inkFaint}
              autoCapitalize="none" autoCorrect={false} multiline />
            <View style={s.row}>
              <TouchableOpacity style={[s.btn, s.primary]} disabled={busy} onPress={() => run(async () => { await hdImport(draft); setDraft(""); setRestoring(false); })}>
                <Text style={[s.btnT, { color: "#14100C" }]}>{busy ? "Restoring…" : "Restore"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.ghost]} onPress={() => { setRestoring(false); setErr(""); }}>
                <Text style={s.btnT}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View style={s.row}>
            <TouchableOpacity style={[s.btn, s.primary]} disabled={busy} onPress={() => run(async () => { const r = await hdCreate(); setWords(r.mnemonic); })}>
              <Text style={[s.btnT, { color: "#14100C" }]}>{busy ? "Creating…" : "Create"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.ghost]} onPress={() => setRestoring(true)}>
              <Text style={s.btnT}>I have recovery words</Text>
            </TouchableOpacity>
          </View>
        )}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
    );
  }

  const addr = st.mainAddress || "";
  const link = st.mainPubHex ? `loam://id?pub=${st.mainPubHex}` : "";
  return (
    <View style={s.card}>
      <Text style={s.name}>Your identity</Text>
      <Text style={s.why}>Main identity — share it with family and friends so they can add you to calendars and contacts. Each app also gets its own separate identities for everything else.</Text>
      <TouchableOpacity onPress={() => copy("address", addr)}>
        <Text style={s.mono} selectable>{addr}</Text>
        <Text style={s.hint}>{copied === "address" ? "copied ✓" : "⧉ copy address"}</Text>
      </TouchableOpacity>
      {link ? (
        <TouchableOpacity onPress={() => copy("link", link)}>
          <Text style={s.hint}>{copied === "link" ? "copied ✓" : "⧉ copy identity link (for contacts)"}</Text>
        </TouchableOpacity>
      ) : null}
      <View style={s.row}>
        <TouchableOpacity style={[s.btn, s.ghost]} onPress={() =>
          Alert.alert("Show recovery words?", "Make sure nobody can see your screen.", [
            { text: "Cancel", style: "cancel" },
            { text: "Show", onPress: () => run(async () => setWords(await hdExport())) },
          ])}>
          <Text style={s.btnT}>Show recovery words</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.ghost]} onPress={() =>
          Alert.alert("Remove identity from this phone?", "Your apps lose these identities here until you restore the 12 words. Without the words they are gone for good.", [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => run(hdForget) },
          ])}>
          <Text style={[s.btnT, { color: C.clay }]}>Remove</Text>
        </TouchableOpacity>
      </View>
      {err ? <Text style={s.err}>{err}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.surface, borderColor: C.tileMid, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 12 },
  name: { color: C.ink, fontSize: 16, fontWeight: "700" },
  why: { color: C.inkFaint, fontSize: 12, lineHeight: 18, marginTop: 8 },
  mono: { color: C.ink, fontSize: 13, fontFamily: "monospace", marginTop: 12 },
  hint: { color: C.inkSoft, fontSize: 12, marginTop: 4 },
  row: { flexDirection: "row", gap: 10, marginTop: 14 },
  btn: { flex: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center" },
  primary: { backgroundColor: C.green },
  ghost: { borderColor: C.tileTop, borderWidth: 1, backgroundColor: C.tileMid },
  btnT: { color: C.inkSoft, fontSize: 14, fontWeight: "700" },
  input: { color: C.ink, borderColor: C.tileTop, borderWidth: 1, borderRadius: 9, padding: 10, marginTop: 12, minHeight: 70, fontFamily: "monospace" },
  err: { color: C.clay, fontSize: 12, marginTop: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  word: { width: "31%", flexDirection: "row", gap: 6, backgroundColor: C.tileMid, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 8 },
  wordN: { color: C.inkFaint, fontSize: 12, fontFamily: "monospace", width: 18 },
  wordT: { color: C.ink, fontSize: 14, fontWeight: "600" },
});
