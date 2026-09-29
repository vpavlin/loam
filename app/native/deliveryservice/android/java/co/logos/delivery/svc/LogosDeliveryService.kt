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
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray

// The IPC entry point other apps bind. It trusts NOTHING the caller says about its identity:
// it resolves the calling package + signing cert from the binder UID itself, and keys the
// broker tenant + the user's consent grant by that. The app owner approves each app once
// ("Allow App X?"); grants are per (package + cert), so a repackaged/re-signed app is a new,
// unapproved identity.
class LogosDeliveryService : Service() {
  // Prime the approved-apps set from the persisted grants BEFORE any JS runs. The JS's
  // pushAuthorized() only fires once the RN context / UI is up (App.tsx preloadGrants), so a
  // HEADLESS bind (an app reads metrics/registers while the Loam UI is closed, or after the
  // process was killed) would otherwise see DeliveryHub.authorized empty -> return
  // {authorized:false} for an ALREADY-APPROVED caller -> the client mislabels a not-yet-started
  // node as "not approved" instead of "Loam isn't running". Reading the grants file here (the same
  // file service-bridge.ts persists to expo-file-system documentDirectory == filesDir) makes an
  // approved app recognized immediately. The JS remains the source of truth and re-pushes the set
  // (approve/revoke) as soon as it runs; this is only the early prime.
  override fun onCreate() {
    super.onCreate()
    try {
      val f = File(filesDir, "logos-delivery-grants.json")
      if (!f.exists()) return
      val arr = JSONArray(f.readText())
      val approved = HashSet<String>()
      for (i in 0 until arr.length()) {
        val g = arr.getJSONObject(i)
        if (g.optBoolean("granted", false)) {
          val ck = g.optString("callerKey", "")
          if (ck.isNotEmpty()) approved.add(ck)
        }
      }
      DeliveryHub.authorized = approved
    } catch (_: Throwable) { /* best-effort; JS will push the authoritative set when it runs */ }
  }
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
