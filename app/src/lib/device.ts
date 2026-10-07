// Stable per-install device id (the HLC `dev` tiebreak, logs, telemetry). Persisted in SecureStore
// so it survives restarts. Since loam-transport ADR 0022 it is NOT the SDS sender id and not the
// Bluetooth id: both used to carry it in the clear (sender ids are now per topic, keyed by
// getSenderSecret below; the Bluetooth id is random and rotates).
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id = await SecureStore.getItemAsync("logos-delivery-device-id");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await SecureStore.setItemAsync("logos-delivery-device-id", id);
  }
  cached = id;
  return id;
}

// Random per-install secret that keys the per-topic SDS sender ids (loam-transport ADR 0022), so
// a phone's apps and rooms don't share one sender id in the clear on Waku. Never leaves the phone.
let cachedSecret: string | null = null;
export async function getSenderSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  let s = await SecureStore.getItemAsync("loam-sds-sender-secret");
  if (!s) {
    const b = await Crypto.getRandomBytesAsync(32);
    s = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    await SecureStore.setItemAsync("loam-sds-sender-secret", s);
  }
  cachedSecret = s;
  return s;
}
