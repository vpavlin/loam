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
  // An unapproved caller touched us (e.g. read metrics) — (re)surface the approval request.
  fun touch(ck: String, pkg: String, cert: String, label: String) =
    toJs?.invoke("touch", mapOf("callerKey" to ck, "pkg" to pkg, "cert" to cert, "label" to label))

  fun register(callerKey: String, cb: ILogosDeliveryCallback, appId: String, pkg: String, cert: String, label: String) {
    callbacks[callerKey] = cb
    toJs?.invoke("register", mapOf("callerKey" to callerKey, "appId" to appId, "pkg" to pkg, "cert" to cert, "label" to label))
  }
  fun subscribe(callerKey: String, topic: String) { toJs?.invoke("subscribe", mapOf("callerKey" to callerKey, "topic" to topic)) }
  fun send(callerKey: String, topic: String, sealedB64: String) { toJs?.invoke("send", mapOf("callerKey" to callerKey, "topic" to topic, "sealedB64" to sealedB64)) }
  // Trigger a cold-start history pull for this client — the JS side runs waku_store_query
  // and pushes each stored message back through the receive callback (like a live message).
  fun requestStoreSync(callerKey: String) { toJs?.invoke("storeSync", mapOf("callerKey" to callerKey)) }
  fun unregister(callerKey: String) { callbacks.remove(callerKey); toJs?.invoke("unregister", mapOf("callerKey" to callerKey)) }

  fun deliver(callerKey: String, topic: String, candidatesJson: String) {
    try { callbacks[callerKey]?.onMessage(topic, candidatesJson) } catch (_: Throwable) { /* client died */ }
  }
}
