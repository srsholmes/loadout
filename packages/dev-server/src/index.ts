/**
 * Loadout Dev Server
 *
 * Entry point for development. Starts the Bun server that serves the overlay
 * app and compiles plugin bundles on the fly. Open http://localhost:33820 in
 * a browser to see the overlay app with all installed plugins.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "@loadout/loader";
import { log, LOG_PATH } from "@loadout/loader/src/logger";

// Compile-time defines from scripts/build.sh (--define
// __LOADOUT_VERSION__='"…"'). Fall back to "dev" when running
// directly via `bun run` without the build wrapper.
declare const __LOADOUT_VERSION__: string | undefined;
declare const __LOADOUT_BUILD_DATE__: string | undefined;
const LOADER_VERSION =
  typeof __LOADOUT_VERSION__ !== "undefined" ? __LOADOUT_VERSION__ : "dev";
const LOADER_BUILD_DATE =
  typeof __LOADOUT_BUILD_DATE__ !== "undefined" ? __LOADOUT_BUILD_DATE__ : "";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "33820" },
    version: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: false,
});

// --version: print the build version and exit 0. Used by
// scripts/install-local.sh as a smoke check that the binary is
// runnable post-copy (Audit 2026-05 H-008). Must run before any
// server bring-up so a corrupted install doesn't try to bind a port
// or write logs.
if (values.version) {
  // Recognisable, grep-able format: "loadout <version>"
  const buildSuffix = LOADER_BUILD_DATE ? ` (built ${LOADER_BUILD_DATE})` : "";
  console.log(`loadout ${LOADER_VERSION}${buildSuffix}`);
  process.exit(0);
}

if (values.help) {
  console.log("Usage: loadout [--port PORT] [--version] [--help] [--debug]");
  console.log("");
  console.log("Env vars:");
  console.log("  LOADOUT_PORT     Listen port (default 33820)");
  console.log("  LOADOUT_DEBUG=1  Re-throw uncaught exceptions instead of swallowing");
  console.log("  PLUGINS_DIR           Plugin directory (default ./plugins)");
  process.exit(0);
}

const projectRoot = resolve(import.meta.dir, "../../..");
const port = Number(values.port);
const pluginsDir = process.env.PLUGINS_DIR || resolve(projectRoot, "plugins");

log.info("=== Loadout starting ===");
log.info(`loadout version: ${LOADER_VERSION}${LOADER_BUILD_DATE ? ` (built ${LOADER_BUILD_DATE})` : ""}`);
log.info(`PID: ${process.pid}`);
log.info(`Bun version: ${Bun.version}`);
log.info(`Project root: ${projectRoot}`);
log.info(`Port: ${port}`);
log.info(`Log file: ${LOG_PATH}`);
log.info(`Platform: ${process.platform} ${process.arch}`);
log.info(`User: ${process.env.USER || process.env.HOME || "unknown"}`);

await startServer({
  port,
  projectRoot,
  pluginsDir,
});
