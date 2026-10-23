package xyz.vpavlin.loam.storage

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * One Logos Storage fetch client for the whole phone (loam-transport ADR 0020, amended 2026-10-23).
 *
 * Loam knows CIDs, not file types. An app asks for a CID; a JOB keyed by that CID brings it into Loam's
 * cache in the background, whether or not the app is still alive; the app polls status() and, once the
 * job is done, open() hands it a read-only descriptor to the cached file (no network). What the bytes
 * are, and whether to trust them, stays the app's business (Backpack checks SHA-256 and APK signers).
 *
 * Lessons carried over from Backpack (its ADRs 0005/0006 and the 2026-10-23 audit):
 *  - libstorage = PR #1540; the node is started ONCE per process and never restarted in-process;
 *  - its data dir is scratch, wiped before the node starts (a dir left by a killed download hangs the
 *    next one); the cache is the finished files, not the block store;
 *  - the size is read from the manifest before any data block is fetched;
 *  - cancel runs on a second thread (the storage thread is the one blocked in the download);
 *  - one job at a time (libstorage's calls block); FIFO queue.
 */
object StorageEngine {
  private const val TAG = "LOAMSTORAGE"
  private val CID = Regex("^z[1-9A-HJ-NP-Za-km-z]{40,90}$")
  private val PEER = Regex("^[1-9A-HJ-NP-Za-km-z]{40,80}$")
  private val ADDR = Regex("^/[A-Za-z0-9.:/_-]{3,200}$")
  private val SPR = Regex("^spr:[A-Za-z0-9_-]{10,2000}$")
  const val MAX_FILE = 512L shl 20            // one CID at most 512 MiB
  @Volatile var cacheCap = 1L shl 30          // 1 GiB, LRU
  private const val KEEP_UNOPENED_MS = 3_600_000L   // a finished, never-opened file survives eviction for 1 h

  class Job(val cid: String) {
    @Volatile var state = "queued"            // queued | fetching | done | failed | cancelled
    @Volatile var bytes = 0L
    @Volatile var total = 0L
    @Volatile var error: String? = null
    @Volatile var cancelled = false
    @Volatile var queued = false
    val callers: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val peers = ArrayList<Pair<String, Array<String>>>()
    val sprs = LinkedHashSet<String>()
    fun json(): String = JSONObject().put("cid", cid).put("state", state).put("bytes", bytes).put("total", total)
      .apply { error?.let { put("error", it) } }.toString()
  }

  private lateinit var app: Context
  private val jobs = ConcurrentHashMap<String, Job>()
  private val worker = Executors.newSingleThreadExecutor { r -> Thread(null, r, "loam-storage", 16L shl 20) }
  private val side = Executors.newSingleThreadExecutor { r -> Thread(null, r, "loam-storage-side", 1L shl 20) }
  @Volatile private var node = 0L
  @Volatile private var nodeError: String? = null
  private val knownSprs = LinkedHashSet<String>()

  fun init(ctx: Context) { if (!::app.isInitialized) app = ctx.applicationContext }
  private fun cacheDir() = File(app.filesDir, "loam-storage/cache").apply { mkdirs() }
  private fun nodeDir() = File(app.filesDir, "loam-storage/node")
  private fun cached(cid: String) = File(cacheDir(), cid)

  private fun online(): Boolean = try {
    val cm = app.getSystemService(ConnectivityManager::class.java)
    val caps = cm.getNetworkCapabilities(cm.activeNetwork)
    caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  } catch (_: Throwable) { true }

  // ── API (called from the AIDL binder, any thread) ──────────────────────────────────────────────

  /** Start or join the job for `cid`. peersJson: [{peerId, addrs:[…], spr?}] (≤ 8, checked). */
  fun fetch(callerKey: String, cid: String, peersJson: String): String {
    if (!CID.matches(cid)) return err("bad cid")
    val f = cached(cid)
    if (f.isFile) { f.setLastModified(System.currentTimeMillis()); return JSONObject().put("cid", cid).put("state", "done").put("bytes", f.length()).put("total", f.length()).toString() }
    val job = jobs.compute(cid) { _, old -> if (old == null || old.state == "failed" || old.state == "cancelled") Job(cid) else old }!!
    job.callers.add(callerKey)
    parsePeers(peersJson, job)
    synchronized(job) { if (job.state == "queued" && !job.queued) { job.queued = true; worker.execute { run(job) } } }
    return job.json()
  }

  fun status(cid: String): String {
    jobs[cid]?.let { return it.json() }
    val f = cached(cid)
    return if (f.isFile) JSONObject().put("cid", cid).put("state", "done").put("bytes", f.length()).put("total", f.length()).toString()
    else JSONObject().put("cid", cid).put("state", "none").toString()
  }

  fun cancel(cid: String): String {
    val job = jobs[cid] ?: return status(cid)
    if (job.state == "done" || job.state == "failed") return job.json()
    job.cancelled = true
    if (job.state == "queued") { job.state = "cancelled"; return job.json() }
    side.execute { try { if (node != 0L) StorageNative.storageDownloadCancel(node, cid) } catch (t: Throwable) { Log.w(TAG, "cancel", t) } }
    return job.json()
  }

  /** Read-only descriptor to a finished CID, or null. Touches it for LRU. */
  fun open(cid: String): ParcelFileDescriptor? {
    if (!CID.matches(cid)) return null
    val f = cached(cid)
    if (!f.isFile) return null
    f.setLastModified(System.currentTimeMillis())
    return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  fun info(): String {
    val files = cacheDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".part") } ?: emptyList()
    return JSONObject().put("running", node != 0L).put("online", online()).put("cacheBytes", files.sumOf { it.length() })
      .put("cacheFiles", files.size).put("cacheCap", cacheCap)
      .put("jobs", JSONArray(jobs.values.filter { it.state == "queued" || it.state == "fetching" }.map { JSONObject(it.json()) }))
      .apply { nodeError?.let { put("nodeError", it) } }.toString()
  }

  // ── the job ─────────────────────────────────────────────────────────────────────────────────

  private fun run(job: Job) {
    val cid = job.cid
    try {
      if (job.cancelled) { job.state = "cancelled"; return }
      if (!online()) { fail(job, "offline"); return }
      job.state = "fetching"
      val c = ensureNode(job.sprs.toList()) ?: run { fail(job, "node: ${nodeError ?: "did not start"}"); return }
      for ((peerId, addrs) in job.peers) {
        if (job.cancelled) break
        try { StorageNative.storageConnect(c, peerId, addrs) } catch (t: Throwable) { Log.w(TAG, "connect", t) }
      }
      if (job.cancelled) { job.state = "cancelled"; return }
      // size first, from the manifest alone
      val man = JSONObject(StorageNative.storageDownloadManifest(c, cid))
      if (!man.optBoolean("ok")) { fail(job, classify(man.optString("err"))); return }
      val size = Regex("\"datasetSize\"\\s*:\\s*(\\d+)").find(man.optString("msg"))?.groupValues?.get(1)?.toLongOrNull()
        ?: run { fail(job, "size unknown"); return }
      if (size > MAX_FILE || size > cacheCap) { fail(job, "too large ($size bytes)"); return }
      job.total = size
      makeRoom(size)
      val part = File(cacheDir(), "$cid.part"); part.delete()
      val progress = startProgress(job, part)
      try {
        var r = JSONObject(StorageNative.storageFetch(c, cid))
        if (!r.optBoolean("ok") && !job.cancelled) { fail(job, classify(r.optString("err"))); return }
        if (job.cancelled) { job.state = "cancelled"; return }
        r = JSONObject(StorageNative.storageDownloadInit(c, cid, 65536, false))
        if (!r.optBoolean("ok")) { fail(job, classify(r.optString("err"))); return }
        r = JSONObject(StorageNative.storageDownloadStream(c, cid, 65536, false, part.absolutePath))
        if (job.cancelled) { job.state = "cancelled"; return }
        if (!r.optBoolean("ok")) { fail(job, classify(r.optString("err"))); return }
      } finally { progress.interrupt() }
      if (part.length() != size) { fail(job, "got ${part.length()} of $size bytes"); return }
      val dst = cached(cid)
      if (!part.renameTo(dst)) { fail(job, "could not store the file"); return }
      dst.setLastModified(System.currentTimeMillis())
      job.bytes = size; job.state = "done"
    } catch (t: Throwable) {
      fail(job, t.message ?: "storage error")
    } finally {
      job.queued = false
      if (job.state != "done") File(cacheDir(), "$cid.part").delete()
      if (job.state == "cancelled" || job.state == "failed") side.execute { try { if (node != 0L) StorageNative.storageDelete(node, cid) } catch (_: Throwable) {} }
    }
  }

  private fun fail(job: Job, why: String) { job.error = why; job.state = if (job.cancelled) "cancelled" else "failed"; Log.i(TAG, "${job.cid.takeLast(10)}: $why") }
  private fun classify(e: String) = when {
    e.contains("timeout", true) -> "timeout"
    e.contains("not found", true) || e.contains("no providers", true) -> "not-found"
    e.isBlank() -> "storage error"
    else -> e.take(200)
  }
  private fun err(msg: String) = JSONObject().put("state", "failed").put("error", msg).toString()

  // progress = the larger of the file written and the block store's growth (fetch fills the store)
  private fun startProgress(job: Job, part: File): Thread {
    val store = nodeDir(); val base = dirSize(store)
    return Thread {
      try { while (!Thread.currentThread().isInterrupted) {
        job.bytes = minOf(job.total, maxOf(job.bytes, part.length(), dirSize(store) - base)); Thread.sleep(1000)
      } } catch (_: InterruptedException) {}
    }.apply { isDaemon = true; start() }
  }
  private fun dirSize(d: File): Long = try { d.walkTopDown().filter { it.isFile }.sumOf { it.length() } } catch (_: Throwable) { 0L }

  // ── the node: started once per process, never restarted in-process ─────────────────────────────
  @Synchronized private fun ensureNode(sprs: List<String>): Long? {
    if (node != 0L) return node
    if (nodeError != null) return null       // a failed start is not retried in this process (a 2nd start aborts)
    try {
      StorageNative.load()
      StorageNative.storageSetup()
      nodeDir().deleteRecursively(); nodeDir().mkdirs()   // scratch: see the class comment
      knownSprs.addAll(sprs)
      val cfg = JSONObject().put("log-level", "WARN").put("data-dir", nodeDir().absolutePath)
      if (knownSprs.isNotEmpty()) cfg.put("bootstrap-node", JSONArray(knownSprs.toList())) else cfg.put("network", "logos.test")
      val c = StorageNative.storageNew(cfg.toString())
      if (c == 0L) { nodeError = "storage_new failed"; return null }
      val r = JSONObject(StorageNative.storageStart(c))
      if (!r.optBoolean("ok")) {
        nodeError = r.optString("err", "start failed")
        try { StorageNative.storageStop(c); StorageNative.storageClose(c); StorageNative.storageDestroy(c) } catch (_: Throwable) {}
        return null
      }
      node = c
      Log.i(TAG, "node started")
      return c
    } catch (t: Throwable) { nodeError = t.message ?: "node error"; return null }
  }

  // ── cache: LRU by last use, never evicting a running job's file or a fresh, unopened one ─────────
  private fun makeRoom(incoming: Long) {
    val files = cacheDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".part") }?.sortedBy { it.lastModified() } ?: return
    var used = files.sumOf { it.length() }
    val now = System.currentTimeMillis()
    for (f in files) {
      if (used + incoming <= cacheCap) break
      if (now - f.lastModified() < KEEP_UNOPENED_MS) continue
      if (jobs[f.name]?.state == "fetching") continue
      used -= f.length(); f.delete()
    }
  }

  private fun parsePeers(json: String, job: Job) {
    try {
      val arr = JSONArray(json)
      for (i in 0 until minOf(arr.length(), 8)) {
        val p = arr.getJSONObject(i)
        val id = p.optString("peerId"); if (!PEER.matches(id)) continue
        val a = p.optJSONArray("addrs") ?: JSONArray()
        val addrs = (0 until minOf(a.length(), 4)).map { a.optString(it) }.filter { ADDR.matches(it) && !selfAddr(it) }
        synchronized(job.peers) { if (job.peers.none { it.first == id }) job.peers.add(id to addrs.toTypedArray()) }
        p.optString("spr").takeIf { SPR.matches(it) }?.let { job.sprs.add(it) }
      }
    } catch (_: Throwable) { /* no peers: the node's own discovery is all we have */ }
  }

  // loopback / link-local / unspecified, in any spelling (same rule as Backpack's schema.ts selfAddr)
  private fun selfAddr(a: String): Boolean {
    val m = Regex("^/(ip4|ip6|dns|dns4|dns6|dnsaddr)/([^/]+)", RegexOption.IGNORE_CASE).find(a) ?: return true
    val h = m.groupValues[2].lowercase().trimEnd('.')
    if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
    val v4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(h)
    if (!v4 && !h.contains(':')) return m.groupValues[1].lowercase() == "ip4"   // a DNS name is fine; an odd ip4 form is not
    return try {   // literal only: getByName on a literal never touches DNS
      val ip = java.net.InetAddress.getByName(h)
      ip.isLoopbackAddress || ip.isLinkLocalAddress || ip.isAnyLocalAddress ||
        (ip is java.net.Inet6Address && h.startsWith("::ffff:"))
    } catch (_: Throwable) { true }
  }
}
