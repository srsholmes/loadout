/**
 * Steam grid artwork route — `/api/steam-grid/<id>/<userId>/<type>`
 * (per-user) and `/api/steam-grid/<id>/<type>` (auto-discover).
 *
 * Serves files from `~/.local/share/Steam/userdata/<userId>/config/
 * grid/`, which is where Steam (and SteamGridDB / EmuDeck) drop
 * user-installed artwork for non-Steam shortcuts. The path is keyed
 * by the 64-bit gameid (or the 32-bit shortcut appid as a fallback —
 * see `steamGridCandidates` below) and, optionally, the shortcut's
 * userId. The auto-discover form scans every userdata profile and
 * picks the newest-mtime match across them — used by the overlay
 * homepage (`NowPlaying`, `Sidebar`) which doesn't have the userId
 * handy and just wants "whatever art the user has applied".
 *
 * Path-validated: `<id>` and `<userId>` must be all-digits, `<type>`
 * must be one of the literals — prevents directory traversal via
 * `..` in the route regex.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  getAppCacheLibraryDir,
  getUserdataDir,
} from "@loadout/steam-paths";
import type { RouteHandler } from "./types";

export type SteamGridType = "header" | "capsule" | "hero" | "logo";

/**
 * Mapping from logical art type → filename Steam writes under
 * `appcache/librarycache/<appId>/`. The "modern" (pre-2025) layout —
 * Steam's newer client (mid-2025+) hashes filenames and adds a
 * manifest, so this fallback is partial: present for many apps
 * (Spider-Man, GTA5 capsule + hero) but absent for others
 * (Cyberpunk, GTA5 logo/header). Anything missing here gets a final
 * redirect to the public Steam CDN (see `cdnUrl`) which still serves
 * art for every real Steam app.
 */
const APPCACHE_FILENAMES: Record<SteamGridType, string> = {
  hero: "library_hero.jpg",
  capsule: "library_600x900.jpg",
  header: "header.jpg",
  logo: "logo.png",
};

/**
 * Public Steam CDN URL — the absolute last resort for Steam apps when
 * neither the user's grid dir nor Steam's appcache has the file. Real
 * appIds always resolve here; shortcuts have nothing on the CDN and
 * are not redirected (the route returns 404 for them instead). The
 * filename matches the appcache form one-to-one so the same map
 * drives both lookup paths.
 */
