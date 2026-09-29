package xyz.vpavlin.loam

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {
  private var stderrKeep: java.io.FileOutputStream? = null   // keeps the fd-2 target open for the process

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
        this,
        object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> {
            // Packages that cannot be autolinked yet can be added manually here, for example:
            // packages.add(new MyReactNativePackage());
            return PackageList(this).packages.apply {
            add(com.receiverandroid.LogosMessagingPackage())
            add(co.logos.delivery.svc.DeliveryBridgePackage())
            add(xyz.vpavlin.loam.mesh.LoamMeshPackage())
          }
          }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
          override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Native stderr (fd 2) goes nowhere on Android. The Nim node's SIGSEGV handler prints its reason +
    // traceback there before dying, so point fd 2 at a file (previous run's kept as -prev for the report).
    try {
      val f = java.io.File(filesDir, "loam-stderr.txt")
      if (f.exists() && f.length() > 0) f.renameTo(java.io.File(filesDir, "loam-stderr-prev.txt"))
      val out = java.io.FileOutputStream(java.io.File(filesDir, "loam-stderr.txt"))
      android.system.Os.dup2(out.fd, 2)
      stderrKeep = out
    } catch (_: Throwable) {}
    // Record any uncaught JVM/JS crash to a file so the next launch can show it (no adb needed).
    val prev = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      try {
        val sw = java.io.StringWriter(); e.printStackTrace(java.io.PrintWriter(sw))
        java.io.File(filesDir, "loam-last-crash.txt").writeText(
          "${java.util.Date()} thread=${t.name} api=${android.os.Build.VERSION.SDK_INT} ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}\n" + sw.toString().take(6000))
      } catch (_: Throwable) {}
      prev?.uncaughtException(t, e)
    }
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
