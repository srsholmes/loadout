import { sdk } from "../../lib/sdk";

await sdk.ready;

if (!sdk.romPath) {
  throw new Error("OoT decomp build requires the GC EUR MQ Debug ROM (.z64)");
}

sdk.progress("Installing build dependencies inside container…");
// zeldaret/oot needs a MIPS cross-compiler for the N64 R4300i
// target (32-bit MIPS-III). Fedora ships only the 64-bit variant
// (`mips64-linux-gnu-*`), not the Debian-style `mips-linux-gnu-*`
// the decomp's README assumes. The 64-bit toolchain produces
// correct N64 code as long as we tell the Makefile to use the
// `mips64-linux-gnu-` prefix and `-mabi=32 -march=mips3`, which we
// do below via the CROSS_COMPILE override.
//
// Host-side tools (gcc / python / libpng / libxml2 / libelf) are
// for the asset-extraction step (`make setup`) which runs Python
// scripts and a small C decomp tool.
await sdk.env.ensurePackages([
  "make",
  "gcc",
  "gcc-c++",
  "python3",
  "python3-pip",
  "pkgconf-pkg-config",
  "libpng-devel",
  "libxml2-devel",
  "libelf-devel",
  "binutils-mips64-linux-gnu",
  "gcc-mips64-linux-gnu",
  "gcc-c++-mips64-linux-gnu",
]);

sdk.progress("Cloning zeldaret/oot…");
await sdk.cloneFromGitHub("zeldaret/oot", "main");

sdk.progress("Placing baserom.z64…");
await sdk.placeRom("baseroms/gc-eu-mq-dbg/baserom.z64");

// CROSS_COMPILE override threads Fedora's mips64- prefix through
// the OoT Makefile. The decomp's Makefile reads `$(CROSS)` to
// build the tool name (`$(CROSS)gcc`, `$(CROSS)objcopy`, …) — set
// it once and everything downstream follows.
sdk.progress("Running `make setup` (extracts assets — 5-15 minutes)…");
await sdk.env.run("make setup CROSS=mips64-linux-gnu-", {
  cwd: sdk.installDir,
  stage: "setup",
  timeoutMs: 30 * 60_000,
});

sdk.progress("Building (this can take 10-30 minutes)…");
await sdk.env.run("make -j$(nproc) CROSS=mips64-linux-gnu-", {
  cwd: sdk.installDir,
  stage: "building",
  timeoutMs: 60 * 60_000,
});

sdk.declareOutput("build/gc-eu-mq-dbg/zelda_ocarina_mq_dbg.z64");
sdk.reportVersion("main");
