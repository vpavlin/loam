// Loam's HD root (loam-keycard ADR 0001): one 12-word phrase on this phone → unlinkable identities per
// (app, space) plus one shared "main" identity. Loam holds the root; apps only ask for an identity or
// a signature over AIDL (service-bridge "hd" requests), and only for their own app namespace.
//
// The phrase lives in Expo SecureStore (Android Keystore-backed). The derived root is cached in
// memory after first use (BIP39 → seed is ~2048 rounds of PBKDF2 in JS, too slow per signature).
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { secp256k1 } from "@noble/curves/secp256k1";
import { HdRoot, isValidMnemonic, type IdentityRef } from "./hd";

const KEY = "loam-hd-mnemonic";
const MAIN_KEY = "loam-hd-main";   // public: the main identity's {address,pubHex}, readable without deriving

let root: HdRoot | null = null;
const listeners = new Set<() => void>();
export function onHdChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((f) => { try { f(); } catch { /* */ } });

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16));

async function loadRoot(): Promise<HdRoot | null> {
  if (root) return root;
  const m = await SecureStore.getItemAsync(KEY);
  if (!m) return null;
  root = HdRoot.fromMnemonic(m);
  return root;
}

async function save(mnemonic: string): Promise<{ mainAddress: string }> {
  const r = HdRoot.fromMnemonic(mnemonic);
  const main = r.derive({ kind: "main" });
  await SecureStore.setItemAsync(KEY, mnemonic);
  await SecureStore.setItemAsync(MAIN_KEY, JSON.stringify({ address: main.address, pubHex: main.pubHex }));
  root = r;
  changed();
  return { mainAddress: main.address };
}

export async function hdStatus(): Promise<{ exists: boolean; mainAddress?: string; mainPubHex?: string }> {
  const raw = await SecureStore.getItemAsync(MAIN_KEY);
  if (!raw) return { exists: !!(await SecureStore.getItemAsync(KEY)) };
  const m = JSON.parse(raw);
  return { exists: true, mainAddress: m.address, mainPubHex: m.pubHex };
}

/** A new root. Returns the 12 words ONCE so the user can write them down. */
export async function hdCreate(): Promise<{ mnemonic: string; mainAddress: string }> {
  if (await SecureStore.getItemAsync(KEY)) throw new Error("a root already exists");
  const mnemonic = entropyToMnemonic(await Crypto.getRandomBytesAsync(16), wordlist);
  const r = await save(mnemonic);
  return { mnemonic, mainAddress: r.mainAddress };
}

export async function hdImport(mnemonic: string): Promise<{ mainAddress: string }> {
  if (await SecureStore.getItemAsync(KEY)) throw new Error("a root already exists");
  const m = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  if (!isValidMnemonic(m)) throw new Error("invalid recovery phrase");
  return save(m);
}

export async function hdExport(): Promise<string> {
  const m = await SecureStore.getItemAsync(KEY);
  if (!m) throw new Error("no root");
  return m;
}

export async function hdForget(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
  await SecureStore.deleteItemAsync(MAIN_KEY);
  root = null;
  changed();
}

function refFor(appId: string, contextId: string): IdentityRef {
  return contextId ? { kind: "context", appId, contextId } : { kind: "main" };
}

export async function hdIdentity(appId: string, contextId: string): Promise<{ address: string; pubHex: string; path: string }> {
  const r = await loadRoot();
  if (!r) throw new Error("no root");
  const d = r.derive(refFor(appId, contextId));
  return { address: d.address, pubHex: d.pubHex, path: d.path };
}

/** 64-byte r||s (low-S) over a raw 32-byte digest — the same format loam_core's hdSign returns. */
export async function hdSign(appId: string, contextId: string, digestHex: string): Promise<{ sig: string; pub: string; address: string }> {
  if (!/^[0-9a-fA-F]{64}$/.test(digestHex)) throw new Error("digest must be 32 bytes hex");
  const r = await loadRoot();
  if (!r) throw new Error("no root");
  const d = r.derive(refFor(appId, contextId));
  const sig = secp256k1.sign(hexToBytes(digestHex), d.priv, { lowS: true, prehash: false });
  d.priv.fill(0);
  return { sig: sig.toCompactHex(), pub: d.pubHex, address: d.address };
}

/** Answer one AIDL hd request for an approved app (`appId` comes from the approval record). */
export async function hdHandle(appId: string, requestJson: string): Promise<unknown> {
  let req: { op?: string; contextId?: string; digestHex?: string };
  try { req = JSON.parse(requestJson); } catch { return { error: "bad request" }; }
  try {
    if (req.op === "status") return await hdStatus();
    if (req.op === "identity") return await hdIdentity(appId, req.contextId || "");
    if (req.op === "sign") return await hdSign(appId, req.contextId || "", req.digestHex || "");
    return { error: "unknown op" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

