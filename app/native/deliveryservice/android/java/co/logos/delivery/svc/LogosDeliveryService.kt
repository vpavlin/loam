package co.logos.delivery.svc

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Base64
import co.logos.delivery.ILogosDelivery
import co.logos.delivery.ILogosDeliveryCallback
import java.security.MessageDigest

// The IPC entry point other apps bind. It trusts NOTHING the caller says about its identity:
// it resolves the calling package + signing cert from the binder UID itself, and keys the
// broker tenant + the user's consent grant by that. The app owner approves each app once
// ("Allow App X?"); grants are per (package + cert), so a repackaged/re-signed app is a new,
// unapproved identity.
class LogosDeliveryService : Service() {
  private fun sha256(sig: Signature): String {
    val md = MessageDigest.getInstance("SHA-256")
    return Base64.encodeToString(md.digest(sig.toByteArray()), Base64.NO_WRAP)
  }
  private data class Caller(val pkg: String, val cert: String, val label: String)
  private fun caller(): Caller {
    val uid = Binder.getCallingUid()
    val pm = packageManager
    val pkg = pm.getPackagesForUid(uid)?.firstOrNull() ?: "uid:$uid"
    val cert = try {
      val sigs: Array<Signature> = if (Build.VERSION.SDK_INT >= 28) {
        pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners ?: arrayOf()
      } else {
        @Suppress("DEPRECATION") pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures ?: arrayOf()
      }
      sigs.firstOrNull()?.let { sha256(it) } ?: ""
    } catch (_: Throwable) { "" }
    val label = try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (_: Throwable) { pkg }
    return Caller(pkg, cert, label)
  }
  private fun key(c: Caller) = c.pkg + "|" + c.cert

  private val binder = object : ILogosDelivery.Stub() {
    override fun registerClient(appId: String, cb: ILogosDeliveryCallback) {
      val c = caller(); val ck = key(c)
      DeliveryHub.register(ck, cb, appId, c.pkg, c.cert, c.label)
      // When the client PROCESS dies (app swiped away / killed) it can't call
      // unregisterClient itself. Link to its binder's death so we auto-unregister
      // — which, for a caching app, DETACHES it in the broker (keep the
      // subscription, start buffering) instead of leaving a dead callback. This is
      // what makes the offline cache actually fill while an app is closed.
      try { cb.asBinder().linkToDeath({ DeliveryHub.unregister(ck) }, 0) } catch (_: Throwable) {}
    }
    override fun subscribe(appId: String, topic: String) { DeliveryHub.subscribe(key(caller()), topic) }
    override fun send(appId: String, topic: String, sealed: ByteArray) =
      DeliveryHub.send(key(caller()), topic, Base64.encodeToString(sealed, Base64.NO_WRAP))
    override fun requestStoreSync(appId: String) = DeliveryHub.requestStoreSync(key(caller()))
    override fun unregisterClient(appId: String) = DeliveryHub.unregister(key(caller()))
    override fun metrics(): String {
      val c = caller(); val ck = key(c)
      if (DeliveryHub.isAuthorized(ck)) return DeliveryHub.metricsJson
      DeliveryHub.touch(ck, c.pkg, c.cert, c.label)   // gated: reveal nothing, prompt approval
      return "{\"authorized\":false}"
    }
  }
  override fun onBind(intent: Intent?): IBinder = binder
}
