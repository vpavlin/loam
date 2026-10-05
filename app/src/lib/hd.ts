// Vendored from loam-keycard src/hd.ts (ADR 0001) — keep in sync; C++ twin: loam-basecamp core/src/loam_hd.hpp.
// loam-keycard — deterministic, unlinkable identities from one root (ADR 0001).
//
// One root per person: a BIP39 phrase (software) or a Keycard. Every identity is a HARDENED BIP32
// child in the EIP-1581 (non-wallet keys) tree, so derived keys can't be shown to share a root:
//
//   main identity          m/43'/60'/1581'/0'/0'
//   (app, context)         m/43'/60'/1581'/A'/C0'/C1'/C2'/C3'
//     A  = idx31(sha256("loam-app:" + appId))[0]
//     C* = idx31(sha256("loam-ctx:" + appId + ":" + contextId))[0..3]
//   idx31 = the first 16 bytes as four big-endian uint32, each & 0x7FFFFFFF — the same scheme as
//   paths.ts (domainToIndices), so C++ (loam_core) and the Keycard reproduce it bit-for-bit.
//
// On a Keycard the same sub-path is used under the non-exportable 1582' subtree (signPathFor). A
// software root uses 1581'. The address is the app-wide Loam address: "0x" + hex(sha256(pub33))[24:64].
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha256 } from "@noble/hashes/sha256";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function idx31(seed: string): [number, number, number, number] {
  const h = sha256(enc(seed));
  const at = (o: number) => (((h[o] << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) & 0x7fffffff);
  return [at(0), at(4), at(8), at(12)];
}

/** The identity a space uses: the shared "main" identity, or one derived for (app, context). */
export type IdentityRef = { kind: "main" } | { kind: "context"; appId: string; contextId: string };

/** Hardened indices below the purpose/coin/1581' prefix, for an identity. */
export function subPath(ref: IdentityRef): number[] {
  if (ref.kind === "main") return [0, 0];
  if (!ref.appId || !ref.contextId) throw new Error("appId and contextId are required");
  return [idx31("loam-app:" + ref.appId)[0], ...idx31("loam-ctx:" + ref.appId + ":" + ref.contextId)];
}

/** Software-root path (EIP-1581, 1581'). */
export function keyPathFor(ref: IdentityRef): string {
  return "m/43'/60'/1581'/" + subPath(ref).map((i) => i + "'").join("/");
}

/** Keycard signing path (non-exportable 1582' subtree): the card derives and signs on-card. */
export function signPathFor(ref: IdentityRef): string {
  return "m/43'/60'/1582'/" + subPath(ref).map((i) => i + "'").join("/");
}

/** Loam address of a compressed (33-byte) secp256k1 public key. */
export function addressOf(pub33: Uint8Array): string {
  return "0x" + hex(sha256(pub33)).slice(24, 64);
}

export interface DerivedIdentity { path: string; priv: Uint8Array; pubHex: string; address: string }

/** A software root: the BIP32 master key from a BIP39 phrase (optional passphrase). */
export class HdRoot {
  private readonly master: HDKey;
  private constructor(master: HDKey) { this.master = master; }

  static fromMnemonic(mnemonic: string, passphrase = ""): HdRoot {
    const m = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
    if (!validateMnemonic(m, wordlist)) throw new Error("invalid recovery phrase");
    return new HdRoot(HDKey.fromMasterSeed(mnemonicToSeedSync(m, passphrase)));
  }

  /** Derive the identity for `ref`. Hardened all the way, so siblings and the root stay hidden. */
  derive(ref: IdentityRef): DerivedIdentity {
    const path = keyPathFor(ref);
    const k = this.master.derive(path);
    if (!k.privateKey || !k.publicKey) throw new Error("derivation failed");
    return { path, priv: k.privateKey, pubHex: hex(k.publicKey), address: addressOf(k.publicKey) };
  }
}

/** A new 12-word recovery phrase (128 bits). */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidMnemonic(m: string): boolean {
  return validateMnemonic(m.trim().toLowerCase().split(/\s+/).join(" "), wordlist);
}

