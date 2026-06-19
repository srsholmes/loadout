import { sdk } from "../../lib/sdk";

// Wait for the host to deliver installDir / romPath / env.
await sdk.ready;

if (!sdk.romPath) {
  throw new Error("SM64 build requires a Super Mario 64 US (.z64) ROM");
}

// Fedora package set: same as upstream sm64ex. Render96ex master
// adds DynOS + HD-asset hooks on top of the same C build, so we
// reuse the same dep list. Note Fedora 44+ dropped the standalone
// SDL2 packages and ships `sdl2-compat-devel` as an ABI shim on
// top of SDL3 — it provides the same `pkgconfig(sdl2)` and
// `libSDL2.so` the build looks for. gcc-c++ is needed even though
// the project is largely C: generated headers include C++ shims.
sdk.progress("Installing build dependencies inside container…");
await sdk.env.ensurePackages([
  "make",
  "git",
  "gcc",
  "gcc-c++",
  "python3",
  "pkgconf-pkg-config",
  "audiofile-devel",
  "sdl2-compat-devel",
  "glew-devel",
]);

// We build Render96ex's `tester` branch (NOT master — master
// dropped DynOS entirely; only the tester/* branches still carry
// the model-pack runtime that lets users swap to the Render96 HD
// Mario / Luigi / Wario meshes at runtime). The `tester` branch is
// the non-RT64 counterpart to `tester_rt64alpha` (which our
// sm64-render96-rt recipe uses) — same source tree minus the RT64
// path-tracer integration.
//
// Default RENDER_API=GL gives modern OpenGL — native Linux ELF,
// no wine, no Proton, no vkd3d. Render96ex's GL backend handles HD
// texture replacement via EXTERNAL_DATA=1 (textures are loaded
// from res/gfx/ at runtime, no rebuild needed when the pack
// changes).
sdk.progress("Cloning Render96/Render96ex (tester)…");
await sdk.cloneFromGitHub("Render96/Render96ex", "tester");

sdk.progress("Placing baserom.us.z64…");
await sdk.placeRom("baserom.us.z64");

// The main Makefile re-invokes `make -C tools` from inside the
// asset-extraction step as:
//   DUMMY != CC=$(CC) CXX=$(CXX) $(MAKE) -C tools >&2 || echo FAIL
// A CC value with embedded flags would have the shell split on
// spaces, so `CC=gcc -Wno-error …` ends up trying to exec
// `-Wno-error` as a command. Identical trap as `tester_rt64alpha`.
//
// Workaround: build tools with host gcc up-front (no overrides),
// then inject the gcc-16 `-Wno-error*` flags into the Makefile's
// CFLAGS via sed so they apply to the main build without going
// through CC, and patch the missing <stdio.h> include in
// audio_sdl.c (gcc 16 promotes implicit fprintf/stderr usage to a
// hard error).
sdk.progress("Building host-side asset tools…");
await sdk.env.run("make -j$(nproc) -C tools", {
  cwd: sdk.installDir,
  stage: "building",
  timeoutMs: 5 * 60_000,
});

sdk.progress("Patching audio_sdl.c + Makefile for GCC 16…");
await sdk.env.run(
  [
    "set -e",
    `grep -q '#include <stdio.h>' src/pc/audio/audio_sdl.c || sed -i '/^#include <SDL2\\/SDL.h>/a #include <stdio.h>' src/pc/audio/audio_sdl.c`,
    // Append -Wno-error flags to the non-WINDOWS_BUILD CFLAGS line.
    // The marker is the trailing `-fwrapv` after the fpermissive
    // version-specific CFLAGS assignment (Render96ex tester has
    // it without the trailing -fpermissive on the Linux branch).
    "sed -i 's|-fno-strict-aliasing -fwrapv$|-fno-strict-aliasing -fwrapv -Wno-error -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types -Wno-error=int-conversion|' Makefile",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "building" },
);

// EXTERNAL_DATA=1 → textures load from res/gfx/ at runtime. CC is
// kept clean (no flags) so the sub-make tools invocation doesn't
// break; the flags live in the Makefile's CFLAGS via the sed-patch
// above.
sdk.progress("Building Render96ex (this can take 3-6 minutes)…");
await sdk.env.run(
  `make -j$(nproc) VERSION=us BETTERCAMERA=1 EXTERNAL_DATA=1`,
  { cwd: sdk.installDir, stage: "building", timeoutMs: 30 * 60_000 },
);

// HD assets: the Render96 DynOS pack (HD character + scenery
// models) goes into build/us_pc/dynos/packs/. Users have to enable
// individual packs in-game (Pause → Options → DynOS → Model Packs)
// because the system is designed for opt-in mix-and-match — auto-
// enabling would override anyone running their own custom packs.
const MODELPACK_VER = "3.25";
sdk.progress(`Downloading Render96 ModelPack v${MODELPACK_VER}…`);
await sdk.env.ensurePackages(["p7zip"]);
await sdk.env.run(
  [
    "set -e",
    "mkdir -p build/us_pc/dynos/packs _deps",
    `curl -fsSL -o _deps/modelpack.7z https://github.com/Render96/ModelPack/releases/download/${MODELPACK_VER}/Render96_DynOs_v${MODELPACK_VER}.7z`,
    "7za x -y -obuild/us_pc/dynos/packs _deps/modelpack.7z",
    "rm _deps/modelpack.7z",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "extracting", timeoutMs: 10 * 60_000 },
);

// HD texture pack — repo of PNGs replacing the original N64
// textures. With EXTERNAL_DATA=1 the build loads textures from
// res/gfx/ at runtime, so these "just work" with no further wiring.
// Shallow clone to keep download manageable (~400 MB even shallow).
sdk.progress("Cloning Render96 HD texture pack (large, ~5 min)…");
await sdk.env.run(
  [
    "set -e",
    "mkdir -p build/us_pc/res/gfx",
    "rm -rf _deps/textures",
    "git clone --depth 1 -b master https://github.com/pokeheadroom/RENDER96-HD-TEXTURE-PACK.git _deps/textures",
    // The pack ships `gfx/<actors|levels|textures>` at its root;
    // copy the *contents* (not the gfx dir itself) into res/gfx.
    "cp -rT _deps/textures/gfx build/us_pc/res/gfx",
    "rm -rf _deps/textures",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "extracting", timeoutMs: 15 * 60_000 },
);

// launcher.sh: opens the game in fullscreen by default. Without
// `--fullscreen`, sm64ex spawns a small windowed instance and KDE
// Wayland often refuses it keyboard focus (mouse hover events
// reach the window, keyboard / controller don't, because the
// window never becomes "active"). Fullscreen mode takes the
// implicit keyboard grab fullscreen apps get. F11 toggles in-game.
sdk.progress("Writing launcher.sh (fullscreen)…");
const launcherPath = await sdk.writeLauncher({
  exe: "build/us_pc/sm64.us.f3dex2e",
  args: ["--fullscreen"],
});

sdk.declareOutput("build/us_pc/sm64.us.f3dex2e");
sdk.declareLaunchCommand(launcherPath);
sdk.reportVersion("master+render96-hd");
