# 2. Consent is per app, keyed by the caller's real identity

- **Status:** accepted
- **Date:** 2026-08

## Context

A shared node is a shared surface: any app on the phone could try to bind it, subscribe
to topics, and publish. We need the phone's owner to control **which apps** may use the
node — and an app must not be able to impersonate another to inherit its grant or read
its traffic.

## Decision

The service trusts **nothing the caller says about itself**. It resolves the calling
app's **package name and signing certificate from the binder UID** (`Binder.getCallingUid`
→ `getPackagesForUid` → signing cert), and keys both the broker tenant and the user's
consent grant by **`package + cert`**. The owner approves each app once ("Allow App X?");
grants persist and are revocable. A repackaged or re-signed app is a **different, unapproved
identity**.

Until approved, a caller reveals nothing: metrics return `{authorized:false}`, subscribes
are buffered, sends are dropped — and the attempt raises a consent prompt.

The service is a **blind pipe**: it only ever moves **opaque sealed bytes** (the app does
its own end-to-end crypto), so an approved app's traffic is unreadable to the service and
to other apps regardless. Consent controls *use of the node*, not access to plaintext —
there is none to access.

## Rejected

- **Trust a self-declared app id** — trivially spoofable; the binder UID is the only
  thing the caller can't lie about.
- **Package name alone** — a re-signed clone would share the grant; the cert pins identity.
- **No consent (open node)** — one app could sniff another's topic metadata / inject
  traffic; the grant is the boundary.

## Consequences

- The owner has an auditable, revocable list of which apps use the node.
- Identity is stable across updates (same key) but breaks on re-sign — intentional.
- See [`SECURITY.md`](../../SECURITY.md) for the full threat model.
