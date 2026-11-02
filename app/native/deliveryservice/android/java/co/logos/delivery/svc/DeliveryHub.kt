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
  @Volatile var metricsAt: Long = 0L         // when the JS last pushed metrics (0 = never)
  @Volatile var jsAttached: Boolean = false  // the JS listener is attached (jsReady), so requests reach it

  // What each CONNECTED app told us (Loam 0.0.66). This layer outlives Loam's JS: when the JS restarts
  // (headless boot -> UI, a reload), it lost every register/subscribe it had, and nothing told it again,
  // so an app looked connected but got nothing (its subscribes were queued, its store pulls dropped).
  // On every jsReady we replay register + subscribe for each connected app from here. Bounded per app.
  data class ClientInfo(val appId: String, val pkg: String, val cert: String, val label: String)
  private val clients = ConcurrentHashMap<String, ClientInfo>()
  private val topics = ConcurrentHashMap<String, MutableSet<String>>()
  private const val MAX_TOPICS_PER_APP = 256
  @Volatile var authorized: Set<String> = emptySet()   // callerKeys the owner has approved
  fun isAuthorized(ck: String) = authorized.contains(ck)

  // Requests issued while the RN/JS side is DOWN (toJs == null) were silently lost: an app that
  // binds & subscribes BEFORE Loam's node/JS is up (Loam wasn't originally running) never got wired
  // up, and nothing replayed it when the JS attached — so it never re-subscribed. Buffer such
  // requests and replay them in order once the JS connects (flushPending, from DeliveryBridgeModule).
  // Bounded by count AND bytes (audit L-4): an app that binds while Loam's JS is down must not be able
  // to grow this without limit. Sends from unapproved callers never get here (LogosDeliveryService).
  private val pending = ArrayList<Pair<String, Map<String, String?>>>()
  private var pendingBytes = 0L
  private const val PENDING_MAX = 1024
  private const val PENDING_MAX_BYTES = 8L shl 20
  private fun dispatch(kind: String, data: Map<String, String?>) {
    val cb = toJs
    if (cb != null) { cb(kind, data); return }
    val size = sizeOf(data)
    synchronized(pending) {
      if (pending.size < PENDING_MAX && pendingBytes + size <= PENDING_MAX_BYTES) { pending.add(kind to data); pendingBytes += size }
    }
  }
  private fun sizeOf(data: Map<String, String?>) = data.values.sumOf { (it?.length ?: 0).toLong() }
  fun flushPending() {
    if (toJs == null) return
    jsAttached = true
    replayClients()
    val drain: List<Pair<String, Map<String, String?>>>
    synchronized(pending) { if (pending.isEmpty()) return; drain = ArrayList(pending); pending.clear(); pendingBytes = 0 }
    for ((kind, data) in drain) { val cb = toJs ?: break; try { cb(kind, data) } catch (_: Throwable) {} }
  }

  // An unapproved caller touched us (e.g. read metrics) — (re)surface the approval request.
  // Transient (a fresh metrics poll re-issues it), so NOT buffered.
  fun touch(ck: String, pkg: String, cert: String, label: String) =
    toJs?.invoke("touch", mapOf("callerKey" to ck, "pkg" to pkg, "cert" to cert, "label" to label))

  // Replay every connected app's register + topics to a (new) JS. Sent straight to the JS, not buffered:
  // flushPending runs only once toJs is set. Duplicates of buffered requests are harmless (idempotent).
  private fun replayClients() {
    val cb = toJs ?: return
    for ((ck, c) in clients) {
      if (!callbacks.containsKey(ck)) continue
      try { cb("register", mapOf("callerKey" to ck, "appId" to c.appId, "pkg" to c.pkg, "cert" to c.cert, "label" to c.label)) } catch (_: Throwable) {}
      for (t in topicsOf(ck)) try { cb("subscribe", mapOf("callerKey" to ck, "topic" to t, "live" to "1")) } catch (_: Throwable) {}
    }
  }
  private fun topicsOf(ck: String): List<String> = topics[ck]?.let { synchronized(it) { it.toList() } } ?: emptyList()

  fun register(callerKey: String, cb: ILogosDeliveryCallback, appId: String, pkg: String, cert: String, label: String) {
    callbacks[callerKey] = cb
    clients[callerKey] = ClientInfo(appId, pkg, cert, label)
    features.remove(callerKey)   // it asks again (setClientFeatures) if it supports more
    dispatch("register", mapOf("callerKey" to callerKey, "appId" to appId, "pkg" to pkg, "cert" to cert, "label" to label))
  }
  // live = this app has a callback here, so the JS may treat an already-approved app as connected even if
  // it never saw the register (it missed it): it activates the app instead of queueing the subscribe.
  fun subscribe(callerKey: String, topic: String) {
    val set = topics.getOrPut(callerKey) { java.util.Collections.synchronizedSet(LinkedHashSet()) }
    synchronized(set) { if (set.size < MAX_TOPICS_PER_APP || set.contains(topic)) set.add(topic) }
    dispatch("subscribe", mapOf("callerKey" to callerKey, "topic" to topic, "live" to if (callbacks.containsKey(callerKey)) "1" else "0"))
  }
  fun unsubscribe(callerKey: String, topic: String) {
    topics[callerKey]?.let { synchronized(it) { it.remove(topic) } }
    dispatch("unsubscribe", mapOf("callerKey" to callerKey, "topic" to topic))
  }

  // What the service holds for this app, answered at once (clientState). `missing` = topics the client
  // believes it joined that never reached us (it should subscribe them again).
  fun clientState(callerKey: String, clientTopicsJson: String): String {
    val o = org.json.JSONObject()
    val authorized = isAuthorized(callerKey)
    o.put("authorized", authorized)
    o.put("registered", callbacks.containsKey(callerKey))
    o.put("js", toJs != null && jsAttached)
    var peers = -1
    try { val m = org.json.JSONObject(metricsJson); if (m.has("peers")) peers = m.optInt("peers", -1) } catch (_: Throwable) {}
    val fresh = metricsAt > 0 && System.currentTimeMillis() - metricsAt < 30_000
    o.put("node", fresh && peers > 0)
    o.put("peers", if (fresh) peers else -1)
    val have = topicsOf(callerKey).toHashSet()
    o.put("topics", have.size)
    val missing = org.json.JSONArray()
    if (authorized) try {
      val a = org.json.JSONArray(clientTopicsJson)
      for (i in 0 until minOf(a.length(), MAX_TOPICS_PER_APP)) { val t = a.optString(i, ""); if (t.isNotEmpty() && !have.contains(t)) missing.put(t) }
    } catch (_: Throwable) {}
    o.put("missing", missing)
    return o.toString()
  }
  // A store pull that says whether it was taken. While Loam's JS is coming up the request is buffered
  // (replayed on jsReady), so it is accepted with queued:true.
  fun requestStoreSyncChecked(callerKey: String): String {
    val o = org.json.JSONObject()
    when {
      !isAuthorized(callerKey) -> { o.put("accepted", false); o.put("reason", "not approved in Loam") }
      !callbacks.containsKey(callerKey) -> { o.put("accepted", false); o.put("reason", "not registered") }
      else -> {
        requestStoreSync(callerKey)
        o.put("accepted", true); o.put("topics", topicsOf(callerKey).size)
        if (toJs == null || !jsAttached) o.put("queued", true)
      }
    }
    return o.toString()
  }
  fun send(callerKey: String, topic: String, sealedB64: String) { dispatch("send", mapOf("callerKey" to callerKey, "topic" to topic, "sealedB64" to sealedB64)) }
  // Trigger a cold-start history pull for this client — the JS side runs waku_store_query
  // and pushes each stored message back through the receive callback (like a live message).
  fun requestStoreSync(callerKey: String) { dispatch("storeSync", mapOf("callerKey" to callerKey)) }
  fun unregister(callerKey: String) {
    callbacks.remove(callerKey)
    clients.remove(callerKey); topics.remove(callerKey)   // a reconnecting app registers + subscribes again
    synchronized(pending) {   // drop its un-flushed requests, and their bytes (re-check R-2)
      val gone = pending.filter { it.second["callerKey"] == callerKey }
      pending.removeAll(gone.toSet()); pendingBytes -= gone.sumOf { sizeOf(it.second) }
    }
    dispatch("unregister", mapOf("callerKey" to callerKey))
  }

  // HD identity requests: a reply comes back from the JS (hdReply) and is matched by reqId. Buffered like
  // other requests while the JS is down; a request nobody answers is dropped after 60 s.
  private val hdPending = ConcurrentHashMap<String, Pair<co.logos.delivery.IHdCallback, Long>>()
  private val hdSeq = java.util.concurrent.atomic.AtomicLong(0)
  fun hdCall(callerKey: String, requestJson: String, cb: co.logos.delivery.IHdCallback) {
    val now = System.currentTimeMillis()
    hdPending.entries.removeIf { now - it.value.second > 60_000 }
    if (hdPending.size >= 64) { try { cb.onResult("{\"error\":\"busy\"}") } catch (_: Throwable) {}; return }   // audit L-11
    val id = "hd" + hdSeq.incrementAndGet()
    hdPending[id] = cb to now
    dispatch("hd", mapOf("callerKey" to callerKey, "reqId" to id, "request" to requestJson))
  }
  fun hdReply(reqId: String, resultJson: String) {
    val p = hdPending.remove(reqId) ?: return
    try { p.first.onResult(resultJson) } catch (_: Throwable) { /* client died */ }
  }

  // Features each client asked for and we serve (setClientFeatures): 1 = onMessageMeta.
  private val features = java.util.concurrent.ConcurrentHashMap<String, Int>()
  const val FEATURE_META = 1
  fun setFeatures(callerKey: String, requested: Int): Int {
    val f = requested and FEATURE_META
    features[callerKey] = f
    return f
  }

  fun deliver(callerKey: String, topic: String, candidatesJson: String) = deliverMeta(callerKey, topic, candidatesJson, null)

  // With meta (network timestamp + source) to a client that asked for it; the plain onMessage otherwise,
  // so an older client never receives a callback it doesn't implement.
  fun deliverMeta(callerKey: String, topic: String, candidatesJson: String, metaJson: String?) {
    try {
      val cb = callbacks[callerKey] ?: return
      if (metaJson != null && ((features[callerKey] ?: 0) and FEATURE_META) != 0) cb.onMessageMeta(topic, candidatesJson, metaJson)
      else cb.onMessage(topic, candidatesJson)
    } catch (_: Throwable) { /* client died */ }
  }
}
