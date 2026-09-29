// Adds Loam's crash recorder to MainApplication.onCreate: an uncaught-exception handler that writes the
// JVM/JS stack trace to filesDir/loam-last-crash.txt, so the next launch can show it on screen (no adb).
// android/ is generated and gitignored; without this plugin a fresh `expo prebuild` drops the recorder.
const { withMainApplication } = require("@expo/config-plugins");

const MARKER = "loam-last-crash.txt";
const HANDLER = `
    // Record any uncaught JVM/JS crash to a file so the next launch can show it (no adb needed).
    val prevCrashHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      try {
        val sw = java.io.StringWriter(); e.printStackTrace(java.io.PrintWriter(sw))
        java.io.File(filesDir, "${MARKER}").writeText(
          "\${java.util.Date()} thread=\${t.name} api=\${android.os.Build.VERSION.SDK_INT} \${android.os.Build.MANUFACTURER} \${android.os.Build.MODEL}\\n" + sw.toString().take(6000))
      } catch (_: Throwable) {}
      prevCrashHandler?.uncaughtException(t, e)
    }`;

module.exports = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;
    const anchor = /(override fun onCreate\(\)\s*\{\s*\n\s*super\.onCreate\(\))/;
    if (!anchor.test(src)) throw new Error("withCrashRecorder: MainApplication.onCreate/super.onCreate() not found");
    cfg.modResults.contents = src.replace(anchor, `$1${HANDLER}`);
    return cfg;
  });
