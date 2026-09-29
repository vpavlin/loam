package co.logos.delivery.svc

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class DeliveryBridgeModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "LogosDeliveryBridge"

  init {
    DeliveryHub.toJs = { kind, data ->
      val params = Arguments.createMap().apply {
        putString("kind", kind)
        for ((k, v) in data) putString(k, v)
      }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("logosDeliveryRequest", params)
      } catch (_: Throwable) { /* JS not ready */ }
    }
  }

  // Called by the JS AFTER it has attached its `logosDeliveryRequest` listener (initServiceBridge).
  // Only now is it safe to replay requests that were buffered while the node/JS was down (an app that
  // bound & subscribed before Loam was running) — flushing in init() would emit into a listener that
  // isn't registered yet and the events would be lost.
  @ReactMethod fun jsReady() { DeliveryHub.flushPending() }

  @ReactMethod fun deliver(callerKey: String, topic: String, candidatesJson: String) =
    DeliveryHub.deliver(callerKey, topic, candidatesJson)
  @ReactMethod fun setMetrics(json: String) { DeliveryHub.metricsJson = json }
  @ReactMethod fun setAuthorized(jsonArray: String) {
    val set = HashSet<String>()
    try { val a = org.json.JSONArray(jsonArray); for (i in 0 until a.length()) set.add(a.getString(i)) } catch (_: Throwable) {}
    DeliveryHub.authorized = set
  }
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
