// Seeds the wake-routing engine's ControllerShortcuts from the persisted
// user config at startup.
//
// The overlay's Bun process holds the authoritative in-memory `shortcuts`
// ref that routeWake() consults. Before this module existed it booted to a
// hardcoded default and only picked up the user's saved bindings when the
// Settings UI pushed them over the setControllerShortcuts RPC — so every
// process restart silently reverted the bindings until the user re-edited
// them (index.ts stage-2 TODO). We now read the same config file the
// backend writes (`~/.config/loadout/config.json`, honoring
// $XDG_CONFIG_HOME) so a saved binding survives restarts.
//
// Reading the file directly (rather than the backend's /api/user-config)
// keeps this dependency-free: no loader port, no auth token, and it works
// even if the backend is still coming up when the overlay boots. The
// backend writes atomically, so a torn read isn't a concern.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateControllerShortcuts } from "../rpc-validation";
import type { ControllerShortcuts } from "../../webview/lib/electrobun";

/** Config key under which the backend persists controller shortcuts.
 *  Must match host.ts's CONFIG_KEY. */
const CONFIG_KEY = "controllerShortcuts";

/**
 * Resolve `~/.config/loadout/config.json`, honoring $XDG_CONFIG_HOME.
 * Mirrors apps/loadout/src/loader/user-config.ts so both ends agree on the
 * path.
 */
export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "loadout", "config.json");
}

/**
 * Extract + validate the persisted ControllerShortcuts from raw config JSON.
 * Pure (exposed for tests). Returns null when the file is unparseable, has
 * no `controllerShortcuts` key, or the value is structurally invalid — the
 * caller keeps its hardcoded default in every one of those cases.
 */
export function parsePersistedShortcuts(raw: string): ControllerShortcuts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[CONFIG_KEY];
  if (value === undefined) return null;
  return validateControllerShortcuts(value);
}

/**
 * Load persisted controller shortcuts from disk. Returns null on any
 * failure (missing file, unreadable, malformed) so the caller falls back to
 * its default without special-casing errno.
 */
export async function loadPersistedShortcuts(): Promise<ControllerShortcuts | null> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return parsePersistedShortcuts(raw);
  } catch {
    return null;
  }
}
