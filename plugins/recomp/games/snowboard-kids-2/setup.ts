import { sdk } from "../../lib/sdk";

// Wait for the host to deliver installDir / romPath / env.
await sdk.ready;

if (!sdk.romPath) {
  throw new Error(
    "Snowboard Kids 2 decomp build requires a big-endian Snowboard Kids 2 ROM (.z64)",
  );
}

// cdlewis/snowboardkids2-decomp is a byte-matching N64 decompilation.
// The build pipeline is:
//   1. split the user's ROM into asm/assets/data with splat (`make extract`)
//   2. reassemble the ROM from source (`make`) and verify it byte-for-byte
//      against the original (default `all` target runs `verify`).
//
// Toolchain notes:
//   - The Makefile auto-detects the cross-assembler/linker prefix,
//     preferring `mips-linux-gnu-`, then `mips64-linux-gnu-` (what
//     Fedora ships as `binutils-mips64-linux-gnu`), then `mips64-elf-`.
//     We install the Fedora mips64 binutils so `as`/`ld`/`objcopy`/
//     `objdump` resolve; no CROSS override needed.
//   - The actual N64 *C compiler* is the period-correct KMC gcc 2.7.2,
//     which `tools/Makefile` curls from the decompals release mirror
//     into `tools/gcc_kmc/`. So we must build the tools first.
//   - Host gcc/python are for splat, the asset extractor, and the small
//     C helper tools under tools/.
sdk.progress("Installing build dependencies inside container…");
await sdk.env.ensurePackages([
  "make",
  "git",
  "gcc",
  // The main build runs a `clang -fsyntax-only` check pass on every C
  // source before the real KMC-gcc compile (the Makefile's CC_CHECK), so
  // clang is required even though the actual codegen is gcc 2.7.2.
  "clang",
  "python3",
  "python3-pip",
  "curl",
  "tar",
  // Provides mips64-linux-gnu-{as,ld,objcopy,objdump}; the Makefile's
  // find-command auto-detection picks this prefix on Fedora.
  "binutils-mips64-linux-gnu",
]);

sdk.progress("Cloning cdlewis/snowboardkids2-decomp…");
await sdk.cloneFromGitHub("cdlewis/snowboardkids2-decomp", "main");

// GitHub source tarballs (what cloneFromGitHub downloads) do NOT include
// submodule contents, but the build needs three of them: lib/ultralib and
// lib/libmus are compiled into libgultra_rom.a / libmus.a and linked into
// the ROM, and lib/f3dex2 supplies microcode headers (see the Makefile's
// IINC / LIBULTRA / LIBMUS). `make setup` would normally `git submodule
// update --init`, but there's no .git in a tarball checkout, so we fetch
// each submodule at the commit pinned by the parent repo. Cloning with git
// (rather than another tarball) also gives each submodule its own .git, so
// the build's `make -C lib/ultralib setup` works. The tools/asm-differ and
// tools/decomp-permuter submodules are dev/diff tooling a plain build never
// touches, so we skip them.
sdk.progress("Fetching git submodules (ultralib, libmus, f3dex2)…");
await sdk.env.run(
  [
    "set -e",
    "fetch_submodule() {",
    '  rm -rf "$2"; mkdir -p "$2"',
    '  git -C "$2" init -q',
    '  git -C "$2" remote add origin "$1"',
    '  git -C "$2" fetch -q --depth 1 origin "$3"',
    '  git -C "$2" checkout -q FETCH_HEAD',
    "}",
    "fetch_submodule https://github.com/cdlewis/ultralib.git lib/ultralib c2badeea898d1de3b3722a2c038e5d9597a477b8",
    "fetch_submodule https://github.com/cdlewis/libmus.git lib/libmus 123a807db6f23e2e3f1c2f0245ff586bc2aaef38",
    "fetch_submodule https://github.com/Mr-Wiseguy/f3dex2.git lib/f3dex2 f3ef9bc0b8f8aaeafc0af6b04deaab74023943e5",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "setup", timeoutMs: 10 * 60_000 },
);

// The base ROM must be a big-endian (.z64) Snowboard Kids 2 ROM placed
// at the repo root as `snowboardkids2.z64`. splat reads it during
// `make extract`, and the build's verify step diffs against it.
sdk.progress("Placing snowboardkids2.z64…");
await sdk.placeRom("snowboardkids2.z64");

// Python deps (splat64, mapfile_parser, m2c, …) go in a project-local
// virtualenv so we don't touch the container's system site-packages,
// then we point the Makefile's `PYTHON` at the venv interpreter for
// every subsequent make invocation. `m2c @ git+…` in requirements.txt
// is why we installed git above.
sdk.progress("Setting up Python virtualenv + splat (this can take a few minutes)…");
await sdk.env.run(
  [
    "set -e",
    "python3 -m venv .venv",
    ".venv/bin/python3 -m pip install --upgrade pip",
    ".venv/bin/python3 -m pip install -r requirements.txt",
  ].join("\n"),
  { cwd: sdk.installDir, stage: "setup", timeoutMs: 20 * 60_000 },
);

// We deliberately run `make -C tools` directly instead of the README's
// `make setup`: `setup` first runs tools/install-git-hooks.sh, which
// `git rev-parse`s and exits 1 when there's no .git directory — and
// cloneFromGitHub fetches a source tarball, so there is no .git here.
// `make -C tools` is the part of `setup` that actually matters: it
// downloads the KMC gcc 2.7.2 + binutils 2.6 N64 toolchain.
sdk.progress("Fetching the KMC N64 toolchain (make -C tools)…");
await sdk.env.run("make -C tools", {
  cwd: sdk.installDir,
  stage: "building",
  timeoutMs: 15 * 60_000,
});

// Split the ROM into source with splat. PYTHON points at the venv so
// `python3 -m splat split` resolves to the installed splat64.
sdk.progress("Extracting assets from the ROM with splat (make extract)…");
await sdk.env.run("make extract PYTHON=.venv/bin/python3", {
  cwd: sdk.installDir,
  stage: "extracting",
  timeoutMs: 30 * 60_000,
});

// Build + verify. The default `all` target reassembles the ROM and
// (when the source fully matches) diffs it byte-for-byte against the
// original, printing `build/snowboardkids2.z64: OK`.
sdk.progress("Building the ROM (this can take 10-30 minutes)…");
await sdk.env.run("make -j$(nproc) PYTHON=.venv/bin/python3", {
  cwd: sdk.installDir,
  stage: "building",
  timeoutMs: 60 * 60_000,
});

// The build product is a plain N64 ROM, not a runnable native binary —
// the decomp project doesn't produce an executable. Declare the ROM as
// the output so the install completes and the user can point their
// emulator at it.
sdk.declareOutput("build/snowboardkids2.z64");
sdk.reportVersion("main");