function cdnUrl(appId: string, type: SteamGridType): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${APPCACHE_FILENAMES[type]}`;
}

/**
 * Cache-Control for the CDN-redirect response. Without it the
 * browser re-asks the loader on every NowPlaying re-render to
 * re-resolve the Location header. 5 minutes is well below SGDB's
 * 6 h cache TTL (so a freshly-applied SGDB image still shows up
 * within a few minutes if the user customises mid-session) and
 * still amortises away most of the round-tripping during normal
 * homepage browsing.
 */
const CDN_REDIRECT_CACHE_CONTROL = "public, max-age=300";

/**
 * Whether the given id is the bare Steam appId (vs a 64-bit gameid64
 * for a non-Steam shortcut). All Steam appIds fit in a uint32; a
 * gameid64 is by construction larger than uint32 (`(appid << 32) |
 * 0x02000000`), so the size check alone is sufficient — we don't
 * need a separate sentinel test that would misclassify the literal
 * appId 33554432 (= 0x02000000) as a gameid64. Empty strings get
 * rejected by the regex, and 0 is excluded explicitly because Valve
 * never issues it as a real appId.
 */
function looksLikeSteamAppId(id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  const big = BigInt(id);
  return big > 0n && big < 0x100000000n;
}

/**
 * Build the candidate-filename list the steam-grid route probes, in
 * priority order. Pure function so the dual-stem logic (gameid64 ↔
 * shortcut appid) is unit-testable without booting Bun.serve.
 *
 * For Steam apps `id` is just the appId and only one stem is returned.
 * For non-Steam shortcuts the loader is passed the 64-bit gameid64; we
 * recover the 32-bit shortcut appid via `gameid64 >>> 32` so files Steam
 * itself wrote (Manage → Set Custom Artwork lands under the 32-bit
 * stem) resolve alongside files SGDB wrote (both stems).
 *
 * Strict aspect-ratio: capsule probes ONLY the portrait variants and
 * landscape probes ONLY the unsuffixed file — no cross-fallback. A
 * landscape image displayed in a portrait tile crops badly enough that
 * the placeholder is a better outcome (this was audit-2026-05 follow-up
 * after emulated-game tiles showed the hero instead of the capsule).
 */
export function steamGridCandidates(
  id: string,
  type: SteamGridType,
): string[] {
  const stems = [id];
  // Detect gameid64 form by the steamGameId64 sentinel in the bottom 32
  // bits. If it matches, the high 32 bits are the shortcut appid.
  const idBig = BigInt(id);
  if ((idBig & 0xffffffffn) === 0x02000000n) {
    const shortcutAppId = (idBig >> 32n).toString();
    if (shortcutAppId !== id) stems.push(shortcutAppId);
  }
  const suffixes =
    type === "capsule"
      ? ["p.jpg", "p.png"]
      : type === "hero"
        ? ["_hero.jpg", "_hero.png"]
        : type === "logo"
          ? ["_logo.png", "_logo.jpg"]
          : [".png", ".jpg"];
  return stems.flatMap((s) => suffixes.map((suf) => `${s}${suf}`));
}

const TYPE_ALT = "(header|capsule|hero|logo)";
const STEAM_GRID_PATTERN = new RegExp(
  `^/api/steam-grid/(\\d+)/(\\d+)/${TYPE_ALT}$`,
);
const STEAM_GRID_AUTO_PATTERN = new RegExp(
  `^/api/steam-grid/(\\d+)/${TYPE_ALT}$`,
);

interface BestMatch {
  file: Bun.BunFile;
  filename: string;
  mtime: number;
}

/**
 * Last-resort lookup in Steam's appcache for a real Steam appId. The
 * file is whatever Steam itself downloaded for its library UI; missing
 * apps (uninstalled, never browsed in the library) just 404. Caller
 * is expected to have already exhausted the user-customised grid dir.
 */
async function fromAppcache(
  appId: string,
  type: SteamGridType,
): Promise<BestMatch | null> {
  const filename = APPCACHE_FILENAMES[type];
  const file = Bun.file(join(getAppCacheLibraryDir(), appId, filename));
  if (!(await file.exists())) return null;
  return { file, filename, mtime: file.lastModified };
}

async function bestInGridDir(
  gridDir: string,
  candidates: string[],
): Promise<BestMatch | null> {
  // Newest-mtime wins. Steam writes PNG under the shortcut appid
  // stem (via SetCustomArtworkForApp); SGDB's file-fallback writes
  // both stems with the source extension (.jpg or .png). When the
  // user re-applies art, abandoned variants from the previous apply
  // get left behind — fixed-priority probing would serve the OLDER
  // file. Picking by mtime is robust against any shadowing pattern.
  let best: BestMatch | null = null;
  for (const filename of candidates) {
    const file = Bun.file(join(gridDir, filename));
    if (!(await file.exists())) continue;
    const mtime = file.lastModified;
    if (!best || mtime > best.mtime) {
      best = { file, filename, mtime };
    }
  }
  return best;
}

function buildResponse(req: Request, best: BestMatch): Response {
  const etag = `W/"${best.mtime}-${best.file.size}"`;
  const headers: Record<string, string> = {
    "Cache-Control": "no-cache",
    ETag: etag,
    "Access-Control-Allow-Origin": "*",
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  headers["Content-Type"] = best.filename.endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  return new Response(best.file, { headers });
}

export const steamGridRoute: RouteHandler = {
  name: "steam-grid",
  match: (_req, url) =>
    STEAM_GRID_PATTERN.test(url.pathname) ||
    STEAM_GRID_AUTO_PATTERN.test(url.pathname),
  async handle(req, url, _ctx) {
    const perUser = url.pathname.match(STEAM_GRID_PATTERN);
    if (perUser) {
      const [, idPart, userIdPart, type] = perUser;
      const t = type as SteamGridType;
      const candidates = steamGridCandidates(idPart, t);
      const gridDir = join(
        getUserdataDir(),
        userIdPart,
        "config",
        "grid",
      );
      let best = await bestInGridDir(gridDir, candidates);
      // User customisation in `grid/` wins; otherwise fall back to
      // Steam's own downloaded library art for installed Steam apps;
      // finally redirect to the public CDN for Steam apps whose
      // appcache is missing or uses the newer hash-named layout.
      if (!best && looksLikeSteamAppId(idPart)) {
        best = await fromAppcache(idPart, t);
        if (!best) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: cdnUrl(idPart, t),
              "Cache-Control": CDN_REDIRECT_CACHE_CONTROL,
            },
          });
        }
      }
      if (!best) return new Response("not found", { status: 404 });
      return buildResponse(req, best);
    }

    // Auto-discover form: scan every Steam user profile and return the
    // newest-mtime match. Used by the overlay's NowPlaying / Sidebar,
    // which know the appId of the running game but not which Steam
    // account it was launched from. Multi-user setups still work
    // because the writer (steamgriddb plugin) fans the file out to
    // every profile, so each one observes the same mtime.
    const auto = url.pathname.match(STEAM_GRID_AUTO_PATTERN);
    if (!auto) return new Response("not found", { status: 404 });
    const [, idPart, type] = auto;
    const t = type as SteamGridType;
    const candidates = steamGridCandidates(idPart, t);
    const userdata = getUserdataDir();
    let userDirs: string[] = [];
    try {
      userDirs = await readdir(userdata);
    } catch (err) {
      // No userdata at all — fall through to appcache for Steam apps.
      // ENOENT is the common case (Steam never installed); log
      // anything else (EPERM, ENOTDIR, …) so a corrupt-permissions
      // setup doesn't silently degrade to "no SGDB art ever".
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn(
          `[steam-grid] readdir(${userdata}) failed with ${code ?? err}: falling back to appcache + CDN`,
        );
      }
    }
    let best: BestMatch | null = null;
    for (const userDir of userDirs) {
      if (!/^\d+$/.test(userDir)) continue;
      const gridDir = join(userdata, userDir, "config", "grid");
      const candidate = await bestInGridDir(gridDir, candidates);
      if (candidate && (!best || candidate.mtime > best.mtime)) {
        best = candidate;
      }
    }
    if (!best && looksLikeSteamAppId(idPart)) {
      best = await fromAppcache(idPart, t);
      if (!best) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: cdnUrl(idPart, t),
            "Cache-Control": CDN_REDIRECT_CACHE_CONTROL,
          },
        });
      }
    }
    if (!best) return new Response("not found", { status: 404 });
    return buildResponse(req, best);
  },
};
