# 1. The shared node must live in its own process (service + AIDL)

- **Status:** accepted
- **Date:** 2026-08 (foundational)

## Context

Every Logos app embeds its own `liblogosdelivery` (Waku) node. Three apps on a phone
= three nodes: three meshes, three discovery loops, three copies of relaying the same
shard, three wakelocks — sharing nothing. It already bit us (kym runs with discv5 off
so it doesn't collide with qaku on UDP 9000). We want **one node per phone**.

The obvious "shared singleton library each app loads" does **not** work: the decisive
constraint is that `liblogosdelivery` keeps **process-global** persistency state — a
second `createNode` in the same process fails with *"persistency already initialized,"*
and destroy doesn't release it. **One process = one node.** A library loaded into N app
processes is N nodes.

## Decision

The shared node lives in **its own Android foreground service** (`co.logos.delivery`),
and apps are **IPC clients** that bind it over **AIDL**. The service owns exactly one
node behind the `logos-transport` broker; each bound app is a **tenant** that registers
its content topics and receives only its own traffic. A `dataSync` foreground service +
wakelock keeps the one node alive for everyone.

## Rejected

- **Singleton library per app** — the process-global constraint makes it N nodes, not one.
- **A user-space daemon / separate APK with no UI** — Android has no clean always-on
  daemon story; a foreground service is the supported "keep one process alive" mechanism,
  and a tiny UI is where per-app consent (ADR 0002) lives anyway.

## Consequences

- One mesh, one discovery loop, one relay of the shard, one wakelock — shared by all apps.
- Everything is IPC: bind/unbind lifecycle, per-tenant routing, and the offline cache
  (ADR 0003) all hang off the AIDL boundary. The node's process outliving any single app
  is the property the cache depends on.
