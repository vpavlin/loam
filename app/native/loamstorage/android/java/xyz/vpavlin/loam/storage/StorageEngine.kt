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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

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
 *  - one job at a time (libstorage's calls block); FIFO queue;
 *  - a job that gets no data for STALL_MS (a network change can leave a libstorage call waiting for ever)
 *    fails as "stalled" and the queue moves to a fresh worker thread, so the app's retry can start over.
 */
object StorageEngine {
  private const val TAG = "LOAMSTORAGE"
  private val CID = Regex("^z[1-9A-HJ-NP-Za-km-z]{40,90}$")
  private val PEER = Regex("^[1-9A-HJ-NP-Za-km-z]{40,80}$")
  private val ADDR = Regex("^/[A-Za-z0-9.:/_-]{3,200}$")
  const val MAX_FILE = 512L shl 20            // one CID at most 512 MiB
  @Volatile var cacheCap = 1L shl 30          // 1 GiB, LRU
  private const val KEEP_UNOPENED_MS = 3_600_000L   // a finished, never-opened file survives eviction for 1 h
  private const val STALL_MS = 180_000L       // no new data for 3 min while fetching = stalled
  private val serials = AtomicLong()

  class Job(val cid: String) {
    val serial = serials.incrementAndGet()   // names this job's .part file: a stalled job's thread may still write its own
    @Volatile var state = "queued"            // queued | fetching | done | failed | cancelled
    @Volatile var bytes = 0L
    @Volatile var total = 0L
    @Volatile var error: String? = null
    @Volatile var cancelled = false
    @Volatile var queued = false
    @Volatile var finishedAt = 0L
    @Volatile var activeAt = 0L               // when data last arrived (or the job started fetching)
    val callers: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val peers = ArrayList<Pair<String, Array<String>>>()
    fun json(): String = JSONObject().put("cid", cid).put("state", state).put("bytes", bytes).put("total", total)
      .apply { error?.let { put("error", it) }; if (state == "fetching" && activeAt > 0) put("idleMs", System.currentTimeMillis() - activeAt) }.toString()
  }

  private lateinit var app: Context
  private val jobs = ConcurrentHashMap<String, Job>()
  private fun newWorker(): ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(null, r, "loam-storage", 16L shl 20) }
  @Volatile private var worker = newWorker()
  private val workerLock = Any()   // not the object's monitor: ensureNode() holds that and may be the call that hangs
  private fun submit(r: Runnable) = synchronized(workerLock) { worker.execute(r) }
  private val side = Executors.newSingleThreadExecutor { r -> Thread(null, r, "loam-storage-side", 1L shl 20) }
  @Volatile private var node = 0L
  @Volatile private var nodeError: String? = null

  fun init(ctx: Context) { if (!::app.isInitialized) app = ctx.applicationContext }

  // ── the user's switch (Loam UI). Off: no new jobs, running ones cancelled; apps are told and fall back
  // to their own node. Remembered across restarts. The node itself can't be stopped and restarted in one
  // process (libstorage), so "off" leaves a started node idle until Loam's process ends.
  private fun prefs() = app.getSharedPreferences("loam-storage", Context.MODE_PRIVATE)
  val enabled: Boolean get() = prefs().getBoolean("enabled", true)
  fun setEnabled(on: Boolean) {
    prefs().edit().putBoolean("enabled", on).apply()
    if (!on) for (j in jobs.values) if (j.state == "queued" || j.state == "fetching") cancelJob(j)
  }
  /** Partial files whose job isn't fetching are leftovers of a crash or a kill (re-check R-4). */
  private fun sweepParts() {
    cacheDir().listFiles()?.filter { it.name.endsWith(".part") && jobs[it.name.substringBefore('.')]?.state != "fetching" }?.forEach { it.delete() }
  }
  /** Drop every finished file (not running jobs' partial files). Returns bytes freed. */
  fun clearCache(): Long {
    sweepParts()
    var freed = 0L
    cacheDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".owners") }?.forEach { freed += it.length(); it.delete(); owners(it.name).delete() }
    jobs.entries.removeIf { it.value.state == "done" || it.value.state == "failed" || it.value.state == "cancelled" }
    return freed
  }
  private fun nodeState(): String = when {
    !enabled -> "off"
    nodeError != null -> "failed"
    node != 0L && jobs.values.any { it.state == "fetching" } -> "fetching"
    node != 0L -> "running"
    else -> "idle"
  }
  private fun cacheDir() = File(app.filesDir, "loam-storage/cache").apply { mkdirs() }
  private fun nodeDir() = File(app.filesDir, "loam-storage/node")
  private fun cached(cid: String) = File(cacheDir(), cid)

  // ── who may see a CID (audit L-3). The cache is shared, but by CAPABILITY: an app reaches a file only
  // after asking for it by its CID (fetch), and sees and cancels only its own jobs. Owners of finished
  // files are kept beside them (<cid>.owners), so they survive Loam's restarts.
  private fun owners(cid: String) = File(cacheDir(), "$cid.owners")
  private fun ownerSet(cid: String): MutableSet<String> = try { owners(cid).readLines().filter { it.isNotBlank() }.toMutableSet() } catch (_: Throwable) { mutableSetOf() }
  @Synchronized private fun addOwners(cid: String, cks: Collection<String>) {
    val set = ownerSet(cid); if (set.addAll(cks)) owners(cid).writeText(set.joinToString("\n"))
  }
  private fun owns(ck: String?, cid: String): Boolean = ck == null || jobs[cid]?.callers?.contains(ck) == true || ownerSet(cid).contains(ck)

  // job limits (audit L-6): at most 32 queued/fetching jobs, 8 per app; finished ones pruned
  private const val MAX_ACTIVE = 32
  private const val MAX_ACTIVE_PER_APP = 8
  private fun active(j: Job) = j.state == "queued" || j.state == "fetching"
  private fun prune() {
    val terminal = jobs.values.filter { !active(it) }.sortedBy { it.finishedAt }
    for (j in terminal.dropLast(64)) jobs.remove(j.cid, j)
  }

  private fun online(): Boolean = try {
    val cm = app.getSystemService(ConnectivityManager::class.java)
    val caps = cm.getNetworkCapabilities(cm.activeNetwork)
    caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  } catch (_: Throwable) { true }

  // ── API (called from the AIDL binder, any thread) ──────────────────────────────────────────────

  /** Start or join the job for `cid`. peersJson: [{peerId, addrs:[…], spr?}] (≤ 8, checked). */
  fun fetch(callerKey: String, cid: String, peersJson: String): String {
    if (!CID.matches(cid)) return err("bad cid")
    if (!enabled) return err("Storage is turned off in Loam")
    if (peersJson.length > 16384) return err("too many peers")
    val f = cached(cid)
    if (f.isFile) { addOwners(cid, listOf(callerKey)); f.setLastModified(System.currentTimeMillis()); return JSONObject().put("cid", cid).put("state", "done").put("bytes", f.length()).put("total", f.length()).toString() }
    val existing = jobs[cid]
    if (existing == null || !active(existing)) {
      prune()
      val act = jobs.values.filter { active(it) }
      if (act.size >= MAX_ACTIVE) return err("too many downloads queued in Loam; try again later")
      if (act.count { it.callers.contains(callerKey) } >= MAX_ACTIVE_PER_APP) return err("this app already has $MAX_ACTIVE_PER_APP downloads queued")
    }
    // a "done" job whose file is gone (cache cleared or evicted) starts over
    val job = jobs.compute(cid) { _, old -> if (old == null || old.state == "failed" || old.state == "cancelled" || old.state == "done") Job(cid) else old }!!
    job.callers.add(callerKey)
    parsePeers(peersJson, job)
    synchronized(job) { if (job.state == "queued" && !job.queued) { job.queued = true; submit { run(job) } } }
    return job.json()
  }

  /** `ck` = the calling app (null = Loam's own UI). An app sees only CIDs it asked for. */
  fun status(ck: String?, cid: String): String {
    if (!CID.matches(cid)) return err("bad cid")
    val none = JSONObject().put("cid", cid).put("state", "none").toString()
    if (!owns(ck, cid)) return none
    jobs[cid]?.let { if (it.state != "done" || cached(cid).isFile) return it.json() }
    val f = cached(cid)
    return if (f.isFile) JSONObject().put("cid", cid).put("state", "done").put("bytes", f.length()).put("total", f.length()).toString() else none
  }

  /** An app cancels only its own interest; the download stops when no app wants it any more. */
  fun cancel(ck: String?, cid: String): String {
    if (!CID.matches(cid)) return err("bad cid")
    val job = jobs[cid] ?: return status(ck, cid)
    if (ck != null) {
      if (!job.callers.contains(ck)) return status(ck, cid)
      job.callers.remove(ck)
      if (job.callers.isNotEmpty() || !active(job)) return JSONObject(job.json()).put("state", "cancelled").toString()
    }
    cancelJob(job)
    return job.json()
  }
  private fun cancelJob(job: Job) {
    if (!active(job)) return
    job.cancelled = true
    if (job.state == "queued") { job.state = "cancelled"; return }
    side.execute { try { if (node != 0L) StorageNative.storageDownloadCancel(node, job.cid) } catch (t: Throwable) { Log.w(TAG, "cancel", t) } }
  }

  /** Read-only descriptor to a finished CID this app asked for, or null. Touches it for LRU. */
  fun open(ck: String?, cid: String): ParcelFileDescriptor? {
    if (!CID.matches(cid) || !enabled || !owns(ck, cid)) return null   // L-13: off means off
    val f = cached(cid)
    if (!f.isFile) return null
    f.setLastModified(System.currentTimeMillis())
    return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  /** ck = null: Loam's own UI, everything. An app: aggregate cache numbers and only its own jobs. */
  fun info(ck: String? = null): String {
    val files = cacheDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".owners") } ?: emptyList()
    val mine = jobs.values.filter { active(it) && (ck == null || it.callers.contains(ck)) }
    return JSONObject().put("enabled", enabled).put("state", nodeState()).put("running", node != 0L).put("online", online()).put("cacheBytes", files.sumOf { it.length() })
      .put("cacheFiles", files.size).put("cacheCap", cacheCap)
      .put("jobs", JSONArray(mine.map { j -> JSONObject(j.json()).apply { if (ck == null) put("apps", JSONArray(j.callers.map { it.substringBefore('|') })) } }))
      .apply { nodeError?.let { put("nodeError", it) } }.toString()
  }

  // ── the job ─────────────────────────────────────────────────────────────────────────────────

  private fun run(job: Job) {
    val cid = job.cid
    val part = File(cacheDir(), "$cid.${job.serial}.part")
    var progress: Thread? = null
    try {
      if (job.cancelled) { job.state = "cancelled"; return }
      if (!online()) { fail(job, "offline"); return }
      job.state = "fetching"; job.activeAt = System.currentTimeMillis()
      progress = startProgress(job, part)
      val c = ensureNode() ?: run { fail(job, "node: ${nodeError ?: "did not start"}"); return }
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
      if (!makeRoom(size)) { fail(job, "cache full"); return }
      part.delete()
      try {
        var r = JSONObject(StorageNative.storageFetch(c, cid))
        if (!r.optBoolean("ok") && !job.cancelled) { fail(job, classify(r.optString("err"))); return }
        if (job.cancelled) { job.state = "cancelled"; return }
        r = JSONObject(StorageNative.storageDownloadInit(c, cid, 65536, false))
        if (!r.optBoolean("ok")) { fail(job, classify(r.optString("err"))); return }
        r = JSONObject(StorageNative.storageDownloadStream(c, cid, 65536, false, part.absolutePath))
        if (job.cancelled) { job.state = "cancelled"; return }
        if (!r.optBoolean("ok")) { fail(job, classify(r.optString("err"))); return }
      } finally { progress?.interrupt() }
      if (part.length() != size) { fail(job, "got ${part.length()} of $size bytes"); return }
      val dst = cached(cid)
      if (!part.renameTo(dst)) { fail(job, "could not store the file"); return }
      dst.setLastModified(System.currentTimeMillis())
      addOwners(cid, job.callers.toList())
      job.bytes = size; job.state = "done"
    } catch (t: Throwable) {
      fail(job, t.message ?: "storage error")
    } finally {
      progress?.interrupt()
      job.queued = false; job.finishedAt = System.currentTimeMillis()
      if (job.state != "done") part.delete()
      // a stalled job's thread can come back long after a new job for the same CID started: leave its blocks
      if (jobs[cid] === job && (job.state == "cancelled" || job.state == "failed")) side.execute { try { if (node != 0L) StorageNative.storageDelete(node, cid) } catch (_: Throwable) {} }
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

  // progress = bytes of this file written so far (download_stream writes as blocks arrive). The block
  // store's growth also counts other fetches running in the background, so it ran ahead of the truth.
  // It is also the stall watchdog: "data arrived" = this file grew, or the node's block store did (the
  // fetch phase fills the block store before anything is written to the file).
  private fun startProgress(job: Job, part: File): Thread = Thread {
    try {
      var lastPart = -1L; var lastStore = -1L; var tick = 0
      while (!Thread.currentThread().isInterrupted) {
        val p = part.length()
        job.bytes = minOf(job.total, p)
        if (p != lastPart) { lastPart = p; job.activeAt = System.currentTimeMillis() }
        if (tick++ % 5 == 0) { val st = dirBytes(nodeDir()); if (st != lastStore) { lastStore = st; job.activeAt = System.currentTimeMillis() } }
        if (job.state == "fetching" && System.currentTimeMillis() - job.activeAt > STALL_MS) { stall(job); return@Thread }
        Thread.sleep(1000)
      }
    } catch (_: InterruptedException) {}
  }.apply { isDaemon = true; start() }

  private fun dirBytes(d: File): Long = try { d.walkTopDown().filter { it.isFile }.sumOf { it.length() } } catch (_: Throwable) { 0L }

  /** No data for STALL_MS: fail the job (apps see "failed: stalled" and may ask again) and move the queue to
   *  a new worker thread — the old one may stay blocked inside libstorage until the call gives up, if ever. */
  private fun stall(job: Job) { synchronized(workerLock) {
    if (jobs[job.cid] !== job || job.state != "fetching") return
    Log.w(TAG, "${job.cid.takeLast(10)}: stalled, no data for ${STALL_MS / 1000} s")
    jobs[job.cid] = Job(job.cid).apply {
      state = "failed"; error = "stalled: no data for ${STALL_MS / 60_000} min (network changed?)"
      callers.addAll(job.callers); finishedAt = System.currentTimeMillis()
    }
    job.cancelled = true
    side.execute { try { if (node != 0L) StorageNative.storageDownloadCancel(node, job.cid) } catch (t: Throwable) { Log.w(TAG, "cancel", t) } }
    val old = worker
    worker = newWorker()
    for (r in old.shutdownNow()) worker.execute(r)   // queued jobs move over; the blocked thread ends when its call returns
  } }

  // ── the node: started once per process, never restarted in-process ─────────────────────────────
  // The shared node's bootstrap is never taken from an app (audit L-7): apps' peers are only dialled
  // for their own job (storageConnect above).
  @Synchronized private fun ensureNode(): Long? {
    if (node != 0L) return node
    if (nodeError != null) return null       // a failed start is not retried in this process (a 2nd start aborts)
    try {
      StorageNative.load()
      StorageNative.storageSetup()
      nodeDir().deleteRecursively(); nodeDir().mkdirs()   // scratch: see the class comment
      val cfg = JSONObject().put("log-level", "WARN").put("data-dir", nodeDir().absolutePath)
        .put("network", "logos.test")
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
  // The cap is hard (audit L-5): oldest first, files younger than an hour only when nothing older is
  // left; a download that still doesn't fit fails with "cache full" instead of overrunning the cap.
  private fun makeRoom(incoming: Long): Boolean {
    if (incoming > cacheCap) return false
    val files = cacheDir().listFiles()?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".owners") } ?: return true
    sweepParts()
    var used = files.sumOf { it.length() } + (cacheDir().listFiles()?.filter { it.name.endsWith(".part") }?.sumOf { it.length() } ?: 0L)
    val now = System.currentTimeMillis()
    val order = files.sortedWith(compareBy<File>({ now - it.lastModified() < KEEP_UNOPENED_MS }, { it.lastModified() }))
    for (f in order) {
      if (used + incoming <= cacheCap) break
      if (jobs[f.name]?.state == "fetching") continue
      used -= f.length(); f.delete(); owners(f.name).delete()
    }
    return used + incoming <= cacheCap
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
      // judge the PARSED address (audit L-12), first as itself (::1, ::, fe80::), then — for an
      // IPv4-mapped one (::ffff:0:0/96) in any spelling — as the IPv4 address it carries (re-check R-3)
      val ip = java.net.InetAddress.getByName(h)
      fun bad(a: java.net.InetAddress) = a.isLoopbackAddress || a.isLinkLocalAddress || a.isAnyLocalAddress
      if (bad(ip)) return true
      val b = ip.address
      b.size == 16 && (0 until 10).all { b[it] == 0.toByte() } && b[10] == 0xff.toByte() && b[11] == 0xff.toByte() &&
        bad(java.net.InetAddress.getByAddress(b.copyOfRange(12, 16)))
    } catch (_: Throwable) { true }
  }
}
