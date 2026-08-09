// shardFor — RFC-51 autosharding, ported VERBATIM from the mobile apps'
// logos-transport.ts so the prototype's shard math matches production exactly.
//
//   parts = contentTopic.split("/")  ->  ["", app, version, name, enc]
//   shard = sha256(app + version)[24..31] as big-endian u64  %  count
//
// This is what makes qaku ("/qaku/1/…") land on shard 0 and kym ("/kym/1/…")
// on shard 7 — the two-shard case a single shared node has to span.
import { createHash } from "node:crypto";

export function shardFor(contentTopic, count = 8) {
  const parts = contentTopic.split("/"); // ["", app, version, name, enc]
  if (parts.length < 3) return -1;
  const h = createHash("sha256").update(parts[1] + parts[2], "utf8").digest();
  let val = 0n;
  for (let i = 24; i < 32; i++) val = (val << 8n) | BigInt(h[i]);
  return Number(val % BigInt(count));
}
