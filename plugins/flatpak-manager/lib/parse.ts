/**
 * Pure parsers for `flatpak` CLI tab-separated output. Extracted from
 * `backend.ts` so they can be unit-tested without mocking the subprocess
 * layer.
 *
 * The `--columns=…` flags pin output to tab-separated columns in a
 * stable order (we own the column list), so the parsers only need to
 * split on `\t`, drop short/blank lines, and trim each field.
 */

export interface InstalledApp {
  name: string;
  appId: string;
  version: string;
  size: string;
  origin: string;
}

export interface UpdateInfo {
  name: string;
  appId: string;
  newVersion: string;
}

/** Parse `flatpak list --app --columns=name,application,version,size,origin`. */
export function parseInstalled(output: string): InstalledApp[] {
  if (!output) return [];

  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const apps: InstalledApp[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 5) continue;

    // Indices 0-4 are expected present (length checked >= 5 above); guard
    // and skip the line if any is somehow missing, matching the length skip.
    const [name, appId, version, size, origin] = parts;
    if (
      name === undefined ||
      appId === undefined ||
      version === undefined ||
      size === undefined ||
      origin === undefined
    ) {
      console.warn("[flatpak-manager] unexpected missing field in installed list line");
      continue;
    }
    apps.push({
      name: name.trim(),
      appId: appId.trim(),
      version: version.trim(),
      size: size.trim(),
      origin: origin.trim(),
    });
  }

  return apps;
}

/** Parse `flatpak remote-ls --updates --columns=name,application,version`. */
export function parseUpdates(output: string): UpdateInfo[] {
  if (!output) return [];

  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const updates: UpdateInfo[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    // Indices 0-2 are expected present (length checked >= 3 above); guard
    // and skip the line if any is somehow missing, matching the length skip.
    const [name, appId, newVersion] = parts;
    if (name === undefined || appId === undefined || newVersion === undefined) {
      console.warn("[flatpak-manager] unexpected missing field in updates list line");
      continue;
    }
    updates.push({
      name: name.trim(),
      appId: appId.trim(),
      newVersion: newVersion.trim(),
    });
  }

  return updates;
}

/**
 * Validate Flatpak app ID format to prevent flag injection. App IDs are
 * reverse-DNS strings (e.g. `org.mozilla.firefox`); anything starting
 * with `-` or containing shell metacharacters is rejected.
 */
export function isValidAppId(appId: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(appId);
}
