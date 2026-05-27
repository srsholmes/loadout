/**
 * @loadout/steam-shortcut — register / remove non-Steam shortcuts
 * via Steam's running JS client.
 *
 * Consolidates the three-call persistence sequence + best-effort
 * compat-tool + user-tag + user-collection writes that recomp and
 * store-bridge previously hand-rolled side-by-side. Both plugins
 * now adapt their own domain types onto the `SteamShortcutSpec`
 * and call into here, so a future Steam API change lands in one
 * spot.
 *
 * Does NOT own the launch-template resolution (recomp's
 * `resolveTemplate` for ROM substitutions, store-bridge's driver-
 * provided exe path) — that stays in the calling plugin, since
 * the rules vary per source.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withSteamClient } from "@loadout/steam-cdp";
import { getUserdataDir, getUserIds } from "@loadout/steam-paths";
import { parseBinaryVdf, shortcutGameId64 } from "@loadout/vdf";

export interface SteamShortcutSpec {
  /** Display name shown in Steam (e.g. `"Alba (Epic Games)"`). */
  displayName: string;
  /** Absolute path to the executable. Never empty. */
  exe: string;
  /** Launch args appended after the exe at runtime. */
  args: string;
  /** Working directory for the shortcut. Optional — Steam defaults
   *  to dirname(exe). */
  cwd?: string;
  /**
   * Native OS of `exe`. When `"windows"` on a Linux host the
   * shortcut pins Proton Experimental as its compat tool so Steam
   * runs the .exe through Wine. Other values are no-ops on the
   * compat-tool front.
   */
  platform?: "windows" | "linux" | "macos";
  /**
   * User-tag value. Surfaces as a dynamic auto-grouping in Steam's
   * library sidebar. Best-effort — older Steam builds without
   * `AddUserTagOnApp` skip silently.
   */
  userTag?: string;
  /**
   * User-created Steam Library Collection name. Places the
   * shortcut in Steam's Collections tab proper (not just the
   * sidebar dynamic group `userTag` produces). Best-effort —
   * builds without the modern Library UI skip silently.
   */
  collectionName?: string;
}

export interface SteamShortcutResult {
  appId: number;
  gameId64: string;
}

/**
 * Register a non-Steam shortcut and persist it to disk + Steam's
 * running state.
 *
 * Three calls in sequence — all three matter for persistence:
 *
 *   1. `AddShortcut(name, exe, args, "")` — Steam allocates the
 *      appid and adds the entry to its running shortcut list.
 *   2. `SetShortcutName(appId, name)` — modern Steam builds
 *      overwrite `appname` with the exe basename otherwise.
 *   3. `SetShortcutLaunchOptions(appId, args)` — without this,
 *      Steam treats the entry as incomplete and does NOT flush
 *      it to `shortcuts.vdf` on its next save cycle, so the
 *      shortcut disappears on Steam restart / reboot.
 *
 * Then optional best-effort writes (compat tool, user tag,
 * collection). Each is wrapped in try/catch — a failure on the
 * collection write doesn't roll back a successful shortcut add.
 *
 * If `AddShortcut` returns `undefined` (newer Steam builds drop
 * the appid in the return value), we read it back out of
 * `shortcuts.vdf` by display name with a short retry loop. The
 * on-disk flush is async on Steam's side.
 */
export async function addNonSteamShortcut(
  spec: SteamShortcutSpec,
): Promise<SteamShortcutResult> {
  if (!spec.exe) {
    throw new Error("addNonSteamShortcut: spec.exe must be non-empty");
  }
  if (!spec.displayName) {
    throw new Error("addNonSteamShortcut: spec.displayName must be non-empty");
  }

  return withSteamClient(async (sc) => {
    let appId = await sc.apps.addShortcut(
      spec.displayName,
      spec.exe,
      spec.args,
      spec.cwd ?? "",
    );
    if (appId == null) {
      appId = await findShortcutAppIdByName(spec.displayName);
    }
    if (appId == null) {
      throw new Error(
        `Failed to register Steam shortcut for "${spec.displayName}". Steam may not be running or the shortcut creation did not complete in time. Try restarting Steam.`,
      );
    }
    const finalAppId = appId;

    // Persistence-critical follow-ups.
    await sc.apps.setShortcutName(finalAppId, spec.displayName);
    await sc.apps.setShortcutLaunchOptions(finalAppId, spec.args);

    // Windows binary on a Linux host → register Proton as the
    // compat tool so Steam runs the .exe through Wine. Without
    // this Steam tries to native-exec the .exe and silently
    // fails — the "click Launch, nothing happens" symptom.
    if (spec.platform === "windows" && process.platform === "linux") {
      try {
        await sc.apps.specifyCompatTool(
          finalAppId,
          "proton_experimental",
          "Proton Experimental",
        );
      } catch (err) {
        console.warn(
          `[steam-shortcut] specifyCompatTool failed for "${spec.displayName}" (best-effort):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // User-tag dynamic grouping (sidebar).
    if (spec.userTag) {
      try {
        await sc.apps.addUserTag(finalAppId, spec.userTag);
      } catch (err) {
        console.warn(
          `[steam-shortcut] addUserTag failed for "${spec.displayName}" (best-effort):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // User-created Steam Library Collection (Collections tab).
    if (spec.collectionName) {
      try {
        await sc.apps.addAppToCollection(finalAppId, spec.collectionName);
      } catch (err) {
        console.warn(
          `[steam-shortcut] addAppToCollection failed for "${spec.displayName}" (best-effort):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { appId: finalAppId, gameId64: shortcutGameId64(finalAppId) };
  });
}

/** Remove a non-Steam shortcut. No-op when Steam isn't reachable. */
export async function removeNonSteamShortcut(appId: number): Promise<void> {
  try {
    await withSteamClient(async (sc) => {
      await sc.apps.removeShortcut(appId);
    });
  } catch (err) {
    console.warn(
      `[steam-shortcut] removeShortcut(${appId}) failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Read shortcut appid out of `shortcuts.vdf` by display name —
 * fallback for Steam builds where `AddShortcut` returns
 * `undefined`. Polls a few times because Steam's flush to disk is
 * async.
 */
async function findShortcutAppIdByName(name: string): Promise<number | null> {
  const userIds = await getUserIds();
  const delays = [0, 100, 250, 500, 1000];
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    for (const userId of userIds) {
      const path = join(getUserdataDir(), userId, "config", "shortcuts.vdf");
      let buf: Buffer;
      try {
        buf = await readFile(path);
      } catch {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = parseBinaryVdf(buf) as Record<string, unknown>;
      } catch {
        continue;
      }
      const shortcuts = (parsed.shortcuts ?? {}) as Record<string, unknown>;
      for (const entry of Object.values(shortcuts)) {
        if (typeof entry !== "object" || entry === null) continue;
        const sc = entry as Record<string, unknown>;
        const appName =
          (typeof sc.appname === "string" && sc.appname) ||
          (typeof sc.AppName === "string" && sc.AppName) ||
          "";
        if (appName !== name) continue;
        if (typeof sc.appid !== "number") continue;
        return sc.appid >>> 0; // signed → unsigned coercion
      }
    }
  }
  return null;
}
