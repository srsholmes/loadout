import { sdk } from "../../lib/sdk";

await sdk.ready;

if (!sdk.romPath) {
  throw new Error(
    "Render96-RT requires a Super Mario 64 US ROM (.z64). " +
      "Pick one in the ROM panel and click Install again.",
  );
}

// Fedora translation of the deps list from the sm64rt-linux-guide
// installer (which targets Arch). `mingw64-glew` covers the OpenGL
// helper lib; the base `mingw64-SDL2` package isn't in Fedora repos
// so we pull the SDL2 mingw devel tarball directly below.
// `p7zip` is needed to unpack the Render96 model pack later.
sdk.progress("Installing cross-compile toolchain in container…");
await sdk.env.ensurePackages([
  "make",
  "git",
  "python3",
  "p7zip",
  // Native toolchain for the host-side asset tools (`make -C tools`
  // builds n64graphics/skyconv/mio0/… with the container's own gcc, not
  // mingw). Without these the tools build dies with "Error 127" (gcc not
  // found); n64graphics also links libpng, so libpng-devel is required.
  "gcc",
  "gcc-c++",
  "libpng-devel",
  "mingw64-gcc",
  "mingw64-gcc-c++",
  "mingw64-binutils",
  "mingw64-headers",
  "mingw64-crt",
  "mingw64-winpthreads",
  "mingw64-glew",
  // RT64 build links OpenGL libs statically via `-lglew32 -static`
  // even though the runtime path is D3D12 → static archive needed.
  // Without it: `cannot find -lglew32 — have you installed the
  // static version?`
  "mingw64-glew-static",
]);

// The Render96ex Makefile invokes `$(CROSS)sdl2-config` to
// discover SDL2 cflags/libs. Fedora ships no `mingw64-SDL2` base
// package, so we fetch the official mingw devel tarball from
// libsdl-org/SDL into the install dir.
//
// The bundled `sdl2-config` script has a known bug: `--cflags` and
// `--libs` echo hardcoded `/tmp/tardir/...` paths from the SDL
// build host, ignoring its own `prefix` autodetection AND the
// `--prefix=` arg. We sed-patch the four offending lines to use
// the autodetected `${prefix}` / `${libdir}` instead (same fix as
// the sm64rt-linux-guide installer). After patching, SDLCONFIG can
// point at the bundled script directly — no wrapper needed.
const SDL2_VER = "2.30.10";
sdk.progress(`Fetching SDL2 ${SDL2_VER} mingw devel…`);
await sdk.env.run(
  [
    "set -e",
    "mkdir -p _deps/sdl2",
    "cd _deps/sdl2",
    `if [ ! -d SDL2-${SDL2_VER} ]; then`,
    `  curl -fsSL -o sdl2.tar.gz https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_VER}/SDL2-devel-${SDL2_VER}-mingw.tar.gz`,
    `  tar -xzf sdl2.tar.gz`,
    `  rm sdl2.tar.gz`,
    "fi",
    `SDL_CFG=SDL2-${SDL2_VER}/x86_64-w64-mingw32/bin/sdl2-config`,
    // Replace the hardcoded /tmp/tardir libdir with the
    // script-relative ${prefix}/lib so it tracks wherever the
    // extracted tree lives now.
    `sed -i 's|^libdir=/tmp/tardir.*|libdir=\${prefix}/lib|' "$SDL_CFG"`,
    // Rewrite --cflags / --libs / --static-libs -L to use the
    // resolved ${prefix} / ${libdir} variables instead of the
    // baked-in build paths. Quoting the sed scripts in double
    // quotes so we can interpolate $libdir literally — the script
    // itself substitutes it at runtime.
    `sed -i 's|echo -I/tmp/tardir.*include/SDL2 .*|echo -I\${prefix}/include -I\${prefix}/include/SDL2 -Dmain=SDL_main|' "$SDL_CFG"`,
    `sed -i 's|echo -L/tmp/tardir[^ ]* |echo -L\${libdir} |g' "$SDL_CFG"`,
  ].join("\n"),
  { cwd: sdk.installDir, stage: "installing-deps" },
);

