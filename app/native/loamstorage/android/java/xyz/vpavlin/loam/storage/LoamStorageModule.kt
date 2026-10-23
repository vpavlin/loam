package xyz.vpavlin.loam.storage

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

// Loam's own UI over the Storage engine: state, jobs, cache; the on/off switch; clearing the cache.
class LoamStorageModule(rc: ReactApplicationContext) : ReactContextBaseJavaModule(rc) {
  init { StorageEngine.init(rc) }
  override fun getName() = "LoamStorage"
  @ReactMethod fun info(promise: Promise) { Thread { promise.resolve(try { StorageEngine.info() } catch (t: Throwable) { "{}" }) }.start() }
  @ReactMethod fun setEnabled(on: Boolean, promise: Promise) { StorageEngine.setEnabled(on); promise.resolve(on) }
  @ReactMethod fun clearCache(promise: Promise) { Thread { promise.resolve(StorageEngine.clearCache().toDouble()) }.start() }
}

class LoamStoragePackage : ReactPackage {
  override fun createNativeModules(rc: ReactApplicationContext): List<NativeModule> = listOf(LoamStorageModule(rc))
  override fun createViewManagers(rc: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
