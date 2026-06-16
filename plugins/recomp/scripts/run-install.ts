#!/usr/bin/env bun
/**
 * Dev-only driver: install a PREBUILT / rom_extract catalog entry
 * end-to-end through the real `installGame` pipeline — download →
 * extract → write launch wrapper → add-to-Steam → artwork — then
 * verify the launch binary landed on disk and that the Steam shortcut
 * was registered. Cleans everything back up afterwards (unless --keep).
 *
 * This is the runtime counterpart to `run-recipe.ts` (which drives the
 * build_from_source path) and to `test-installers.ts` (which only
 * resolves/extracts in a temp dir without touching real state or Steam).
 * Use it to prove "click Install → it actually works" without the UI.
 *
 * `installGame` ALWAYS adds to Steam itself (the opt-out setting was
 * removed), so this driver does NOT add a second shortcut — it verifies
 * the pipeline's own add succeeded via `installed.steamAppId`.
 *
 * Usage:
 *   bun run plugins/recomp/scripts/run-install.ts <game-id> [options]
 *
 * Options:
 *   --rom <path>   ROM file for rom_extract entries that require one
 *   --keep         leave the game installed + its Steam shortcut in place
 *                  (default: uninstall + remove shortcut after verifying)
 *
 * The Steam step needs Steam running in DESKTOP mode — Gaming Mode /
 * Big Picture does not expose the SharedJSContext tab on the CEF debug
 * port, so the add-to-Steam step reports it can't reach Steam.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  loadState,
  removeInstalledGame,
} from "../lib/state";
import { installGame, resolveTemplate } from "../lib/pipeline";
import { removeFromSteam } from "../lib/steam-shortcut";
import { loadBundledRegistry } from "../lib/registry";
import { currentPlatform, getPlatformValue } from "../lib/platform";
import type { GameEntry, InstalledGame, PipelineEvent } from "../lib/types";

interface Args {
  gameId: string;
  romPath?: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const [gameId] = argv;
  if (!gameId || gameId.startsWith("--")) {
    console.error("usage: run-install.ts <game-id> [--rom <path>] [--keep]");
    process.exit(1);
  }
  const romIdx = argv.indexOf("--rom");
  return {
    gameId,
    romPath: romIdx >= 0 ? argv[romIdx + 1] : undefined,
    keep: argv.includes("--keep"),
  };
}

/**
 * Resolve the on-disk path of the launch binary the same way
 * `lib/steam-shortcut.ts:buildSpec` does, and assert it exists. Returns
 * the resolved exe path.
 */
function verifyLaunchBinary(opts: {
  entry: GameEntry;
  installed: InstalledGame;
}): string {
  const { entry, installed } = opts;
  const platform = installed.installedPlatform ?? currentPlatform();
  const launchCmd =
    installed.launchCommand ??
    entry.launchCommand[platform] ??
    getPlatformValue(entry.launchCommand);
  if (!launchCmd) {
    throw new Error(`No launch command for ${entry.name} on ${platform}`);
  }
  const resolved = resolveTemplate(
    launchCmd,
    installed.installDir,
    installed.romPath,
  );
  const exe = resolved.split(/\s+/).filter(Boolean)[0];
  if (!exe) throw new Error("Empty launch command after resolution");
  if (!existsSync(exe)) {
    throw new Error(
      `launch binary missing on disk after install: ${exe}\n` +
        `  (resolved from launchCommand: ${launchCmd})`,
    );
  }
  return exe;
}

/** Tear down the install: remove shortcut, files, and state record. */
async function cleanup(opts: { installed: InstalledGame; gameId: string }) {
  const { installed, gameId } = opts;
  if (installed.steamAppId != null) {
    await removeFromSteam(installed.steamAppId);
    console.log(`✓ removed Steam shortcut ${installed.steamAppId}`);
  }
  await rm(installed.installDir, { recursive: true, force: true });
  console.log(`✓ removed install dir ${installed.installDir}`);
  await removeInstalledGame(await loadState(), gameId);
  console.log(`✓ removed state record`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const entry = loadBundledRegistry().find((g) => g.id === args.gameId);
  if (!entry) {
    console.error(`No catalog entry with id '${args.gameId}'`);
    process.exit(1);
  }
  if (entry.installType === "build_from_source") {
    console.error(
      `'${args.gameId}' is build_from_source — use run-recipe.ts instead`,
    );
    process.exit(1);
  }

  console.log(`──── run-install ────`);
  console.log(`gameId:      ${entry.id}`);
  console.log(`name:        ${entry.name}`);
  console.log(`installType: ${entry.installType}`);
  console.log(`platform:    ${currentPlatform()}`);
  console.log(`rom:         ${args.romPath ?? "(none)"}`);
  console.log(`cleanup:     ${args.keep ? "no (--keep)" : "yes"}`);
  console.log(`─────────────────────\n`);

  const state = await loadState();
  const newState = await installGame(
    entry,
    state,
    args.romPath,
    (e: PipelineEvent) => {
      const detail = e.message
        ? `: ${e.message}`
        : e.percent != null
          ? ` ${e.percent}%`
          : "";
      console.log(`  [${e.type}]${detail}`);
    },
  );

  const installed = newState.games[entry.id];
  if (!installed) {
    console.error(
      `\n✗ install did not record state.games['${entry.id}'] — likely a rom_required halt. Pass --rom <path>.`,
    );
    process.exit(1);
  }

  console.log(`\n✓ installed to: ${installed.installDir}`);
  const exe = verifyLaunchBinary({ entry, installed });
  console.log(`✓ launch binary present: ${exe}`);

  if (installed.addedToSteam && installed.steamAppId != null) {
    console.log(`✓ pipeline added to Steam: appId=${installed.steamAppId}`);
  } else {
    console.log(
      `⚠ pipeline did NOT add to Steam (is Steam running in desktop mode?)`,
    );
  }

  if (args.keep) {
    console.log("\n(leaving install + shortcut in place — --keep)");
  } else {
    console.log("\n── cleanup ──");
    await cleanup({ installed, gameId: entry.id });
  }

  console.log("\n✓ end-to-end install verified");
}

await main();
