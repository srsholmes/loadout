#!/usr/bin/env bun
/**
 * Dev-only driver: invoke a per-game recipe directly through
 * `runSetupScript` for end-to-end smoke testing without going
 * through the WebSocket / overlay UI.
 *
 * Usage:
 *   bun run plugins/recomp/scripts/run-recipe.ts <game-id> [rom-path]
 *
 * Example (SM64):
 *   bun run plugins/recomp/scripts/run-recipe.ts sm64-decomp \
 *     /path/to/sm64.us.z64
 */
import { join } from "node:path";
import { runSetupScript } from "../lib/installer-host";
import { setupScriptPathFor } from "../lib/registry";
import { gamesDir, currentPlatform } from "../lib/platform";
import type { PipelineEvent } from "../lib/types";

const [, , gameId, romPath] = process.argv;
if (!gameId) {
  console.error("usage: run-recipe.ts <game-id> [rom-path]");
  process.exit(1);
}

const scriptPath = setupScriptPathFor(gameId);
if (!scriptPath) {
  console.error(`No setup.ts for '${gameId}' under plugins/recomp/games/`);
  process.exit(1);
}

const installDir = join(gamesDir(), gameId);

console.log(`──── runSetupScript ────`);
console.log(`gameId:     ${gameId}`);
console.log(`script:     ${scriptPath}`);
console.log(`installDir: ${installDir}`);
console.log(`romPath:    ${romPath ?? "(none)"}`);
console.log(`platform:   ${currentPlatform()}`);
console.log(`────────────────────────`);

let lastStage = "";
const onEvent = (event: PipelineEvent) => {
  if (event.stage && event.stage !== lastStage) {
    process.stdout.write(`\n[${event.stage.toUpperCase()}]\n`);
    lastStage = event.stage;
  }
  if (event.message) {
    process.stdout.write(`  ${event.message}\n`);
  }
};

try {
  const result = await runSetupScript(
    scriptPath,
    {
      gameId,
      installDir,
      romPath,
      platform: currentPlatform(),
    },
    onEvent,
  );
  console.log(`\n✓ install OK`);
  console.log(`  outputBinary:   ${result.outputBinary}`);
  console.log(`  launchCommand:  ${result.launchCommand ?? "(default)"}`);
  console.log(`  version:        ${result.version ?? "(unset)"}`);
  console.log(`  binary path:    ${join(installDir, result.outputBinary)}`);
} catch (err) {
  console.error(`\n✗ install FAILED:`);
  console.error(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
