// MockNode — an in-memory UnderlyingNode for tests/demos on any machine.
//
// It stands in for the single real Waku node: it tracks which content topics are
// subscribed (and therefore which shards the node spans), and it loops every
// send() back to the global receive stream IFF that topic is currently subscribed
// — modelling "you (and everyone on the mesh) receive messages on topics the node
// has joined." That's enough to exercise the broker's routing, isolation, and
// refcounting without an arm64 node.
import { shardFor } from "./shard.mjs";

export class MockNode {
  constructor() {
    this.subs = new Set();          // content topics the node has joined
    this.recvCb = null;
    this.log = [];                  // observability for the demo
  }

  async start() { this.log.push("node.start"); }

  onReceive(cb) { this.recvCb = cb; }

  async subscribe(contentTopic) {
    this.subs.add(contentTopic);
    this.log.push(`node.subscribe ${contentTopic}  (shard ${shardFor(contentTopic)})`);
  }

  async unsubscribe(contentTopic) {
    this.subs.delete(contentTopic);
    this.log.push(`node.unsubscribe ${contentTopic}`);
  }

  async send(contentTopic, payload) {
    this.log.push(`node.send ${contentTopic}  (${payload.length}B, shard ${shardFor(contentTopic)})`);
    // Model the round-trip: a message is delivered to the node's global receive
    // stream only if the node is actually joined to that topic.
    if (this.subs.has(contentTopic) && this.recvCb) {
      queueMicrotask(() => this.recvCb(contentTopic, payload));
    }
  }

  async metrics() {
    const shards = [...new Set([...this.subs].map((t) => shardFor(t)))].sort();
    return { subscribedTopics: this.subs.size, shards };
  }
}
