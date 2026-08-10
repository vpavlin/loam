import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import * as transport from "./logos-transport";

const Bridge = (NativeModules as any).LogosDeliveryBridge;
const emitter = Bridge ? new NativeEventEmitter(Bridge) : null;
export function serviceBridgeAvailable(): boolean { return !!Bridge; }

// Wire incoming AIDL binder calls to the multi-tenant transport. Call AFTER the node is up.
// Each bound client app becomes one broker Tenant; received messages are forwarded back
// as JSON arrays of base64 candidates (the client opens with its own key — service stays opaque).
export function startServiceBridge(onClients?: (n: number) => void): boolean {
  if (!Bridge || !emitter) return false;
  const clients = new Set<string>();
  emitter.addListener("logosDeliveryRequest", async (r: any) => {
    try {
      if (r.kind === "register") {
        clients.add(r.appId); onClients && onClients(clients.size);
        transport.registerClient(r.appId, (topic: string, cands: Uint8Array[]) => {
          Bridge.deliver(r.appId, topic, JSON.stringify(cands.map((c) => fromByteArray(c))));
          return true;
        });
      } else if (r.kind === "subscribe") {
        await transport.clientSubscribe(r.appId, r.topic);
      } else if (r.kind === "send") {
        await transport.publishSealed(r.topic, toByteArray(r.sealedB64));
      } else if (r.kind === "unregister") {
        clients.delete(r.appId); onClients && onClients(clients.size);
        await transport.unregisterClient(r.appId);
      }
    } catch { /* never throw in the bridge */ }
  });
  return true;
}
