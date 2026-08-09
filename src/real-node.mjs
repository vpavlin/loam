// RealNode — the PHONE path.  (Sketch: runs on-device inside RN, not in the node demo.)
//
// Same UnderlyingNode contract as MockNode, but backed by the existing arm64 JNI
// bridge (the `LogosMessaging` React Native native module the apps already ship —
// byte-identical across qaku and kym). This is the "one adapter away from running on
// hardware" piece: drop it in place of MockNode and SharedDeliveryNode is unchanged.
//
// It lives wherever the single node lives: inside the Logos Delivery *service* (the
// shared-node deployment), or inside an app as the standalone *fallback* when the
// service isn't installed. Both are the same code — the node is process-global, so
// whichever process hosts it owns the one node (see docs: 1 process = 1 node).
//
// Every mapping below is a fact confirmed in the FFI research: the node is ctx-based
// (one opaque handle threaded through calls), subscribe auto-shards, and ALL receives
// (relay + SDS channel) arrive on ONE global "logosMessage" event that we demux here.

/* eslint-disable */
// import { NativeModules, NativeEventEmitter } from "react-native";
// const { LogosMessaging } = NativeModules;

export class RealNode {
  constructor(config) {
    this.config = config;       // { mode:"Core"|"Edge", preset, entryNodes, ... }
    this.ctx = null;            // opaque node handle from new()
    this.recvCb = null;
    this._emitter = null;
  }

  async start() {
    const M = this._M();
    await M.setup();                          // loads libs once (lazy)
    this.ctx = await M.new(this.config);      // create node -> handle
    await M.start(this.ctx);
    // ONE global receive stream; broker demuxes by contentTopic.
    this._emitter = new this._Emitter(M);
    this._emitter.addListener("logosMessage", (m) => {
      const contentTopic = m.contentTopic || m.channelId;
      // payload decode mirrors the apps' payloadCandidates()/double-base64 handling.
      const payload = this._decodePayload(m);
      if (this.recvCb && contentTopic) this.recvCb(contentTopic, payload);
    });
  }

  onReceive(cb) { this.recvCb = cb; }

  // ctx threaded through EVERY call — passing the topic where ctx belongs crashes
  // the bridge (BigInteger(topic).toLong() -> NumberFormatException). Never do that.
  async subscribe(contentTopic) {
    const M = this._M();
    await M.subscribeContentTopic(this.ctx, contentTopic); // auto-shards
    await M.channelCreate(this.ctx, contentTopic, contentTopic, this.config.deviceId);
  }

  async unsubscribe(contentTopic) {
    // FFI has logosdelivery_unsubscribe; the Kotlin @ReactMethod is not yet bridged.
    // TODO(bridge): add unsubscribeContentTopic to LogosMessagingModule.kt.
    const M = this._M();
    if (M.unsubscribeContentTopic) await M.unsubscribeContentTopic(this.ctx, contentTopic);
  }

  async send(contentTopic, payload) {
    const M = this._M();
    // apps send via channelSend for SDS ordering; raw send() also available.
    await M.channelSend(this.ctx, contentTopic, this._encodePayload(payload));
  }

  async metrics() {
    const M = this._M();
    return { raw: await M.getNodeInfo(this.ctx, "Metrics") };
  }

  // --- glue stubs (wired to react-native at build time) ---
  _M() { throw new Error("RealNode: bind LogosMessaging (react-native NativeModules) at build time"); }
  _Emitter() { throw new Error("RealNode: bind NativeEventEmitter at build time"); }
  _encodePayload(bytes) { return bytes; }   // + base64/double-base64 per the apps' convention
  _decodePayload(m) { return m.payload; }   // + payloadCandidates() decode
}
