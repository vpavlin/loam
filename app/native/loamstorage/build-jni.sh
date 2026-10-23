#!/usr/bin/env bash
# Build Loam's liblogos_storage_jni.so from jni/logos_storage_ffi.c (the same glue as Backpack's, compiled
# for the class xyz.vpavlin.loam.storage.StorageNative). libstorage.so: logos-storage-nim PR #1540, see
# PROVENANCE (loam-transport ADR 0020). x86_64 is for emulator test builds only.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
NDK=${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/27.1.12297006}
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
DEF=-DJNI_CLASS_PREFIX=Java_xyz_vpavlin_loam_storage_StorageNative_
"$TC/aarch64-linux-android30-clang" -shared -fPIC -O2 -Wall $DEF -I"$HERE/jni" "$HERE/jni/logos_storage_ffi.c" -L"$HERE/arm64-v8a" -lstorage -llog -o "$HERE/arm64-v8a/liblogos_storage_jni.so"
[ -f "$HERE/x86_64/libstorage.so" ] && "$TC/x86_64-linux-android30-clang" -shared -fPIC -O2 -Wall $DEF -I"$HERE/jni" "$HERE/jni/logos_storage_ffi.c" -L"$HERE/x86_64" -lstorage -llog -o "$HERE/x86_64/liblogos_storage_jni.so"
sha256sum "$HERE"/arm64-v8a/*.so
