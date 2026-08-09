// The app-side shim — how each app's logos-transport becomes a thin client of the
// shared node, WITH a standalone fallback so nothing breaks during migration.
//
// This is the drop-in replacement for the current global-singleton logos-transport:
// same surface the app already calls (join/subscribe/send/onReceive), but backed by
// either the shared service (preferred) or an embedded node (fallback).
//
//   if the Logos Delivery service is installed  ->  bind to it, we are a tenant
//   else                                        ->  embed our own RealNode (today's behaviour)
//
// The app above this line never learns which mode it's in.

// import { NativeModules } from "react-native";  // { LogosDeliveryClient } binds the AIDL service
// import { RealNode } from "../src/real-node.mjs";
// import { SharedDeliveryNode } from "../src/broker.mjs";

export async function createTransport({ appId, config, onReceive }) {
  const svc = await tryBindService();       // AIDL proxy, or null if not installed
  if (svc) {
    // SHARED path: register as a tenant of the device-wide node.
    await svc.registerClient(appId, { onMessage: onReceive });
    return {
      mode: "shared",
      subscribe: (t) => svc.subscribe(appId, t),
      channelCreate: (t, sender) => svc.channelCreate(appId, t, sender),
      send: (t, p) => svc.channelSend(appId, t, p),
      storeQuery: (q, cursor) => svc.storeQuery(appId, q, cursor),
      metrics: () => svc.metrics(),
      close: () => svc.close(appId),
    };
  }

  // FALLBACK path: no service -> embed our own node in-process (exactly today's app).
  // Different process from any other app, so the 1-process-1-node rule is satisfied.
  const { RealNode } = await import("../src/real-node.mjs");
  const { SharedDeliveryNode } = await import("../src/broker.mjs");
  const shared = new SharedDeliveryNode(new RealNode(config));
  await shared.start();
  const tenant = shared.registerTenant(appId).onMessage((t, p) => onReceive(t, p));
  return {
    mode: "embedded",
    subscribe: (t) => tenant.subscribe(t),
    channelCreate: (_t, _s) => {},              // handled inside RealNode.subscribe
    send: (t, p) => tenant.send(t, p),
    storeQuery: async () => { throw new Error("wire storeQuery on RealNode"); },
    metrics: () => shared.node.metrics(),
    close: () => tenant.close(),
  };
}

async function tryBindService() {
  // On RN: NativeModules.LogosDeliveryClient?.bind() -> resolves the AIDL proxy or null
  // if the co.logos.delivery service package isn't installed / permission denied.
  return null; // sketch: default to fallback until the service ships
}
