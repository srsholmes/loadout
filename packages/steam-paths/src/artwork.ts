export interface SteamArtworkUrls {
  hero: string;
  logo: string;
  header: string;
  capsule: string;
}

/**
 * Loader-hosted artwork URLs must be absolute. The CEF webview loads
 * from `views://overlay/index.html` (Electrobun) so a relative path
 * resolves against the `views://` scheme and never reaches the Bun
 * server. Mirrors the same convention as `plugins/game-browser/backend.ts`
 * — the loader binds 33820 in both dev and prod and the steam-grid
 * route emits `Access-Control-Allow-Origin: *` so the cross-origin
 * GET works.
 */
const LOADER_ORIGIN = "http://localhost:33820";

/**
 * Steam non-Steam shortcuts use uint32 appIds with the high bit set
 * (≥ 2^31). Real Steam apps fit comfortably under 2^31 — the largest
 * appId Valve has issued as of writing is well below 4M. Anything at
 * or above 2^31 is a shortcut added by the user (Steam ROM Manager,
 * EmuDeck, "Add a non-Steam game", etc.).
 */
const SHORTCUT_APPID_THRESHOLD = 0x80000000;

/**
 * Compute Steam's 64-bit `gameid` for a non-Steam shortcut. Mirrors
 * `shortcutGameId64` in `@loadout/vdf`; inlined here so this
 * package doesn't take a dep on vdf for one bit of arithmetic. The
 * returned value is the filename stem under `userdata/<id>/config/
 * grid/` for shortcuts.
 *
 *   gameid64 = (appid << 32) | 0x02000000
 */
function shortcutGameId64(appIdUint32: number): string {
  const id = (BigInt(appIdUint32 >>> 0) << 32n) | 0x02000000n;
  return id.toString();
}

/**
 * Build artwork URLs for an appId. Always routes through the loader's
 * `/api/steam-grid/<stem>/<type>` endpoint — Steam keeps every game's
 * art locally:
 *
 *   - Real Steam apps land in `~/.local/share/Steam/appcache/library
 *     cache/<appId>/{library_hero,library_600x900,header,logo}.{jpg,
 *     png}` (Steam's own canonical files for its library UI).
 *   - User customisations + SGDB applies land in `userdata/<userId>/
 *     config/grid/<stem>_<type>.{jpg,png}` (which takes priority over
 *     Steam's own files in the route).
 *   - Non-Steam shortcuts only have the `userdata/.../grid/` form.
 *
 * Going local everywhere means the overlay works offline AND respects
 * the user's SGDB / "Set Custom Artwork" overrides, which a CDN URL
 * would never see. Was the second half of issue #113.
 *
 * Shortcuts pass the 64-bit gameid64 stem so the route can probe both
 * `gameid64_<type>` and the recovered shortcut-appid stem (Steam writes
 * the latter via `SetCustomArtworkForApp`). Steam apps pass their bare
 * appId — the route falls back to Steam's appcache when nothing's in
 * `grid/`.
 *
 * `userId` is omitted from the URL — the auto-discover form scans
 * every user profile, which the homepage needs since it doesn't know
 * which Steam account the running game was launched from.
 */
export function steamArtworkUrls(appId: number | string): SteamArtworkUrls {
  const numeric = typeof appId === "number" ? appId : Number(appId);
  let stem: string;
  if (Number.isFinite(numeric) && numeric >= SHORTCUT_APPID_THRESHOLD) {
    stem = shortcutGameId64(numeric);
  } else {
    stem = String(appId);
  }
  const base = `${LOADER_ORIGIN}/api/steam-grid/${stem}`;
  return {
    hero: `${base}/hero`,
    logo: `${base}/logo`,
    header: `${base}/header`,
    capsule: `${base}/capsule`,
  };
}
