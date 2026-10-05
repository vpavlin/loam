package co.logos.delivery.svc

import co.logos.delivery.ILogosDeliveryCallback
import java.util.concurrent.ConcurrentHashMap

// In-process bridge between the AIDL Service (binder threads) and the RN/JS transport.
// Everything is keyed by callerKey = "<package>|<signingCertSha256>", resolved server-side
// from the binder identity — NOT by any client-supplied id (which would be spoofable).
object DeliveryHub {
  val callbacks = ConcurrentHashMap<String, ILogosDeliveryCallback>()  // callerKey -> cb
  @Volatile var toJs: ((kind: String, data: Map<String, String?>) -> Unit)? = null
  @Volatile var metricsJson: String = "{}"   // node peers/mesh, refreshed by the JS timer
  @Volatile var authorized: Set<String> = emptySet()   // callerKeys the owner has approved
  fun isAuthorized(ck: String) = authorized.contains(ck)

  // Requests issued while the RN/JS side is DOWN (toJs == null) were silently lost: an app that
  // binds & subscribes BEFORE Loam's node/JS is up (Loam wasn't originally running) never got wired
  // up, and nothing replayed it when the JS attached — so it never re-subscribed. Buffer such
  // requests and replay them in order once the JS connects (flushPending, from DeliveryBridgeModule).
  private val pending = ArrayList<Pair<String, Map<String, String?>>>()
  private fun dispatch(kind: String, data: Map<String, String?>) {
    val cb = toJs
    if (cb != null) { cb(kind, data); return }
    synchronized(pending) { if (pending.size < 1024) pending.add(kind to data) }
  }
  fun flushPending() {
    if (toJs == null) return
    val drain: List<Pair<String, Map<String, String?>>>
    synchronized(pending) { if (pending.isEmpty()) return; drain = ArrayList(pending); pending.clear() }
    for ((kind, data) in drain) { val cb = toJs ?: break; try { cb(kind, data) } catch (_: Throwable) {} }
  }

  // An unapproved caller touched us (e.g. read metrics) — (re)surface the approval request.
  // Transient (a fresh metrics poll re-issues it), so NOT buffered.
  fun touch(ck: String, pkg: String, cert: String, label: String) =
    toJs?.invoke("touch", mapOf("callerKey" to ck, "pkg" to pkg, "cert" to cert, "label" to label))

  fun register(callerKey: String, cb: ILogosDeliveryCallback, appId: String, pkg: String, cert: String, label: String) {
    callbacks[callerKey] = cb
    dispatch("register", mapOf("callerKey" to callerKey, "appId" to appId, "pkg" to pkg, "cert" to cert, "label" to label))
  }
  fun subscribe(callerKey: String, topic: String) { dispatch("subscribe", mapOf("callerKey" to callerKey, "topic" to topic)) }
  fun send(callerKey: String, topic: String, sealedB64: String) { dispatch("send", mapOf("callerKey" to callerKey, "topic" to topic, "sealedB64" to sealedB64)) }
  // Trigger a cold-start history pull for this client — the JS side runs waku_store_query
  // and pushes each stored message back through the receive callback (like a live message).
  fun requestStoreSync(callerKey: String) { dispatch("storeSync", mapOf("callerKey" to callerKey)) }
  fun unregister(callerKey: String) {
    callbacks.remove(callerKey)
    synchronized(pending) { pending.removeAll { it.second["callerKey"] == callerKey } }  // drop its un-flushed requests
    dispatch("unregister", mapOf("callerKey" to callerKey))
  }

  // HD identity requests: a reply comes back from the JS (hdReply) and is matched by reqId. Buffered like
  // other requests while the JS is down; a request nobody answers is dropped after 60 s.
  private val hdPending = ConcurrentHashMap<String, Pair<co.logos.delivery.IHdCallback, Long>>()
  private val hdSeq = java.util.concurrent.atomic.AtomicLong(0)
  fun hdCall(callerKey: String, requestJson: String, cb: co.logos.delivery.IHdCallback) {
    val now = System.currentTimeMillis()
    hdPending.entries.removeIf { now - it.value.second > 60_000 }
    val id = "hd" + hdSeq.incrementAndGet()
    hdPending[id] = cb to now
    dispatch("hd", mapOf("callerKey" to callerKey, "reqId" to id, "request" to requestJson))
  }
  fun hdReply(reqId: String, resultJson: String) {
    val p = hdPending.remove(reqId) ?: return
    try { p.first.onResult(resultJson) } catch (_: Throwable) { /* client died */ }
  }

  fun deliver(callerKey: String, topic: String, candidatesJson: String) {
    try { callbacks[callerKey]?.onMessage(topic, candidatesJson) } catch (_: Throwable) { /* client died */ }
  }
}
