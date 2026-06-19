/**
 * High-level typed wrapper around Steam's `window.SteamClient.*` APIs.
 *
 * Steam exposes a large JavaScript surface inside the SharedJSContext CEF
 * tab — mutating launch options, listing installed apps, reading window
 * state, controlling audio, and so on. This wrapper:
 *
 *   1. Hides the CDP plumbing (connect → evaluate → close) so callers
 *      get a typed Promise-returning method instead of writing JS-source
 *      strings inline.
 *   2. Centralises argument quoting (via `JSON.stringify` inside the
 *      generated expression) so launch-options strings containing quotes,
 *      backslashes, or other special characters round-trip correctly.
 *   3. Provides a graceful "is Steam reachable?" probe so callers can
 *      decide between this path and a fallback.
 *
 * Methods are grouped by Steam's own namespacing — `apps.*`, `system.*`,
 * `windows.*`, etc. — so adding a new method matches the upstream call
 * site one-to-one. Only the methods we currently consume are implemented;
 * adding more is mechanical (one new method per Steam API call).
 *
 * Lifecycle: callers can construct a `SteamClient` once and reuse it for
 * many calls (one persistent CDP connection), or use the `withSteamClient`
 * helper for one-shot lazy connect-evaluate-close. The latter is
 * appropriate for human-paced operations like clicking a button to apply
 * launch options to a single game.
 */

import { CDPClient } from "./cdp-client";
import {
  type CEFTab,
  type FindTabOptions,
  findSharedJsTab,
} from "./tabs";

export interface SteamClientOptions extends FindTabOptions {
  /**
   * Pre-discovered SharedJSContext tab. If supplied, no `/json` lookup is
   * performed on connect — useful when the caller already has a tab
   * reference (e.g. the loader's SteamInjector).
   */
  tab?: CEFTab;
  /**
   * How many times to look for the SharedJSContext tab before giving up.
   * Steam transiently publishes an EMPTY `/json` tab list during state
   * transitions — most notably when entering/leaving Gaming Mode (Big
   * Picture) or just after a non-Steam shortcut exits — so a single
   * lookup can miss a tab that's there a moment later. Defaults to 3.
   * Ignored when an explicit `tab` is supplied.
   */
  connectAttempts?: number;
  /** Delay between SharedJSContext lookup attempts, ms. Defaults to 700. */
  connectRetryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thrown when SteamClient methods are called but Steam's `window.SteamClient`
 * isn't reachable — either the CDP debug port is unreachable, no
 * SharedJSContext tab exists, or the tab is loaded but the API namespace
 * we tried to call hasn't materialised yet (Steam still booting).
 */
export class SteamClientUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteamClientUnreachableError";
  }
}

export class SteamClient {
  private cdp: CDPClient | null = null;
  private opts: SteamClientOptions;

  /** `apps` namespace — see Steam's `window.SteamClient.Apps` API. */
  readonly apps: AppsApi;
  /** `url` namespace — see Steam's `window.SteamClient.URL` API. */
  readonly url: UrlApi;

  constructor(opts: SteamClientOptions = {}) {
    this.opts = opts;
    this.apps = new AppsApi(this);
    this.url = new UrlApi(this);
  }

  /**
   * Establish a CDP WebSocket connection to a SharedJSContext tab.
   * Idempotent — calling twice with an already-open connection is a no-op.
   * Throws `SteamClientUnreachableError` if no SharedJSContext is found.
   */
  async connect(): Promise<void> {
    if (this.cdp?.connected) return;

    let tab = this.opts.tab ?? null;
    if (!tab) {
      // Retry the lookup: Steam can momentarily expose an empty tab list
      // mid-transition (Gaming Mode ⇄ desktop, shortcut exit), so one miss
      // doesn't mean the SharedJSContext is gone — it may just not be
      // published yet this instant.
      const attempts = Math.max(1, this.opts.connectAttempts ?? 3);
      const delayMs = this.opts.connectRetryDelayMs ?? 700;
      for (let i = 0; i < attempts && !tab; i++) {
        if (i > 0) await sleep(delayMs);
        tab = await findSharedJsTab(this.opts);
      }
    }
    if (!tab) {
      throw new SteamClientUnreachableError(
        "No SharedJSContext tab found on Steam's CEF debug port. Steam may be " +
          "mid-transition (e.g. entering/leaving Big Picture / Gaming Mode) or " +
          "started without remote debugging enabled — retry in a moment, or " +
          "switch Steam to desktop mode.",
      );
    }

    this.cdp = new CDPClient(tab.webSocketDebuggerUrl);
    await this.cdp.connect();
  }

