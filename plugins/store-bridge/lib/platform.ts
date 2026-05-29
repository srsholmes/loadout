import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolved per-spec env so test harnesses can sandbox the plugin's
 * on-disk footprint by setting `XDG_DATA_HOME` / `XDG_CACHE_HOME` /
 * `XDG_CONFIG_HOME` before the install pipeline runs.
 *
 * Without this, `install-legendary.test.ts` (which sets
 * `XDG_DATA_HOME` to a tmpdir but uses the real `installLegendary`
 * code path) silently overwrote the user's actual
 * `~/.local/share/loadout/store-bridge/bin/legendary` with the
 * 10-byte ELF stub the test stubs `fetch` to return. The user's next
 * preflight then reported "legendary at PATH failed to run".
 *
 * Honour the XDG spec defaults when the env var is absent:
 *   - `$XDG_DATA_HOME`   → defaults to `$HOME/.local/share`
 *   - `$XDG_CACHE_HOME`  → defaults to `$HOME/.cache`
 *   - `$XDG_CONFIG_HOME` → defaults to `$HOME/.config`
 *
 * https://specifications.freedesktop.org/basedir-spec/latest/
 */
function xdgRoot(envVar: string, fallback: string): string {
  const explicit = process.env[envVar];
  if (explicit && explicit.length > 0) return explicit;
  return join(homedir(), fallback);
}

export function dataDir(): string {
  return join(xdgRoot("XDG_DATA_HOME", ".local/share"), "loadout", "store-bridge");
}

export function cacheDir(): string {
  return join(xdgRoot("XDG_CACHE_HOME", ".cache"), "loadout", "store-bridge");
}

export function configDir(): string {
  return join(xdgRoot("XDG_CONFIG_HOME", ".config"), "loadout", "store-bridge");
}

/** Where the plugin keeps tool binaries it self-installs (legendary, etc.). */
export function binDir(): string {
  return join(dataDir(), "bin");
}

/** Default install root for store-managed game downloads. */
export function gamesDir(): string {
  return join(homedir(), "Games", "store-bridge");
}

/** Per-store install root, e.g. ~/Games/store-bridge/epic */
export function storeInstallDir(storeId: string): string {
  return join(gamesDir(), storeId);
}
