// Runnable proof of the shared-node thesis.  `node demo/demo.mjs`
//
// Proves, without any arm64 node, the four things the architecture claims:
//   1. ONE node spans MULTIPLE shards (qaku shard 0 + kym shard 7) at once.
//   2. Each app receives ONLY its own topic's traffic (routing isolation).
//   3. A per-app AEAD key means a mis-delivered foreign payload is unreadable anyway
//      (defence in depth — the real isolation boundary).
//   4. Node subscriptions are refcounted: dropped only when the last owner leaves.
import { SharedDeliveryNode } from "../src/broker.mjs";
import { MockNode } from "../src/mock-node.mjs";
import { shardFor } from "../src/shard.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗ FAIL"}  ${msg}`); };
const enc = new TextEncoder(), dec = new TextDecoder();

// A stand-in for each app's per-key AEAD envelope: XOR-seal with the tenant key.
// (Real apps use XChaCha20-Poly1305; the point is only that keys differ per app.)
const seal = (key, s) => { const b = enc.encode(s); for (let i=0;i<b.length;i++) b[i]^=key; return b; };
const open = (key, b) => { const c = Uint8Array.from(b, x=>x^key); return dec.decode(c); };

const line = (t) => console.log("\n" + t);

// Two genuine app content topics. Only parts[1]+parts[2] (app+version) drive the
// shard, so these are the real qaku/kym namespaces.
const QAKU = "/qaku/1/room-demo/proto";
const KYM  = "/kym/1/budget-demo/proto";
const QKEY = 0x5a, KKEY = 0xa5;

const node = new MockNode();
const shared = new SharedDeliveryNode(node);
await shared.start();

line("── 1. One node, two apps, two shards ──────────────────────────");
console.log(`  shardFor("${QAKU}") = ${shardFor(QAKU)}`);
console.log(`  shardFor("${KYM}")  = ${shardFor(KYM)}`);
ok(shardFor(QAKU) === 0, "qaku topic hashes to shard 0");
ok(shardFor(KYM)  === 7, "kym topic hashes to shard 7");

const qakuRx = [], kymRx = [];
const qaku = shared.registerTenant("qaku").onMessage((t,p) => qakuRx.push(open(QKEY,p)));
const kym  = shared.registerTenant("kym").onMessage((t,p) => kymRx.push(open(KKEY,p)));
await qaku.subscribe(QAKU);
await kym.subscribe(KYM);

console.log(`  node now spans shards: {${shared.shardsInUse().join(", ")}}  on a SINGLE node`);
ok(JSON.stringify(shared.shardsInUse()) === "[0,7]", "one node spans shards 0 AND 7 simultaneously");

line("── 2. Each app receives only its own traffic ──────────────────");
await qaku.send(QAKU, seal(QKEY, "who let the ducks out?"));
await kym.send(KYM,  seal(KKEY, "-42.00 groceries"));
await new Promise(r => setTimeout(r, 10)); // let microtask round-trips settle

console.log(`  qaku received: ${JSON.stringify(qakuRx)}`);
console.log(`  kym  received: ${JSON.stringify(kymRx)}`);
ok(qakuRx.length === 1 && qakuRx[0] === "who let the ducks out?", "qaku got its message");
ok(kymRx.length  === 1 && kymRx[0]  === "-42.00 groceries",     "kym got its message");
ok(!qakuRx.includes("-42.00 groceries"), "qaku did NOT receive kym's message");
ok(!kymRx.includes("who let the ducks out?"), "kym did NOT receive qaku's message");

line("── 3. Payload isolation (defence in depth) ────────────────────");
// Suppose the broker mis-routed a kym payload to qaku. qaku opens with its own key:
const foreign = seal(KKEY, "-42.00 groceries");
const garbled = open(QKEY, foreign);
ok(garbled !== "-42.00 groceries", `foreign payload opened with wrong key is garbage: ${JSON.stringify(garbled)}`);

line("── 4. Unowned topic is dropped, and refcounted teardown ───────");
const before = qakuRx.length + kymRx.length;
await node.send("/other/9/x/proto", seal(0x11, "stranger")); // nobody subscribed
await new Promise(r => setTimeout(r, 10));
ok((qakuRx.length + kymRx.length) === before, "message on an unsubscribed topic reaches no one");

const subsBefore = node.subs.size;
await qaku.close();
console.log(`  after qaku.close(): node topics ${subsBefore} -> ${node.subs.size}, shards {${shared.shardsInUse().join(", ")}}`);
ok(!node.subs.has(QAKU), "closing qaku unsubscribed its topic from the node");
ok(node.subs.has(KYM), "kym's subscription survived (independent tenant)");

line("── underlying node call log (what the ONE node actually did) ──");
node.log.forEach((l) => console.log("   · " + l));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  —  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