sdk.progress("Cloning Render96/Render96ex (tester_rt64alpha)…");
await sdk.cloneFromGitHub("Render96/Render96ex", "tester_rt64alpha");

sdk.progress("Placing baserom.us.z64…");
await sdk.placeRom("baserom.us.z64");

// Build host-side tools first. These are small C programs
// (`mio0`, `n64graphics`, `skyconv`, …) invoked by the main
// Makefile during asset extraction; they compile with the host
// gcc, NOT mingw — passing CROSS to their Makefile would build
// them as Windows .exe's which can't run during our Linux build.
// The main make assumes they're pre-built and dies with
// `FileNotFoundError: ./tools/mio0` otherwise.
sdk.progress("Building host-side asset tools…");
await sdk.env.run("make -j$(nproc) -C tools", {
  cwd: sdk.installDir,
  stage: "building",
  timeoutMs: 5 * 60_000,
});

// Two patch sets:
//
//   1. mingw ships <windows.h> lowercase only — the upstream RT64
//      headers were authored on case-insensitive NTFS and use the
//      MSVC-style <Windows.h>. Fix matches sm64rt-linux-guide.
//
//   2. The Makefile reinvokes `make -C tools` from inside the main
//      build via a shell line that interpolates CC literally:
//        DUMMY != CC=$(CC) CXX=$(CXX) $(MAKE) -C tools -j1
//      That means any flags inside CC become separate shell tokens
//      after `CC=…`, and the shell tries to exec the first flag —
//      we hit `/bin/sh: -Wno-error: command not found`. So we keep
//      CC clean (no flags) and inject GCC-16-friendly `-Wno-error`
//      flags directly into the WINDOWS_BUILD CFLAGS line in the
//      Makefile. The Render96ex tester branch hasn't been touched
//      since 2024 and predates GCC 16's stricter C23 defaults.
sdk.progress("Patching headers + Makefile for GCC 16 / mingw…");
await sdk.env.run(
  [
    "set -e",
    "sed -i 's|<Windows.h>|<windows.h>|g' include/rt64/rt64.h",
    "sed -i 's|<Windows.h>|<windows.h>|g' src/pc/gfx/gfx_rt64_context.h",
    // audio_sdl.c uses stderr/fprintf without including <stdio.h>.
    // Mainline gcc accepted this implicitly; GCC 16 promotes it to
    // a hard error. Inject the include right after the existing
    // SDL2/SDL.h line.
    `sed -i '/^#include <SDL2\\/SDL.h>/a #include <stdio.h>' src/pc/audio/audio_sdl.c`,
    // Append the disables to the Windows CFLAGS line. The marker we
    // anchor on is the trailing `-fpermissive` that uniquely
    // identifies the WINDOWS_BUILD CFLAGS assignment.
    "sed -i 's|-fno-strict-aliasing -fwrapv -fpermissive$|-fno-strict-aliasing -fwrapv -fpermissive -Wno-error -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types -Wno-error=int-conversion|' Makefile",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// Cross-compile the .exe. RENDER_API=RT64 selects the path-tracing
// backend (RT64 wraps D3D12 + DXR internally); `D3D12` would build
// the plain D3D12 backend with a different — and vkd3d-proton-
// incompatible — shader set. The Makefile's helper comment at line
// 54 listing "GL, GL_LEGACY, D3D11, D3D12" is stale — the actual
// RT path is at line 419 (`ifeq ($(RENDER_API),RT64)`).
//
// TEXTURE_FIX=1 matches what sm64rt-linux-guide passes and fixes
// some N64-era texture glitches under RT64's HD pipeline.
//
// WINDOW_API isn't set explicitly because the Makefile auto-picks
// DXGI for any non-GL render API, so SDL2 is only pulled in for
// audio + controller (still needed).
//
// `NO_BZERO_BCOPY=1` avoids a glibc-only symbol the mingw libc
// lacks; matches what the upstream MXE branch does for non-static
// mingw.
//
// CC/CXX/LD/AS/OBJCOPY/OBJDUMP are passed explicitly because the
// Makefile uses `CC ?= $(CROSS)gcc` / `CXX ?= $(CROSS)g++` which
// `?=` does NOT override make's built-in CC=cc / CXX=g++ — without
// these overrides the D3D12/DXGI .cpp files compile with host g++
// and die with `windows.h: No such file or directory`. The
// Makefile's WINDOWS_BUILD branch hard-codes `OBJCOPY := objcopy`
// (no CROSS prefix) which is a Makefile bug; we override.
//
// GCC-16 `-Wno-error*` flags are NOT passed here — they live in
// the Makefile's CFLAGS line via the sed-patch above. Putting them
// in CC would break the inner `DUMMY != CC=$(CC) … make -C tools`
// invocation because the shell parses the CC value as multiple
// tokens.
sdk.progress("Cross-compiling (takes 5-10 minutes)…");
await sdk.env.run(
  [
    "make -j$(nproc)",
    "VERSION=us",
    "RENDER_API=RT64",
    "EXTERNAL_DATA=1",
    "TEXTURE_FIX=1",
    "WINDOWS_BUILD=1",
    "CROSS=x86_64-w64-mingw32-",
    "TARGET_ARCH=i386pe",
    "TARGET_BITS=64",
    "NO_BZERO_BCOPY=1",
    "CC=x86_64-w64-mingw32-gcc",
    "CXX=x86_64-w64-mingw32-g++",
    "LD=x86_64-w64-mingw32-g++",
    "AS=x86_64-w64-mingw32-as",
    "OBJCOPY=x86_64-w64-mingw32-objcopy",
    "OBJDUMP=x86_64-w64-mingw32-objdump",
    `SDLCONFIG=${sdk.installDir}/_deps/sdl2/SDL2-${SDL2_VER}/x86_64-w64-mingw32/bin/sdl2-config`,
  ].join(" "),
  { cwd: sdk.installDir, stage: "building", timeoutMs: 30 * 60_000 },
);

// Render96 DynOS model pack — adds the HD character + scenery
// models. Unpacked into `build/us_pc/dynos/packs/` per the upstream
// README. Pinned to the version we tested against; users update by
// reinstalling once we bump this.
const MODELPACK_VER = "3.25";
sdk.progress(`Downloading Render96 ModelPack v${MODELPACK_VER}…`);
await sdk.env.run(
  [
    "set -e",
    "mkdir -p build/us_pc/dynos/packs",
    `curl -fsSL -o _deps/modelpack.7z https://github.com/Render96/ModelPack/releases/download/${MODELPACK_VER}/Render96_DynOs_v${MODELPACK_VER}.7z`,
    "7za x -y -obuild/us_pc/dynos/packs _deps/modelpack.7z",
    "rm _deps/modelpack.7z",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "extracting", timeoutMs: 10 * 60_000 },
);

// Render96 HD texture pack — repo of PNGs that go under
// build/us_pc/res/gfx/. Cloned shallow to save bandwidth; it's
// large (~hundreds of MB).
sdk.progress("Cloning Render96 HD texture pack (large)…");
await sdk.env.run(
  [
    "set -e",
    "mkdir -p build/us_pc/res/gfx",
    "rm -rf _deps/textures",
    "git clone --depth 1 -b master https://github.com/pokeheadroom/RENDER96-HD-TEXTURE-PACK.git _deps/textures",
    // The pack ships `gfx/...` at its root; copy the contents (not
    // the gfx dir itself) into res/gfx.
    "cp -rT _deps/textures/gfx build/us_pc/res/gfx",
    "rm -rf _deps/textures",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "extracting", timeoutMs: 15 * 60_000 },
);

// Stage runtime DLLs next to the .exe so Wine/Proton finds them
// via the standard "executable's directory" DLL search.
//
//   - `lib/rt64/*.dll`: the RT64 runtime + its bundled DXR
//     dependencies (dxcompiler, dxil, DLSS, XeSS, FSR2). Without
//     these the binary aborts on startup. The Makefile_rt64
//     snippet `RT64_COPY_LIB` is supposed to do this auto, but in
//     practice it doesn't fire reliably (the `$(call ...)` runs at
//     parse time, before BUILD_DIR is fully resolved). Cheaper to
//     just cp here.
//
//   - `SDL2.dll` from the mingw devel tarball: the .exe links to
//     it via the import library; Wine needs the actual DLL at
//     load time. Without it: "The code execution cannot proceed
//     because SDL2.dll was not found."
sdk.progress("Staging runtime DLLs next to the .exe…");
await sdk.env.run(
  [
    "set -e",
    "cp -f lib/rt64/*.dll build/us_pc/",
    `cp -f _deps/sdl2/SDL2-${SDL2_VER}/x86_64-w64-mingw32/bin/SDL2.dll build/us_pc/`,
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// ════════════════════════════════════════════════════════════════════
// Runtime: dedicated wine + custom vkd3d-proton
// ════════════════════════════════════════════════════════════════════
//
// Why we don't just use Proton:
//   RT64's pre-compiled DXR shader blobs use a `RootSignature` HLSL
//   attribute that none of the shipping vkd3d-proton versions parse
//   (tested Proton-Experimental, Proton 10.0, Proton Hotfix,
//   GE-Proton10-34 — all fail with either
//     d3d12_root_signature_create_from_blob: vkd3d result -1
//   or
//     d3dcompiler:D3DCompile2 W5302: Ignoring unknown attribute "RootSignature"
//   ). Building vkd3d-proton from master is what the upstream
//   sm64rt-linux-guide does, and that's the only path that actually
//   runs RT64 on Linux today.
//
// What we set up:
//   1. Build vkd3d-proton-master (mingw cross-compile)        ~5 min
//   2. Init a per-game wineprefix at  ${installDir}/wineprefix
//   3. Drop our built d3d12.dll / d3d12core.dll into system32 +
//      syswow64 of that prefix
//   4. Pull DXVK's dxgi.dll into the prefix
//   5. Install vcrun2019, vcrun2022, d3dcompiler_47 via winetricks
//   6. Write `launcher.sh` that re-enters the recomp distrobox at
//      run time and invokes wine with this prefix + VKD3D_CONFIG=dxr
//
// The launcher is what we hand back to the host as the launch
// command, so Steam invokes it as a native Linux script — no Proton
// compat tool, no distrobox auto-wrapper.

sdk.progress("Installing host wine + vkd3d-proton build deps…");
await sdk.env.ensurePackages([
  "meson",
  "ninja-build",
  "glslang",
  "vulkan-headers",
  "mingw64-vulkan-headers",
  // mingw-w64-tools provides `x86_64-w64-mingw32-widl`, the Wine
  // IDL compiler vkd3d-proton's meson script invokes to generate
  // COM RPC stubs. Without it meson configure dies with
  // `Program 'x86_64-w64-mingw32-widl' not found`.
  "mingw-w64-tools",
  "wine",
  "winetricks",
]);

sdk.progress("Cloning + building vkd3d-proton master (~5 min)…");
// `package-release.sh` is vkd3d-proton's canonical packaging script.
// By default it builds both 64-bit and 32-bit mingw artifacts —
// we only need 64-bit (Render96-RT is a single 64-bit .exe), and
// Fedora ships mingw32-* as a separate package set that adds ~6
// dependencies for no runtime gain. We sed-patch the script's
// `build_arch 86` line out so only the x64 build runs.
await sdk.env.run(
  [
    "set -e",
    "mkdir -p _deps",
    "if [ ! -d _deps/vkd3d-src ]; then",
    "  git clone --recurse-submodules https://github.com/HansKristian-Work/vkd3d-proton.git _deps/vkd3d-src",
    "else",
    "  (cd _deps/vkd3d-src && git fetch origin master && git checkout master && git pull origin master && git submodule update --init --recursive)",
    "fi",
    // Skip x86 build (saves ~5 min and a heavy package install).
    "sed -i 's|^  build_arch 86|  : # build_arch 86 skipped — Render96-RT is x64-only|' _deps/vkd3d-src/package-release.sh",
    "rm -rf _deps/vkd3d-out",
    "mkdir -p _deps/vkd3d-out",
    `cd _deps/vkd3d-src && ./package-release.sh master "${sdk.installDir}/_deps/vkd3d-out" --no-package`,
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building", timeoutMs: 20 * 60_000 },
);

// Per-game wineprefix lives inside the install dir so uninstall is a
// simple `rm -rf installDir`. WINEDLLOVERRIDES=mscoree= suppresses
// the wine-mono "do you want to install?" prompt during wineboot —
// SM64 doesn't need .NET.
const WINEPREFIX_REL = "wineprefix";
const WINEPREFIX_ABS = `${sdk.installDir}/${WINEPREFIX_REL}`;

sdk.progress("Initialising wineprefix…");
await sdk.env.run(
  [
    "set -e",
    `export WINEPREFIX="${WINEPREFIX_ABS}"`,
    "export WINEDLLOVERRIDES='mscoree='",
    "wineboot -u",
    "wineserver -w",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building", timeoutMs: 5 * 60_000 },
);

sdk.progress("Installing patched vkd3d-proton DLLs into wineprefix…");
// x64 only — Render96-RT is a 64-bit binary, syswow64 stays
// untouched. If a future recipe ships a 32-bit binary using this
// same prefix, also remove the build-script patch above.
await sdk.env.run(
  [
    "set -e",
    `cp _deps/vkd3d-out/vkd3d-proton-master/x64/d3d12.dll "${WINEPREFIX_ABS}/drive_c/windows/system32/"`,
    `cp _deps/vkd3d-out/vkd3d-proton-master/x64/d3d12core.dll "${WINEPREFIX_ABS}/drive_c/windows/system32/"`,
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// DXVK provides the dxgi.dll that translates DXGI (swapchain /
// adapter enumeration) → Vulkan. Wine ships its own builtin dxgi but
// it's less featureful; the override below tells wine to prefer the
// native DXVK one. Version pinned to match what sm64rt-linux-guide
// last tested against.
const DXVK_VER = "2.6.2";
sdk.progress(`Installing DXVK ${DXVK_VER} dxgi.dll…`);
await sdk.env.run(
  [
    "set -e",
    "mkdir -p _deps/dxvk",
    `if [ ! -f _deps/dxvk/dxvk-${DXVK_VER}/x64/dxgi.dll ]; then`,
    `  curl -fsSL -o _deps/dxvk/dxvk.tar.gz https://github.com/doitsujin/dxvk/releases/download/v${DXVK_VER}/dxvk-${DXVK_VER}.tar.gz`,
    "  tar -xzf _deps/dxvk/dxvk.tar.gz -C _deps/dxvk",
    "  rm _deps/dxvk/dxvk.tar.gz",
    "fi",
    `cp _deps/dxvk/dxvk-${DXVK_VER}/x64/dxgi.dll "${WINEPREFIX_ABS}/drive_c/windows/system32/"`,
    // x32 dxgi skipped — see DLL install above for rationale.
    `export WINEPREFIX="${WINEPREFIX_ABS}"`,
    // Tell wine to prefer the native (DXVK) dxgi over its builtin.
    `wine reg add 'HKCU\\Software\\Wine\\DllOverrides' /v dxgi /d native,builtin /f`,
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building", timeoutMs: 5 * 60_000 },
);

// VC++ runtimes — RT64's dxcompiler.dll links against the
// 2019/2022 redistributables, d3dcompiler_47 is needed for the
// non-DXR shader paths the .exe also touches. winetricks downloads
// these from MS and silently installs into the prefix. The trailing
// `|| true` keeps the install from failing if winetricks complains
// about a non-critical verb (e.g. font cache).
sdk.progress("Installing VC++ runtimes via winetricks (~2 min)…");
// vcrun2022 conflicts with vcrun2019 (winetricks reports them as
// mutually-exclusive in recent versions) — `--force` past that
// check so we get both 14.x and 17.x C++ runtimes side by side,
// matching what RT64's bundled DLLs expect. `|| true` makes the
// whole step non-fatal for the same reason as before (a missing
// optional verb shouldn't fail the install).
await sdk.env.run(
  [
    "set -e",
    `export WINEPREFIX="${WINEPREFIX_ABS}"`,
    "winetricks -q vcrun2019 d3dcompiler_47 || true",
    "winetricks -q --force vcrun2022 || true",
    "wineserver -w",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building", timeoutMs: 15 * 60_000 },
);

// SDL community gamepad DB — Render96ex looks for this under
// `res/db/`. Without it, controllers that aren't in SDL's bundled
// mapping list (most 8BitDo, recent Xbox, etc.) come up as
// no-buttons-bound. Cheap to ship.
sdk.progress("Installing SDL gamepad DB…");
await sdk.env.run(
  [
    "set -e",
    "mkdir -p build/us_pc/res/db",
    "curl -fsSL -o build/us_pc/res/db/gamecontrollerdb.txt https://raw.githubusercontent.com/mdqinc/SDL_GameControllerDB/master/gamecontrollerdb.txt",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// launcher.sh: native Linux entry point. Re-enters the recomp
// distrobox at run time, sets the wineprefix + VKD3D_CONFIG=dxr
// (enables ray tracing in vkd3d-proton), exec's wine on the .exe.
// Heredoc terminator must be unquoted so we interpolate the absolute
// paths at write-time — they're baked into the script.
//
// Not using `sdk.writeLauncher` here because that helper exec's
// the binary directly — this recipe needs to exec WINE which then
// loads the .exe, which is a different invocation shape. Inline
// heredoc stays self-contained inside this recipe.
sdk.progress("Writing launcher.sh…");
await sdk.env.run(
  [
    `cat > launcher.sh <<EOF`,
    `#!/usr/bin/env bash`,
    `# Auto-generated by the recomp sm64-render96-rt setup.ts.`,
    `# Runs Render96ex RT64 through host wine inside the recomp-build`,
    `# distrobox, using a locally-built vkd3d-proton with the RT shader`,
    `# blob parse support that shipped Proton doesn't yet have.`,
    `# Strip Steam's LD_PRELOAD (gameoverlayrenderer.so → needs host`,
    `# libGL.so.1) + LD_LIBRARY_PATH on the host before entering the`,
    `# container, or every binary inside dies on libGL. env runs on the`,
    `# host (which has libGL) so the strip is safe.`,
    `exec env -u LD_PRELOAD -u LD_LIBRARY_PATH distrobox enter recomp-build -- env \\\\`,
    `  WINEPREFIX="${WINEPREFIX_ABS}" \\\\`,
    `  VKD3D_CONFIG=dxr \\\\`,
    // d3d12 + d3d12core MUST be native so wine loads OUR patched
    // vkd3d-proton instead of its builtin (which doesn't have RT
    // support). dxgi=native pulls in DXVK's translator. The
    // winetricks d3dcompiler_47 step installs the MS native DLL
    // but does NOT register the override; we set it here so the
    // .exe's HLSL compiles go through MS's d3dcompiler instead of
    // wine's vkd3d-shader fallback (which throws on RT64 root sigs).
    `  WINEDLLOVERRIDES="d3d12=n,b;d3d12core=n,b;dxgi=n,b;d3dcompiler_47=n,b" \\\\`,
    `  SDL_GAMECONTROLLERCONFIG_FILE="${sdk.installDir}/build/us_pc/res/db/gamecontrollerdb.txt" \\\\`,
    `  SDL_JOYSTICK_HIDAPI=1 \\\\`,
    // --fullscreen on launch: sm64ex's --fullscreen CLI flag.
    // Fixes the desktop-mode focus issue where the windowed game
    // gets mouse but not keyboard focus under KDE Wayland, AND
    // makes a more cinematic first-launch experience.
    `  bash -c 'cd "${sdk.installDir}/build/us_pc" && exec wine sm64.us.f3dex2e.exe --fullscreen "\\$@"' -- "\\$@"`,
    `EOF`,
    "chmod +x launcher.sh",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// We hand the .exe to declareOutput just so Phase D's
// existence-check has something concrete to verify (the .exe is
// what we actually built). The launcher.sh is what Steam invokes.
// targetPlatform stays default ("linux") because launcher.sh IS a
// native Linux script — we want Steam to run it without Proton
// compat-tool wrapping.
sdk.declareOutput("build/us_pc/sm64.us.f3dex2e.exe");
sdk.declareLaunchCommand(`${sdk.installDir}/launcher.sh`);
sdk.reportVersion("tester_rt64alpha+vkd3d-proton-master");