  /**
   * Probe — true if Steam is currently reachable AND
   * `window.SteamClient.Apps` is bound. False (no throw) on any failure.
   * Useful for "should I take the SteamClient path or the fallback?".
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.connect();
      const ok = await this.cdp!.evaluate(
        `typeof window.SteamClient?.Apps?.SetAppLaunchOptions === "function"`,
      );
      return ok === true;
    } catch {
      return false;
    }
  }

  /** Tear down the CDP connection. Safe to call when not connected. */
  async close(): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
  }

  /** @internal — used by the namespace classes. */
  async _evaluateAsync(expression: string): Promise<unknown> {
    await this.connect();
    return this.cdp!.evaluate(expression, { awaitPromise: true });
  }
}

// ─── Apps namespace ───────────────────────────────────────────────────

/**
 * Mirror of Steam's `window.SteamClient.Apps` — only methods we consume
 * are exposed. Add new ones as a single new method per Steam API call.
 */
class AppsApi {
  constructor(private client: SteamClient) {}

  /**
   * Set the launch-options string for a Steam app, *live*. Steam updates
   * its in-memory state immediately, the launch-options field reflects
   * the new value in the Steam UI without restart, and Steam writes it
   * out to `localconfig.vdf` on its own schedule.
   *
   * Pass `""` to clear the launch options.
   *
   * Throws `SteamClientUnreachableError` if Steam isn't reachable; throws
   * `Error` if the call evaluates but Steam reports the API unavailable
   * (e.g. early during Steam boot).
   */
  async setAppLaunchOptions(
    appId: number | string,
    options: string,
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    // JSON.stringify both args inside the page so the JS source we ship
    // never has to handle quote-escaping for `options`. The expression
    // returns "ok" on success or "no-api" if SetAppLaunchOptions wasn't
    // exposed on this page (Steam still booting / different UI variant).
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.SetAppLaunchOptions) return "no-api";
      await window.SteamClient.Apps.SetAppLaunchOptions(
        ${JSON.stringify(numericAppId)},
        ${JSON.stringify(options)}
      );
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.SetAppLaunchOptions is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.SetAppLaunchOptions returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Register a non-Steam game shortcut, *live*. Mirrors what BPM's
   * "Add a non-Steam game" flow does — Steam allocates a fresh
   * 32-bit appid, writes the entry into `shortcuts.vdf` on its own
   * schedule, and returns the appid here.
   *
   * Older Steam clients have been observed to resolve `AddShortcut`
   * with `undefined`; callers needing the appid in that case must
   * fall back to reading `shortcuts.vdf` and matching by name. We
   * return `number | null` rather than throwing so the caller can
   * make that choice without parsing error strings.
   */
  async addShortcut(
    name: string,
    exe: string,
    args: string = "",
    cmdLine: string = "",
  ): Promise<number | null> {
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.AddShortcut) return { tag: "no-api" };
      const result = await window.SteamClient.Apps.AddShortcut(
        ${JSON.stringify(name)},
        ${JSON.stringify(exe)},
        ${JSON.stringify(args)},
        ${JSON.stringify(cmdLine)}
      );
      return { tag: "ok", appId: typeof result === "number" ? result : null };
    })()`;
    const result = (await this.client._evaluateAsync(expr)) as {
      tag: string;
      appId?: number | null;
    };
    if (result?.tag === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.AddShortcut is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result?.tag !== "ok") {
      throw new Error(
        `SteamClient.Apps.AddShortcut returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
    return typeof result.appId === "number" ? result.appId : null;
  }

  /**
   * Rename a non-Steam shortcut. Steam's `AddShortcut` ignores the
   * display-name arg on modern clients and derives `appname` from the
   * exe basename, so callers that want a proper name must follow up
   * with this. Persists to `shortcuts.vdf` on Steam's next save.
   */
  async setShortcutName(
    appId: number | string,
    name: string,
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.SetShortcutName) return "no-api";
      await window.SteamClient.Apps.SetShortcutName(
        ${JSON.stringify(numericAppId)},
        ${JSON.stringify(name)}
      );
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.SetShortcutName is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.SetShortcutName returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Push artwork into Steam's running state for an app / shortcut so
   * the library renders it immediately — without this, files dropped
   * into `userdata/<id>/config/grid/` only show up after a Steam
   * restart. Steam's enum:
   *
   *   0 = portrait capsule  ("grid_p")
   *   1 = hero
   *   2 = logo
   *   3 = landscape capsule ("grid_l")
   *   4 = icon
   *
   * The Clear-then-Set dance with a 500 ms gap is needed because
   * `Set` alone leaves Steam's in-memory cache pointing at the
   * previous bytes (worst on non-Steam shortcuts) — `Clear` flushes
   * it but resolves before the flush actually lands. Same recipe
   * Decky's plugin uses; mirrors `plugins/steamgriddb/backend.ts`.
   *
   * `ext` is the file extension Steam stores under (`"png"` or
   * `"jpg"`); `dataBase64` is the raw image bytes base64-encoded.
   */
  async setCustomArtwork(
    appId: number | string,
    dataBase64: string,
    ext: "png" | "jpg",
    eAssetType: 0 | 1 | 2 | 3 | 4,
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      const apps = window.SteamClient?.Apps;
      if (!apps?.ClearCustomArtworkForApp || !apps?.SetCustomArtworkForApp) {
        return "no-api";
      }
      try {
        await apps.ClearCustomArtworkForApp(${JSON.stringify(numericAppId)}, ${eAssetType});
        await new Promise((r) => setTimeout(r, 500));
        await apps.SetCustomArtworkForApp(
          ${JSON.stringify(numericAppId)},
          ${JSON.stringify(dataBase64)},
          ${JSON.stringify(ext)},
          ${eAssetType}
        );
        return "ok";
      } catch (err) {
        return "err:" + (err && err.message ? err.message : String(err));
      }
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.{Set,Clear}CustomArtworkForApp not available on this Steam build.",
      );
    }
    if (typeof result === "string" && result.startsWith("err:")) {
      throw new Error(`SetCustomArtworkForApp threw: ${result.slice(4)}`);
    }
    if (result !== "ok") {
      throw new Error(
        `SetCustomArtworkForApp returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Set the Steam Play / Proton compat-tool for an app or non-Steam
   * shortcut so a Windows binary runs through Proton on Linux. The
   * recomp plugin uses this when registering shortcuts for Windows-
   * only releases (Sonic Unleashed Recomp etc.) — without it Steam
   * would try to exec the .exe natively and immediately fail.
   *
   * `toolName` is Steam's internal compat-tool id:
   *   - `""`           → reset to default (Steam picks)
   *   - `"proton_experimental"` → Proton Experimental
   *   - `"proton_9"` / `"proton_8"` / `"proton_stable"` → specific Proton
   *   - `"GE-Proton9-22"` etc. → Proton-GE installs (if user has them)
   *
   * Throws `SteamClientUnreachableError` if Steam isn't reachable or
   * the API isn't exposed; callers should treat best-effort.
   */
  async specifyCompatTool(
    appId: number | string,
    toolName: string,
    toolDisplayName: string = "",
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.SpecifyCompatTool) return "no-api";
      await window.SteamClient.Apps.SpecifyCompatTool(
        ${JSON.stringify(numericAppId)},
        ${JSON.stringify(toolName)},
        ${JSON.stringify(toolDisplayName)}
      );
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.SpecifyCompatTool is not available on this Steam build.",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.SpecifyCompatTool returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Apply a user tag to an installed Steam app or non-Steam shortcut.
   * Modern Steam surfaces user tags as auto-generated collections in
   * the library sidebar AND lets users build dynamic collections that
   * filter by them — so callers like the recomp plugin can use this
   * to group every shortcut they install under a "Recomp" pseudo-
   * collection without manually creating Steam collections.
   *
   * Idempotent on Steam's side: re-tagging an already-tagged app is a
   * no-op. Throws `SteamClientUnreachableError` if Steam isn't
   * reachable or the API isn't exposed; callers should treat as
   * best-effort and swallow so a tagging failure doesn't block the
   * primary "add to Steam" flow.
   */
  async addUserTag(appId: number | string, tag: string): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    if (typeof tag !== "string" || tag.length === 0) {
      throw new Error("addUserTag: tag must be a non-empty string");
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.AddUserTagOnApp) return "no-api";
      await window.SteamClient.Apps.AddUserTagOnApp(
        ${JSON.stringify(numericAppId)},
        ${JSON.stringify(tag)}
      );
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.AddUserTagOnApp is not available on this Steam build — try a newer client.",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.AddUserTagOnApp returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Add (or merge) `appId` into a user-created Steam Library Collection
   * named `collectionName`. The collection lands in Steam's
   * "Collections" tab (not just the sidebar dynamic-grouping that
   * `addUserTag` produces).
   *
   * Drives `window.collectionStore`, an MobX-tracked SteamUI module.
   * The surface is undocumented but stable across mainstream Steam
   * builds (post ~2019 Library rewrite):
   *
   *   - `GetUserCollectionsByName(name)` → existing collection or
   *     `undefined`. We look this up first so re-adds to the same
   *     name merge rather than spawning siblings.
   *   - `NewUnsavedCollection(name)` → fresh editable collection
   *     with that display name.
   *   - `<collection>.AddApps([appId])` → idempotent merge.
   *   - `SaveCollection(collection)` → persists to cloud-storage so
   *     other Steam clients see it.
   *
   * Best-effort like `addUserTag` — callers should swallow exceptions
   * so an old/forked Steam build doesn't block the primary add-to-
   * Steam flow.
   */
  async addAppToCollection(
    appId: number | string,
    collectionName: string,
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    if (typeof collectionName !== "string" || collectionName.length === 0) {
      throw new Error("addAppToCollection: collectionName must be a non-empty string");
    }
    // Steam's collectionStore internals:
    //
    //   - `NewUnsavedCollection(name, basis, addedApps)` takes a 3-tuple
    //     where `addedApps` is an array of objects shaped `{ appid: N }`
    //     (NOT raw appids — the store calls `.appid` on each entry).
    //     `basis` is `null` for a fresh collection.
    //   - `AddApps([{appid: N}])` follows the same wrapper convention
    //     on existing collections.
    //   - `SaveCollection(col)` is what flips the collection from
    //     transient (`m_strId` starts `uc-…` but not yet in the cloud
    //     storage namespace) to persisted. Without this call the
    //     collection disappears on next Steam start.
    //   - `GetUserCollectionsByName` returns an array (possibly empty)
    //     — we take the first hit so re-adds to the same name merge.
    // Idempotency: `AddApps` itself is NOT a no-op when the appid is
    // already in `m_setApps` — repeated Add → Save cycles can leave
    // the collection holding duplicate references to the same app
    // (visible to the user as the same shortcut appearing twice in
    // the Collections tab). Probe `m_setApps` (a real Set) for the
    // appid first and short-circuit when present. Same-named recomp
    // shortcuts with distinct appids are unaffected — the check is
    // strictly per-appid.
    const expr = `(async () => {
      const cs = window.collectionStore;
      if (!cs) return "no-store";
      if (typeof cs.SaveCollection !== "function" || typeof cs.NewUnsavedCollection !== "function") {
        return "no-api";
      }
      const appWrapper = [{ appid: ${numericAppId} }];
      let col = null;
      try {
        if (typeof cs.GetUserCollectionsByName === "function") {
          const found = cs.GetUserCollectionsByName(${JSON.stringify(collectionName)});
          col = Array.isArray(found) ? found[0] : found;
        }
      } catch {}
      if (col) {
        // Already a member → nothing to do. Saving here would be a
        // wasted cloud-config round-trip.
        const apps = col.m_setApps;
        const alreadyHas =
          (apps && typeof apps.has === "function" && apps.has(${numericAppId})) ||
          (Array.isArray(col.m_rgApps) && col.m_rgApps.includes(${numericAppId}));
        if (alreadyHas) return "ok-noop";
        try { col.AddApps(appWrapper); } catch (e) { return "addapps-failed:" + (e && e.message); }
      } else {
        try {
          col = cs.NewUnsavedCollection(${JSON.stringify(collectionName)}, null, appWrapper);
        } catch (e) { return "new-failed:" + (e && e.message); }
      }
      if (!col) return "no-collection";
      try { await cs.SaveCollection(col); } catch (e) { return "save-failed:" + (e && e.message); }
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-store" || result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.collectionStore is not available on this Steam build — collections require the modern Library UI.",
      );
    }
    if (result !== "ok" && result !== "ok-noop") {
      throw new Error(
        `addAppToCollection returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Update the launch-options string on an existing non-Steam shortcut.
   * The shortcut is identified by its 32-bit appid (the value returned
   * by `addShortcut`, or the entry's `appid` field in `shortcuts.vdf`).
   *
   * Pass `""` to clear the launch options.
   */
  async setShortcutLaunchOptions(
    appId: number | string,
    options: string,
  ): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.SetShortcutLaunchOptions) return "no-api";
      await window.SteamClient.Apps.SetShortcutLaunchOptions(
        ${JSON.stringify(numericAppId)},
        ${JSON.stringify(options)}
      );
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.SetShortcutLaunchOptions is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.SetShortcutLaunchOptions returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Delete a non-Steam shortcut. Steam removes it from `shortcuts.vdf`
   * on its next save. Throws if Steam isn't reachable; resolves
   * silently when the appid doesn't correspond to an existing shortcut
   * (Steam treats this as a no-op).
   */
  async removeShortcut(appId: number | string): Promise<void> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.RemoveShortcut) return "no-api";
      await window.SteamClient.Apps.RemoveShortcut(${JSON.stringify(numericAppId)});
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.RemoveShortcut is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.Apps.RemoveShortcut returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Read back a shortcut entry's live state from Steam. Used to
   * poll-confirm `setShortcutLaunchOptions` has propagated through
   * Steam's async client IPC before dispatching `steam://rungameid/`
   * — without this, the rungameid dispatch can race the launch-option
   * update and Steam executes the shortcut with the previous URL.
   *
   * Returns `null` when the appid has no matching shortcut (already
   * removed, never existed).
   */
  async getShortcutData(
    appId: number | string,
  ): Promise<{ LaunchOptions?: string; AppName?: string } | null> {
    const numericAppId = Number(appId);
    if (!Number.isFinite(numericAppId)) {
      throw new Error(`Invalid appId: ${appId}`);
    }
    const expr = `(async () => {
      if (!window.SteamClient?.Apps?.GetShortcutData) return { tag: "no-api" };
      const data = await window.SteamClient.Apps.GetShortcutData(${JSON.stringify(numericAppId)});
      if (!data) return { tag: "ok", data: null };
      // Project to a plain object so structured-clone over CDP doesn't
      // choke on any Steam-side non-cloneable fields.
      return { tag: "ok", data: {
        LaunchOptions: typeof data.strLaunchOptions === "string"
          ? data.strLaunchOptions
          : (typeof data.LaunchOptions === "string" ? data.LaunchOptions : ""),
        AppName: typeof data.strAppName === "string"
          ? data.strAppName
          : (typeof data.AppName === "string" ? data.AppName : ""),
      }};
    })()`;
    const result = (await this.client._evaluateAsync(expr)) as {
      tag: string;
      data?: { LaunchOptions?: string; AppName?: string } | null;
    };
    if (result?.tag === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.Apps.GetShortcutData is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result?.tag !== "ok") {
      throw new Error(
        `SteamClient.Apps.GetShortcutData returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
    return result.data ?? null;
  }

  /**
   * Read the user's full *owned* Steam library — every app in
   * `window.appStore.allApps`, not just the installed titles that
   * `@loadout/steam-paths` can see on disk. This is the only source
   * for owned-but-not-installed games (they have no
   * `appmanifest_*.acf`).
   *
   * `appStore.allApps` is an array of MobX app-overview objects; we
   * project each to a plain `{ appId, name }` inside the page so the
   * structured-clone over CDP stays cheap and never trips on a
   * non-cloneable MobX field. `app_type === 1` is Steam's "game" enum
   * — it filters out tools, demos, soundtracks, videos, and config
   * apps so the grid only shows real games.
   *
   * Throws `SteamClientUnreachableError` if `appStore` hasn't booted
   * (Steam still starting, or the library UI never opened this
   * session).
   */
  async getAllApps(): Promise<Array<{ appId: string; name: string }>> {
    const expr = `(() => {
      const store = window.appStore;
      if (!store || !Array.isArray(store.allApps)) return { tag: "no-store" };
      const apps = store.allApps
        .filter((a) => a && a.app_type === 1)
        .map((a) => ({
          appId: String(a.appid),
          name: a.display_name || String(a.appid),
        }));
      return { tag: "ok", apps };
    })()`;
    const result = (await this.client._evaluateAsync(expr)) as {
      tag: string;
      apps?: Array<{ appId: string; name: string }>;
    };
    if (result?.tag === "no-store") {
      throw new SteamClientUnreachableError(
        "window.appStore.allApps is not available on the SharedJSContext tab — is Steam's library UI booted?",
      );
    }
    if (result?.tag !== "ok" || !Array.isArray(result.apps)) {
      throw new Error(
        `appStore.allApps read returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
    return result.apps;
  }
}

// ─── URL namespace ────────────────────────────────────────────────────

/**
 * Mirror of Steam's `window.SteamClient.URL` — only `ExecuteSteamURL`
 * (the in-page equivalent of typing a `steam://` URL into the launcher
 * or shelling out to `xdg-open steam://...`).
 *
 * Preferred over `Bun.spawn(["steam", url])` because it dispatches
 * through the running Steam client's existing URL handler instead of
 * opening a second Steam process — avoiding the race where the new
 * process exits before the URL is delivered to the live client.
 */
class UrlApi {
  constructor(private client: SteamClient) {}

  /** Dispatch a `steam://` URL through the running client. */
  async executeSteamURL(url: string): Promise<void> {
    const expr = `(() => {
      if (!window.SteamClient?.URL?.ExecuteSteamURL) return "no-api";
      window.SteamClient.URL.ExecuteSteamURL(${JSON.stringify(url)});
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result === "no-api") {
      throw new SteamClientUnreachableError(
        "window.SteamClient.URL.ExecuteSteamURL is not available on the SharedJSContext tab — is Steam fully booted?",
      );
    }
    if (result !== "ok") {
      throw new Error(
        `SteamClient.URL.ExecuteSteamURL returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }

  /**
   * Open a web URL inside Steam's own in-client browser via
   * `window.open(url, "_blank")` evaluated in the SharedJSContext tab.
   *
   * This is the exact path the injected ProtonDB badge takes when the
   * user clicks it on a Steam library / store page — so driving it
   * from here reproduces that behaviour (the page opens in Steam's
   * built-in browser overlay) rather than spawning a desktop browser.
   *
   * Unlike `executeSteamURL`, `window.open` is always present, so
   * there's no `no-api` branch; we only surface the standard
   * unreachable error from the underlying connect/evaluate.
   */
  async openWebUrl(url: string): Promise<void> {
    const expr = `(() => {
      window.open(${JSON.stringify(url)}, "_blank");
      return "ok";
    })()`;
    const result = await this.client._evaluateAsync(expr);
    if (result !== "ok") {
      throw new Error(
        `window.open returned unexpected value: ${JSON.stringify(result)}`,
      );
    }
  }
}

/**
 * Serialises every `withSteamClient` session. Steam's CEF IPC client
 * asserts `"Collided with existing master response stream"`
 * (chrome_ipc_client.cpp) and the whole `steamwebhelper` process aborts
 * — taking the entire Steam UI down — if two CDP clients drive the
 * SharedJSContext target's IPC at the same time. A one-shot
 * `withSteamClient` opens a fresh connection per call, so a caller that
 * fires several at once (e.g. recomp registering multiple non-Steam
 * shortcuts + pushing artwork in the same tick) produces overlapping
 * connections and crashes Steam.
 *
 * Chaining each session onto a single module-level promise guarantees at
 * most one transient connection is live at a time. The chain swallows
 * each session's outcome so one failing session never rejects the next
 * waiter; the real result/rejection still flows back to that session's
 * own caller.
 */
let steamClientChain: Promise<unknown> = Promise.resolve();

/**
 * One-shot helper: connect → run callback → close. The right shape for
 * occasional, human-paced calls (e.g. clicking Apply once per game).
 *
 * Sessions are serialised globally — see `steamClientChain` — so
 * concurrent callers can't open colliding CDP connections and crash
 * Steam's webhelper.
 */
export async function withSteamClient<T>(
  fn: (sc: SteamClient) => Promise<T>,
  opts: SteamClientOptions = {},
): Promise<T> {
  const run = async (): Promise<T> => {
    const sc = new SteamClient(opts);
    try {
      return await fn(sc);
    } finally {
      await sc.close();
    }
  };
  // Queue behind any in-flight session regardless of how it settled.
  const result = steamClientChain.then(run, run);
  // Keep the chain alive but isolated from this session's success/failure.
  steamClientChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
