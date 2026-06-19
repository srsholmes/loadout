import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the build-env so the recipe runtime can be provisioned without
// distrobox / a real container. detectBuildEnv returns a no-op env;
// ensureRecompContainer resolves immediately.
mock.module("./build-env", () => ({
  RECOMP_CONTAINER: "recomp-build",
  detectBuildEnv: async () => ({
    kind: "distrobox" as const,
    label: "stub-env",
    installPackages: async () => ({ exitCode: 0 }),
    has: async () => true,
    run: async () => ({ exitCode: 0 }),
  }),
  ensureRecompContainer: async () => {},
}));

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-installer-test-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * Write a recipe at `<dir>/setup.ts`.
 *
 * The recipe reads its install context from the live `@recomp/sdk`
 * (which resolves the host's runtime slot) and synchronously copies
 * `sdk.romPath` → `<sdk.installDir>/placed/rom.z64`.
 *
 * Why fully synchronous (no top-level `await`, `copyFileSync`):
 * `bun test`'s loader does NOT await a dynamically-`import()`ed
 * module's top-level await (verified empirically — it differs from
 * `bun run`), so any work a recipe does AFTER its first `await` would
 * be silently abandoned inside the test runner. Doing the ROM copy
 * synchronously keeps the recipe observable from the test while still
 * exercising the exact slot-read path (`sdk.installDir`, `sdk.romPath`)
 * that the cross-install bug corrupts.
 */
async function writeRecipe(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const recipePath = join(dir, "setup.ts");
  const src = `
import { sdk } from ${JSON.stringify(join(import.meta.dir, "sdk", "index.ts"))};
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Read the LIVE install context from the SDK runtime slot.
const installDir = sdk.installDir;
const romPath = sdk.romPath;

const destDir = join(installDir, "placed");
mkdirSync(destDir, { recursive: true });
copyFileSync(romPath, join(destDir, "rom.z64"));

// Materialize the declared output binary so the host's Phase-D
// existence check passes.
mkdirSync(join(installDir, "bin"), { recursive: true });
writeFileSync(join(installDir, "bin", "game"), "#!/bin/true\\n");

sdk.declareOutput("bin/game");
sdk.declareLaunchCommand("/bin/true");
`;
  await writeFile(recipePath, src);
  return recipePath;
}

describe("runSetupScript — concurrent installs of different games", () => {
  it("keeps each install's runtime context isolated (ROM lands in its OWN installDir)", async () => {
    const { runSetupScript } = await import("./installer-host");

    // Two games, two install dirs, two distinct ROM files.
    const aInstall = join(sandbox, "install-a");
    const bInstall = join(sandbox, "install-b");
    const aRom = join(sandbox, "rom-a.z64");
    const bRom = join(sandbox, "rom-b.z64");
    await writeFile(aRom, "ROM-A-BYTES");
    await writeFile(bRom, "ROM-B-BYTES");

    const aRecipe = await writeRecipe(join(sandbox, "recipe-a"));
    const bRecipe = await writeRecipe(join(sandbox, "recipe-b"));

    const onEvent = () => {};

    // Submit both installs concurrently. Phase A of each install is a
    // chain of awaits (detectBuildEnv, ensureRecompContainer, mkdir); if
    // installs are NOT serialized, install B binds the shared runtime
    // slot while A is parked on an await, so A's recipe reads B's
    // context and copies A's ROM into B's installDir.
    await Promise.all([
      runSetupScript(
        aRecipe,
        { gameId: "game-a", installDir: aInstall, romPath: aRom, platform: "linux" },
        onEvent,
      ),
      runSetupScript(
        bRecipe,
        { gameId: "game-b", installDir: bInstall, romPath: bRom, platform: "linux" },
        onEvent,
      ),
    ]);

    // Each install must have copied ITS OWN rom into ITS OWN dir.
    const aPlaced = await readFile(join(aInstall, "placed", "rom.z64"), "utf-8");
    const bPlaced = await readFile(join(bInstall, "placed", "rom.z64"), "utf-8");
    expect(aPlaced).toBe("ROM-A-BYTES");
    expect(bPlaced).toBe("ROM-B-BYTES");
  }, 20000);
});
