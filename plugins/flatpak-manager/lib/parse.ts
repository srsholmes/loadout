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

    apps.push({
      name: parts[0].trim(),
      appId: parts[1].trim(),
      version: parts[2].trim(),
      size: parts[3].trim(),
      origin: parts[4].trim(),
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

    updates.push({
      name: parts[0].trim(),
      appId: parts[1].trim(),
      newVersion: parts[2].trim(),
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
