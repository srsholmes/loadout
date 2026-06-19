import { sdk } from "../../lib/sdk";

await sdk.ready;

if (!sdk.romPath) {
  throw new Error("SOTN PC build requires the US PS1 disc image (.bin/.iso)");
}

sdk.progress("Installing build dependencies inside container…");
// xeeynamo/sotn-decomp uses cmake + the Go toolchain (assets are
// processed by Go programs in tools/), plus a MIPS cross-compiler
// from the project's own scripts. Best-effort superset.
await sdk.env.ensurePackages([
  "cmake",
  "make",
  "gcc",
  "gcc-c++",
  "golang",
  "python3",
  "pkgconf-pkg-config",
  "sdl2-compat-devel",
  "binutils-mips-linux-gnu",
  "gcc-mips-linux-gnu",
]);

sdk.progress("Cloning xeeynamo/sotn-decomp…");
await sdk.cloneFromGitHub("xeeynamo/sotn-decomp", "master");

sdk.progress("Placing disc.bin…");
await sdk.placeRom("disc.bin");

sdk.progress("Running project setup script (sotn.sh)…");
await sdk.env.run("./sotn.sh", {
  cwd: sdk.installDir,
  stage: "setup",
  timeoutMs: 30 * 60_000,
});

sdk.declareOutput("sotn");
sdk.reportVersion("master");
