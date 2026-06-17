#!/usr/bin/env bash
# Builds the patched libNativeWrapper_cef.so inside an Ubuntu container.
# Mirrors package/build.ts's linux compile/link steps. Reuses the host's
# already-built libasar.so (copied to /work/libasar.so) so we skip zig-asar,
# and dlopen's libcef.so at runtime so we don't need it at link time.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cd /work/package

CEF_URL="https://cef-builds.spotifycdn.com/cef_binary_145.0.23+g3e7fe1c%2Bchromium-145.0.7632.68_linux64_minimal.tar.bz2"

echo "::: 1. apt deps"
apt-get update -qq
apt-get install -y -qq build-essential cmake pkg-config curl ca-certificates bzip2 \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev >/dev/null

echo "::: 2. CEF minimal dist (145)"
if [ ! -f vendors/cef/include/cef_version.h ]; then
  mkdir -p vendors/cef
  curl -fL "$CEF_URL" | tar -xj --strip-components=1 -C vendors/cef
fi
echo "    cef_version.h: $(grep -m1 CEF_VERSION vendors/cef/include/cef_version.h || true)"

echo "::: 2b. electrobun-dawn (WGPU) headers"
DAWN_URL="https://github.com/blackboardsh/electrobun-dawn/releases/download/v0.2.3/electrobun-dawn-linux-x64.tar.gz"
if [ ! -f vendors/wgpu/linux-x64/include/dawn/webgpu.h ]; then
  mkdir -p vendors/wgpu/linux-x64
  curl -fL "$DAWN_URL" | tar -xz --strip-components=1 -C vendors/wgpu/linux-x64
fi
ls vendors/wgpu/linux-x64/include/dawn/webgpu.h

echo "::: 3. build libcef_dll_wrapper.a"
if [ ! -f vendors/cef/build/libcef_dll_wrapper/libcef_dll_wrapper.a ]; then
  ( cd vendors/cef && mkdir -p build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. >/dev/null \
    && make -j"$(nproc)" libcef_dll_wrapper >/dev/null )
fi
ls -la vendors/cef/build/libcef_dll_wrapper/libcef_dll_wrapper.a

echo "::: 4. reuse host libasar.so"
mkdir -p vendors/zig-asar
cp -f /work/libasar.so vendors/zig-asar/libasar.so

echo "::: 5. compile + link patched libNativeWrapper_cef.so"
CEFINC=vendors/cef
CFLAGS=$(pkg-config --cflags webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1)
LIBS=$(pkg-config --libs webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1)
mkdir -p src/native/linux/build src/native/build

g++ -c -std=c++20 -fPIC $CFLAGS -I"$CEFINC" -Ivendors/wgpu/linux-x64/include \
  -o src/native/linux/build/nativeWrapper.o src/native/linux/nativeWrapper.cpp
g++ -c -std=c++20 -fPIC -I"$CEFINC" \
  -o src/native/linux/build/cef_loader.o src/native/linux/cef_loader.cpp
g++ -shared -o src/native/build/libNativeWrapper_cef.so \
  src/native/linux/build/nativeWrapper.o src/native/linux/build/cef_loader.o \
  vendors/zig-asar/libasar.so $LIBS \
  -Wl,--whole-archive vendors/cef/build/libcef_dll_wrapper/libcef_dll_wrapper.a -Wl,--no-whole-archive \
  -ldl -lpthread -Wl,-rpath,'$ORIGIN:$ORIGIN/cef'

echo "::: DONE"
ls -la src/native/build/libNativeWrapper_cef.so
strings src/native/build/libNativeWrapper_cef.so | grep 'NATIVE WRAPPER VERSION' || true
