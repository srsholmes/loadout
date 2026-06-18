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
import { withSteamClient } from "@loadout/steam-cdp";
import { shortcutGameId64 } from "@loadout/vdf";

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
   * Native OS of `exe`. When `"windows"` the shortcut pins Proton
   * Experimental as its compat tool so Steam runs the .exe through
   * Wine (the host is always Linux). `"linux"` is a no-op.
   */
  platform?: "windows" | "linux";
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
 * Wrap a best-effort follow-up write so a failure warns rather than
 * rolls back a successful shortcut add.
 */
async function bestEffort(
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(
      `[steam-shortcut] ${label} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
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
 * collection). Each is wrapped in `bestEffort()` — a failure on
 * the collection write doesn't roll back a successful shortcut
 * add.
 *
 * If `AddShortcut` returns `undefined` / `null`, throw an
 * actionable error rather than letting `undefined` flow through
 * every subsequent SetX call. Every Steam build the source repo
 * has shipped against returns the appid reliably; if a future
 * build regresses, restarting Steam is the right next step.
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
    const appId = await sc.apps.addShortcut(
      spec.displayName,
      spec.exe,
      spec.args,
      spec.cwd ?? "",
    );
    if (appId == null) {
      throw new Error(
        "SteamClient.Apps.AddShortcut returned no appid — restart Steam and retry",
      );
    }

    // Persistence-critical follow-ups.
    await sc.apps.setShortcutName(appId, spec.displayName);
    await sc.apps.setShortcutLaunchOptions(appId, spec.args);

    // Windows binary → register Proton as the compat tool so Steam
    // runs the .exe through Wine (the host is always Linux). Without
    // this Steam tries to native-exec the .exe and silently fails —
    // the "click Launch, nothing happens" symptom.
    if (spec.platform === "windows") {
      await bestEffort("specifyCompatTool", () =>
        sc.apps.specifyCompatTool(
          appId,
          "proton_experimental",
          "Proton Experimental",
        ),
      );
    }

    // User-tag dynamic grouping (sidebar).
    const userTag = spec.userTag;
    if (userTag) {
      await bestEffort("addUserTag", () => sc.apps.addUserTag(appId, userTag));
    }

    // User-created Steam Library Collection (Collections tab).
    const collectionName = spec.collectionName;
    if (collectionName) {
      await bestEffort("addAppToCollection", () =>
        sc.apps.addAppToCollection(appId, collectionName),
      );
    }

    return { appId, gameId64: shortcutGameId64(appId) };
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
