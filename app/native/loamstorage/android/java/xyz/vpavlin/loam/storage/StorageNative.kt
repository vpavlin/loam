package xyz.vpavlin.loam.storage

// The libstorage C FFI (logos-storage-nim PR #1540) through jni/logos_storage_ffi.c, compiled for this
// class. Every call blocks until libstorage's terminal callback and returns {"ok":bool,"msg"|"err":…};
// storageNew returns the node pointer (0 = failure). Fetch-only surface (loam-transport ADR 0020).
object StorageNative {
  @Volatile private var loaded = false
  @Synchronized fun load() {
    if (loaded) return
    System.loadLibrary("c++_shared")
    System.loadLibrary("storage")
    System.loadLibrary("logos_storage_jni")
    loaded = true
  }

  external fun storageSetup()
  external fun storageNew(configJson: String): Long
  external fun storageStart(ctx: Long): String
  external fun storageStop(ctx: Long): String
  external fun storageClose(ctx: Long): String
  external fun storageDestroy(ctx: Long): String
  external fun storageSpr(ctx: Long): String
  external fun storageDebug(ctx: Long): String
  external fun storageVersion(ctx: Long): String
  external fun storageConnect(ctx: Long, peerId: String, addrs: Array<String>): String
  external fun storageExists(ctx: Long, cid: String): String
  external fun storageFetch(ctx: Long, cid: String): String
  external fun storageDownloadManifest(ctx: Long, cid: String): String
  external fun storageDownloadInit(ctx: Long, cid: String, chunkSize: Long, local: Boolean): String
  external fun storageDownloadStream(ctx: Long, cid: String, chunkSize: Long, local: Boolean, filePath: String): String
  external fun storageDownloadCancel(ctx: Long, cid: String): String
  external fun storageDelete(ctx: Long, cid: String): String
}
