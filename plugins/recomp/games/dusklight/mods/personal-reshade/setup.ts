import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { modSdk } from "../../../../lib/sdk/mod";
import type { ModSDK } from "../../../../lib/sdk/mod";

/**
 * Personal Reshade — install recipe.
 *
 * Drops the user-supplied `.ini` (or all loose files from their
 * download) at the Dusklight install dir's root, then best-effort
 * toggles Reshade on in `dusklight.ini` if that file exists. The
 * actual key/section names vary by Reshade integration; we look for
 * the common `[Reshade]` / `Enabled=` form and add it if missing.
 *
 * Doesn't bundle Reshade itself — the user is expected to have a
 * Reshade-aware Dusklight build. If the engine config isn't found
 * we log a hint via `modSdk.emit` and continue (the .ini lands on
 * disk; the user can flip the toggle later).
 */
export async function install(_ctx: ModSDK): Promise<void> {
  void _ctx;
  await modSdk.ready;

  modSdk.emit({ message: "Placing Reshade files…", percent: 10 });

  // The user's archive can contain a single .ini, multiple files, or
  // a folder layout. Copy everything verbatim to the install root.
  const entries = await readdir(modSdk.stagedDir);
  if (entries.length === 0) {
    throw new Error(
      "Staged archive was empty after extraction. Re-download the Reshade preset.",
    );
  }
  for (const name of entries) {
    await modSdk.copy(join(modSdk.stagedDir, name), join(modSdk.installDir, name));
  }
  // If the user pasted a bare .ini (some Drive packages ship the
  // preset uncompressed), no .ini will be inside stagedDir but it'll
  // already be at modSdk.installDir/<name>. That's the same shape.

  // Best-effort config flip.
  modSdk.emit({ message: "Enabling Reshade in engine config…", percent: 70 });
  await enableReshadeFlag(modSdk.installDir);

  modSdk.emit({ message: "Reshade preset installed", percent: 100 });
}

async function enableReshadeFlag(installDir: string): Promise<void> {
  const configCandidates = ["dusklight.ini", "config.ini", "settings.ini"];
  for (const name of configCandidates) {
    const path = join(installDir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf-8");
      if (/\[Reshade\][\s\S]*?Enabled\s*=\s*true/i.test(raw)) {
        modSdk.emit({ message: `${name}: Reshade already enabled` });
        return;
      }
      let updated: string;
      if (/\[Reshade\]/i.test(raw)) {
        updated = raw.replace(/(\[Reshade\][^[]*)/i, (block) => {
          if (/Enabled\s*=/i.test(block)) {
            return block.replace(/Enabled\s*=\s*\S+/i, "Enabled = true");
          }
          return block.replace(/(\[Reshade\][^\n]*\n)/i, "$1Enabled = true\n");
        });
      } else {
        updated = `${raw.trimEnd()}\n\n[Reshade]\nEnabled = true\n`;
      }
      await writeFile(path, updated);
      modSdk.emit({ message: `${name}: Reshade enabled` });
      return;
    } catch (err) {
      modSdk.emit({
        message: `Couldn't update ${name}: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
  modSdk.emit({
    message:
      "Engine config not found — Reshade .ini is in place but you may need to enable it manually.",
  });
}

// Avoid unused-import lint for the extname helper. It's not used yet
// but the install path may need it when we move to inferring
// shader-source-relative paths from a single .ini paste.
void extname;
