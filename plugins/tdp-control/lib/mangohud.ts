/**
 * Helpers for driving MangoHud as the FPS source for the target-FPS TDP loop.
 *
 * MangoHud is enabled per game by injecting three launch-option tokens into
 * the game's Steam launch options (via the launch-options plugin's
 * `appendLaunchToken` RPC, which builds on `@loadout/vdf`):
 *
 *   MANGOHUD_CONFIG=output_folder=<dir>,autostart_log=1,log_interval=200,no_display=1
 *   MANGOHUD=1
 *   mangohud
 *
 * We inject them as three *separate* single tokens rather than one space-joined
 * blob so each is individually idempotent AND individually removable by key —
 * `removeLaunchToken` only strips the first token matching a key, so a joined
 * blob would leave orphans behind on disable.
 *
 *   - `MANGOHUD_CONFIG` (env) configures per-app continuous logging without
 *     touching the user's global ~/.config/MangoHud/MangoHud.conf.
 *   - `MANGOHUD=1` (env) auto-loads the Vulkan layer.
 *   - `mangohud` (wrapper word) covers OpenGL titles.
 *   - `no_display=1` logs without drawing the overlay.
 *
 * Steam launches MangoHud (not this backend), so no `permissions.commands`
 * grant is needed for `mangohud`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Default MangoHud log interval (ms). Faster than the controller tick. */
export const DEFAULT_LOG_INTERVAL_MS = 200;

export interface MangoHudToken {
  /** The launch-options token string to inject. */
  token: string;
  /** Idempotency / removal key for appendLaunchToken / removeLaunchToken. */
  key: string;
}

/** XDG data home, honouring $XDG_DATA_HOME. */
function dataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/**
 * Per-app folder MangoHud logs into. Kept per-appId so the FPS reader can find
 * the right session log unambiguously.
 */
export function mangoHudLogDir(appId: number | string): string {
  return join(dataHome(), "loadout", "mangohud-logs", String(appId));
}

/** The MANGOHUD_CONFIG value string enabling continuous per-app logging. */
export function buildMangoHudConfig(
  logDir: string,
  logIntervalMs: number = DEFAULT_LOG_INTERVAL_MS,
): string {
  return [
    `output_folder=${logDir}`,
    "autostart_log=1",
    `log_interval=${logIntervalMs}`,
    "no_display=1",
  ].join(",");
}

/** The idempotency keys for all injected MangoHud tokens (for removal). */
export const MANGOHUD_TOKEN_KEYS = ["MANGOHUD_CONFIG", "MANGOHUD", "mangohud"];

/**
 * The three tokens to inject for a game, in the order they should be appended
 * (env assignments first, wrapper word last — each inserted before %command%).
 */
export function mangoHudTokens(
  appId: number | string,
  logIntervalMs: number = DEFAULT_LOG_INTERVAL_MS,
): MangoHudToken[] {
  const logDir = mangoHudLogDir(appId);
  return [
    {
      token: `MANGOHUD_CONFIG=${buildMangoHudConfig(logDir, logIntervalMs)}`,
      key: "MANGOHUD_CONFIG",
    },
    { token: "MANGOHUD=1", key: "MANGOHUD" },
    { token: "mangohud", key: "mangohud" },
  ];
}
