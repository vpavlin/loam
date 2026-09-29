`android/` is generated and gitignored, but its MainApplication.kt is hand-edited: it registers the
DeliveryBridge and LoamMesh packages, and since 0.0.43 it installs the crash recorder that writes
`loam-last-crash.txt`. This is a copy of that file, so a fresh `expo prebuild` can restore it.
