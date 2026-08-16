// loam-telemetry — the offline-first debugging channel. The interesting Loam bugs happen while the
// phone is OFF the network (BLE-only, dead zones), where you can't watch live. So: buffer diagnostic
// snapshots to disk continuously, and the moment the fleet is reachable again, seal + publish them on
// a dedicated telemetry topic. A watcher (logos-hub / loam-core, see test/tools/telemetry-watch.mjs)
// subscribes and decodes — so a device's offline→online story is observable without the user ever
// retyping a stat. OPT-IN: inert unless EXPO_PUBLIC_TELEMETRY_SECRET is set (a pre-shared debug
// secret the watcher also holds). Never on by default — telemetry is diagnostics, and it ships
// ciphertext only (the topic + key derive from the secret; nobody without it can read it).
import * as FileSystem from "expo-file-system";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import * as Crypto from "expo-crypto";
import * as transport from "./logos-transport";

const SECRET = process.env.EXPO_PUBLIC_TELEMETRY_SECRET || "";
export function telemetryEnabled(): boolean { return !!SECRET; }

const enc = (s: string) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

// Derive the telemetry topic + payload key from the pre-shared secret. The watcher runs the SAME
// derivation, so it and only it can subscribe to the topic and open the snapshots.
const K = SECRET ? hkdf(sha256, enc(SECRET), enc("loam-telemetry-v1"), new Uint8Array(0), 32) : new Uint8Array(32);
const Ke = hkdf(sha256, K, new Uint8Array(0), enc("loam-telemetry/payload/v1"), 32);
export const TELEMETRY_TOPIC = `/loam-telemetry/1/${SECRET ? hex(hmac(sha256, K, enc("loam-telemetry/topic/v1")).slice(0, 16)) : "off"}/proto`;

function seal(plaintext: Uint8Array): Uint8Array {
  const nonce = Crypto.getRandomBytes(12);
  const ct = chacha20poly1305(Ke, nonce, enc(TELEMETRY_TOPIC)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return out; // nonce(12) || ciphertext||tag
}

let deviceId = "";
export function setDevice(id: string): void { deviceId = id; }

const BUF = (FileSystem.documentDirectory || "") + "loam-telemetry-buf.json";
const CAP = 500; // bounded ring — an offline phone can't grow this without limit
let buf: any[] = [];
let loaded = false;
async function load(): Promise<void> {
  if (loaded) return;
  try { const i = await FileSystem.getInfoAsync(BUF); if (i.exists) { const a = JSON.parse(await FileSystem.readAsStringAsync(BUF)); if (Array.isArray(a)) buf = a; } } catch { /* */ }
  loaded = true;
}
async function persist(): Promise<void> { try { await FileSystem.writeAsStringAsync(BUF, JSON.stringify(buf)); } catch { /* */ } }

// Append a snapshot to the durable offline buffer (drops oldest past CAP). Cheap; call on a timer.
export async function record(snap: Record<string, any>): Promise<void> {
  if (!SECRET) return;
  await load();
  buf.push({ t: new Date().toISOString(), dev: deviceId, ...snap });
  while (buf.length > CAP) buf.shift();
  await persist();
}

// Flush the buffer to the telemetry topic. Call ONLY when the fleet is reachable (netUp) — a
// telemetry write must reach the fleet for the watcher to see it, not just the BLE mesh. Best-effort:
// clears only what it managed to publish; anything new (or a mid-flush failure) survives for next time.
let flushing = false;
export async function flush(): Promise<number> {
  if (!SECRET || flushing) return 0;
  await load();
  if (buf.length === 0) return 0;
  flushing = true;
  try {
    const pending = buf.slice();
    let sent = 0;
    for (const s of pending) {
      try { await transport.publishSealed(TELEMETRY_TOPIC, seal(enc(JSON.stringify(s)))); sent++; }
      catch { break; } // fleet went away mid-flush — keep the rest
    }
    buf = buf.slice(sent); // drop exactly what we sent; later records (appended during flush) remain
    await persist();
    return sent;
  } finally { flushing = false; }
}

// How many snapshots are waiting to be flushed (for a UI badge).
export async function buffered(): Promise<number> { await load(); return buf.length; }
