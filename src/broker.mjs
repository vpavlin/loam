// SharedDeliveryNode — the multi-tenant broker.
//
// This is the seam the whole "one node per phone" architecture hinges on: a single
// underlying Waku node, wrapped so that N independent apps ("tenants") can each
// register their own content topics and receive ONLY their own traffic.
//
// It is deliberately transport-agnostic. The underlying node is any object matching
// the UnderlyingNode contract below — a MockNode (in-memory, for tests) or a RealNode
// (the arm64 JNI bridge, on a phone). Nothing here is app-specific: no crypto, no
// topic scheme, no app id. That all lives in each tenant, above this layer.
//
//   UnderlyingNode = {
//     start(): Promise<void>
//     subscribe(contentTopic): Promise<void>      // idempotent; auto-shards
//     unsubscribe(contentTopic): Promise<void>
//     send(contentTopic, payload: Uint8Array): Promise<void>
//     onReceive(cb: (contentTopic, payload) => void): void   // ONE global stream
//     metrics(): Promise<object>
//   }
//
// The real FFI already exposes every one of these (subscribe/send/storeQuery/
// getNodeInfo + a single global "logosMessage" event). The only thing missing in
// native code is receive-side demux — which is exactly what this broker adds.

import { shardFor } from "./shard.mjs";

export class SharedDeliveryNode {
  /** @param {object} node an UnderlyingNode implementation */
  constructor(node) {
    this.node = node;
    this.started = false;
    /** contentTopic -> Set<tenantId>  (the routing table) */
    this.owners = new Map();
    /** tenantId -> Tenant */
    this.tenants = new Map();
    // ONE global receive handler for the whole device; demux by content topic.
    this.node.onReceive((contentTopic, payload) => this._route(contentTopic, payload));
  }

  async start() {
    if (this.started) return;
    await this.node.start();
    this.started = true;
  }

  /** A client app calls this once to get its handle. On a phone, the returned
   *  Tenant is an IPC proxy; here it's a direct object. */
  registerTenant(tenantId) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const t = new Tenant(this, tenantId);
    this.tenants.set(tenantId, t);
    return t;
  }

  // ---- internal: called by Tenant ----

  async _subscribe(tenantId, contentTopic) {
    let set = this.owners.get(contentTopic);
    if (!set) {
      set = new Set();
      this.owners.set(contentTopic, set);
      // First owner of this topic -> actually subscribe the underlying node.
      await this.node.subscribe(contentTopic);
    }
    set.add(tenantId);
  }

  async _unsubscribe(tenantId, contentTopic) {
    const set = this.owners.get(contentTopic);
    if (!set) return;
    set.delete(tenantId);
    if (set.size === 0) {
      // Last owner released -> unsubscribe the node (refcounted).
      this.owners.delete(contentTopic);
      await this.node.unsubscribe(contentTopic);
    }
  }

  async _send(contentTopic, payload) {
    await this.node.send(contentTopic, payload);
  }

  _route(contentTopic, payload) {
    const set = this.owners.get(contentTopic);
    if (!set || set.size === 0) return; // foreign / unowned topic -> dropped
    for (const tenantId of set) {
      const t = this.tenants.get(tenantId);
      if (t) t._deliver(contentTopic, payload);
    }
  }

  /** Every distinct shard the node currently spans, derived from live topics.
   *  On a real Core node these are the shard meshes it must graft into. */
  shardsInUse() {
    const s = new Set();
    for (const topic of this.owners.keys()) s.add(shardFor(topic));
    return [...s].sort((a, b) => a - b);
  }
}

export class Tenant {
  constructor(broker, id) {
    this.broker = broker;
    this.id = id;
    this.topics = new Set();
    this.cb = null;
  }

  onMessage(cb) { this.cb = cb; return this; }

  async subscribe(contentTopic) {
    this.topics.add(contentTopic);
    await this.broker._subscribe(this.id, contentTopic);
  }

  async send(contentTopic, payload) {
    // A tenant may only publish on a topic it has subscribed — cheap guard that
    // also documents intent. (The real security boundary is the per-app AEAD key.)
    if (!this.topics.has(contentTopic)) {
      throw new Error(`tenant ${this.id} tried to send on unsubscribed topic ${contentTopic}`);
    }
    await this.broker._send(contentTopic, payload);
  }

  async close() {
    for (const topic of this.topics) await this.broker._unsubscribe(this.id, topic);
    this.topics.clear();
    this.broker.tenants.delete(this.id);
    this.cb = null;
  }

  _deliver(contentTopic, payload) {
    if (this.cb) this.cb(contentTopic, payload);
  }
}
