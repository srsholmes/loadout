/**
 * @loadout/sgdb-art — shared SteamGridDB artwork pipeline.
 *
 * One canonical implementation of "search SGDB → fetch grids /
 * heroes / logos / icons → pick best → download → write to every
 * Steam user's grid dir + push live via SteamClient.setCustomArtwork".
 *
 * Consumed by:
 *   - `plugins/store-bridge` (Epic shortcuts)
 *   - `plugins/recomp` (recompiled game shortcuts)
 *
 * The `plugins/steamgriddb` plugin still owns the SGDB API key (the
 * user configures it once there) and the UI for picking specific
 * artwork by hand. This package only reads the stored key — it
 * doesn't manage it.
 */
import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createExternalCache } from "@loadout/external-cache";
import { readPluginStorage } from "@loadout/plugin-storage";
import { withSteamClient } from "@loadout/steam-cdp";
import { getSteamDir } from "@loadout/steam-paths";
import { shortcutGameId64 } from "@loadout/vdf";

export type ArtType = "grid_p" | "grid_l" | "hero" | "logo" | "icon";
export type SgdbGameSource = "steam" | "shortcut";

export interface SgdbImage {
  id: number;
  score: number;
  url: string;
  thumb?: string;
  nsfw?: boolean;
  humor?: boolean;
}

export interface ApplyAllArtworkInput {
  /**
   * Steam app id. For non-Steam shortcuts pass the uint32 appid Steam
   * allocated when `addShortcut` was called.
   */
  appId: number;
  /** "shortcut" for non-Steam shortcuts; "steam" for native titles. */
  source: SgdbGameSource;
  /**
   * Title to search SGDB for. Used when `sgdbId` is not provided.
   * Stable per install — caller doesn't need to normalise.
   */
  title: string;
  /**
   * Skip the autocomplete search if the caller already knows the
   * SGDB game id (e.g. recomp's per-game registry has it baked in).
   */
  sgdbId?: number;
  /**
   * Per-asset-type fallback URLs. Used when SGDB has no usable
   * image for that slot. e.g. Epic's `keyImages` ship a tall capsule
   * even for obscure games SGDB doesn't have.
   */
  fallbackUrls?: Partial<Record<ArtType, string>>;
  /**
   * Restrict which asset types this call applies. Defaults to all
   * five. Caller can pass `["grid_p", "hero"]` etc. for cheaper
   * partial applies.
   */
  types?: ArtType[];
}

export interface ApplyAllArtworkResult {
  /** Total file writes (across users × stems × types) that succeeded. */
  written: number;
  /** Per-asset-type result, including which source the image came from. */
  applied: Partial<
    Record<ArtType, { source: "sgdb" | "fallback"; url: string; instant: boolean }>
  >;
  /** Set when the API key wasn't configured (and no fallbacks were
   *  usable) — caller can surface a one-liner pointing at the
   *  steamgriddb plugin's settings. */
  missingApiKey?: boolean;
  /** SGDB game id we ended up using (resolved or provided). */
  sgdbId?: number;
}

/**
 * The full pipeline. Soft-failures (network, one missing asset type,
 * Steam not running) do NOT throw — we apply what we can and report
 * a structured result the caller can log. Hard configuration issues
 * (missing API key + no fallbacks for any type) come back as a
 * non-throwing result with `missingApiKey: true`.
 */
export async function applyAllArtwork(
  input: ApplyAllArtworkInput,
): Promise<ApplyAllArtworkResult> {
  const wantedTypes = input.types ?? ALL_ART_TYPES;
  const apiKey = await readSgdbApiKey();
  const fallbacks = input.fallbackUrls ?? {};

  // Resolve the SGDB game id once if needed. `sgdbId` from the
  // caller short-circuits the search (recomp uses this with its
  // per-game registry's `steamGridDbId` field).
  let sgdbId: number | null = input.sgdbId ?? null;
  if (apiKey && sgdbId == null && input.title.trim().length > 0) {
    sgdbId = await searchSgdbGameId(input.title, apiKey).catch(() => null);
  }

  if (!apiKey && !hasAnyFallback(fallbacks, wantedTypes)) {
    return { written: 0, applied: {}, missingApiKey: true };
  }

  const userDirs = await listUserDirs();
  const stems = stemsFor(input.appId, input.source);

  const applied: ApplyAllArtworkResult["applied"] = {};
  let written = 0;

  for (const type of wantedTypes) {
    const picked = await pickAsset(type, apiKey, sgdbId, fallbacks[type]);
    if (!picked) continue;

    let bytes: ArrayBuffer;
    try {
      bytes = await downloadImage(picked.url);
    } catch {
      continue;
    }
    const ext = extFor(picked.url);
    const buf = Buffer.from(bytes);

    // 1) Write files into every Steam user's `config/grid/`. Two
    //    stems per shortcut (uint32 appid + 64-bit gameid64) so both
    //    Big Picture and the loader's grid route resolve.
    for (const userDir of userDirs) {
      const gridDir = join(userDir, "config", "grid");
      try {
        await mkdir(gridDir, { recursive: true });
      } catch {
        continue;
      }
      for (const stem of stems) {
        try {
          await writeFile(join(gridDir, filenameFor(stem, type, ext)), buf);
          written++;
        } catch {
          /* best-effort */
        }
      }
    }

    // 2) Push bytes into Steam's running state so the shortcut tile
    //    refreshes immediately. setCustomArtwork only accepts png/jpg.
    let instant = false;
    const fmt = ext.replace(/^\./, "").toLowerCase();
    if (fmt === "png" || fmt === "jpg" || fmt === "jpeg") {
      const base64 = buf.toString("base64");
      const steamFmt: "png" | "jpg" = fmt === "jpeg" ? "jpg" : (fmt as "png" | "jpg");
      try {
        await withSteamClient((sc) =>
          sc.apps.setCustomArtwork(
            input.appId,
            base64,
            steamFmt,
            STEAM_ASSET_TYPE[type],
          ),
        );
        instant = true;
      } catch (err) {
        console.warn(
          `[sgdb-art] setCustomArtwork(${type}) failed for appId=${input.appId} (best-effort):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    applied[type] = { source: picked.source, url: picked.url, instant };
  }

  return {
    written,
    applied,
    ...(sgdbId != null ? { sgdbId } : {}),
  };
}

// ─── Catalog-tile URL helper (no download, no file write) ──────────────────

const catalogCache = createExternalCache("sgdb-art-catalog");

/**
 * Resolve a portrait-capsule URL for a title — used by catalog grids
 * to render cover art for not-yet-installed games. Cached aggressively
 * (24h) since SGDB image URLs are effectively immutable.
 *
 * Returns null when no API key, no match, or any network failure.
 */
export async function getCatalogCoverUrl(opts: {
  title: string;
  sgdbId?: number;
  /** Stable cache key — usually the consumer's own per-game id. */
  cacheKey: string;
}): Promise<string | null> {
  const apiKey = await readSgdbApiKey();
  if (!apiKey) return null;
  try {
    return await catalogCache.getOrFetch<string | null>(
      `catalog-cover:${opts.cacheKey}`,
      async () => {
        const sgdbId = opts.sgdbId ?? (await searchSgdbGameId(opts.title, apiKey));
        if (sgdbId == null) return null;
        const images = await sgdbFetch<SgdbImage[]>(
          `/grids/game/${sgdbId}?dimensions=600x900,460x215`,
          apiKey,
          `sgdb-grids-portrait:${sgdbId}`,
        );
        return pickBestImage(images)?.url ?? null;
      },
      { ttlSec: 24 * 60 * 60 },
    );
  } catch {
    return null;
  }
}

/**
 * Resolve a landscape hero URL for a title — used by detail pages
 * to render the wide banner artwork above the action buttons.
 * Mirrors `getCatalogCoverUrl` but hits `/heroes/game/<id>`.
 * Cached for 24h alongside the capsule URLs.
 *
 * Returns null when no API key, no match, or any network failure.
 */
export async function getCatalogHeroUrl(opts: {
  title: string;
  sgdbId?: number;
  cacheKey: string;
}): Promise<string | null> {
  const apiKey = await readSgdbApiKey();
  if (!apiKey) return null;
  try {
    return await catalogCache.getOrFetch<string | null>(
      `catalog-hero:${opts.cacheKey}`,
      async () => {
        const sgdbId = opts.sgdbId ?? (await searchSgdbGameId(opts.title, apiKey));
        if (sgdbId == null) return null;
        const images = await sgdbFetch<SgdbImage[]>(
          `/heroes/game/${sgdbId}`,
          apiKey,
          `sgdb-heroes:${sgdbId}`,
        );
        return pickBestImage(images)?.url ?? null;
      },
      { ttlSec: 24 * 60 * 60 },
    );
  } catch {
    return null;
  }
}

// ─── SGDB plumbing ─────────────────────────────────────────────────────────

const SGDB_API_BASE = "https://www.steamgriddb.com/api/v2";
const SGDB_PLUGIN_ID = "steamgriddb";
const CACHE_TTL_SEC = 6 * 60 * 60;
const sgdbCache = createExternalCache("sgdb-art");

const ALL_ART_TYPES: ArtType[] = ["grid_p", "grid_l", "hero", "logo", "icon"];

/**
 * Steam's `eAssetType` enum. Same mapping the steamgriddb plugin uses
 * internally — kept in sync here so a future change has to touch
 * exactly one place.
 */
const STEAM_ASSET_TYPE: Record<ArtType, 0 | 1 | 2 | 3 | 4> = {
  grid_p: 0,
  grid_l: 3,
  hero: 1,
  logo: 2,
  icon: 4,
};

/** SGDB endpoint per asset type. The `?dimensions=` filter biases
 *  picks toward shapes Steam actually renders so we don't end up
 *  with a square hero or a poster-aspect capsule. */
function endpointFor(type: ArtType, sgdbId: number): string {
  switch (type) {
    case "grid_p":
      return `/grids/game/${sgdbId}?dimensions=600x900,460x215`;
    case "grid_l":
      return `/grids/game/${sgdbId}?dimensions=920x430,460x215`;
    case "hero":
      return `/heroes/game/${sgdbId}`;
    case "logo":
      return `/logos/game/${sgdbId}`;
    case "icon":
      return `/icons/game/${sgdbId}`;
  }
}

function cacheKeyFor(type: ArtType, sgdbId: number): string {
  return `sgdb-${type}:${sgdbId}`;
}

async function pickAsset(
  type: ArtType,
  apiKey: string | null,
  sgdbId: number | null,
  fallbackUrl: string | undefined,
): Promise<{ url: string; source: "sgdb" | "fallback" } | null> {
  if (apiKey && sgdbId != null) {
    try {
      const images = await sgdbFetch<SgdbImage[]>(
        endpointFor(type, sgdbId),
        apiKey,
        cacheKeyFor(type, sgdbId),
      );
      const best = pickBestImage(images);
      if (best) return { url: best.url, source: "sgdb" };
    } catch {
      /* drop through to the fallback */
    }
  }
  if (fallbackUrl) return { url: fallbackUrl, source: "fallback" };
  return null;
}

/** Pull the SGDB API key out of the steamgriddb plugin's storage.
 *  `STEAMGRIDDB_API_KEY` env var is honoured as a per-process
 *  override — same convention the recomp plugin used. */
async function readSgdbApiKey(): Promise<string | null> {
  try {
    const stored = await readPluginStorage<{ apiKey?: unknown }>(SGDB_PLUGIN_ID);
    if (stored && typeof stored.apiKey === "string" && stored.apiKey.length > 0) {
      return stored.apiKey;
    }
  } catch {
    /* steamgriddb plugin never configured */
  }
  const env = process.env.STEAMGRIDDB_API_KEY;
  return env && env.length > 0 ? env : null;
}

async function sgdbFetch<T>(
  endpoint: string,
  apiKey: string,
  cacheKey: string,
): Promise<T> {
  return sgdbCache.getOrFetch<T>(
    cacheKey,
    async () => {
      const res = await fetch(`${SGDB_API_BASE}${endpoint}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        throw new Error(
          `SteamGridDB ${endpoint} failed: ${res.status} ${res.statusText}`,
        );
      }
      const json = (await res.json()) as { success: boolean; data: T };
      if (!json.success) {
        throw new Error(`SteamGridDB ${endpoint} returned success=false`);
      }
      return json.data;
    },
    { ttlSec: CACHE_TTL_SEC },
  );
}

interface SgdbSearchHit {
  id: number;
  name: string;
  verified?: boolean;
}

export async function searchSgdbGameId(
  title: string,
  apiKey: string,
): Promise<number | null> {
  const q = title.trim();
  if (q.length === 0) return null;
  try {
    const hits = await sgdbFetch<SgdbSearchHit[]>(
      `/search/autocomplete/${encodeURIComponent(q)}`,
      apiKey,
      `sgdb-search:${q.toLowerCase()}`,
    );
    if (hits.length === 0) return null;
    const verified = hits.find((h) => h.verified);
    return (verified ?? hits[0]!).id;
  } catch {
    return null;
  }
}

function pickBestImage(images: SgdbImage[]): SgdbImage | null {
  const filtered = images.filter((img) => !img.nsfw && !img.humor);
  if (filtered.length === 0) return null;
  return filtered.reduce((best, cur) => (cur.score > best.score ? cur : best));
}

// ─── File helpers ──────────────────────────────────────────────────────────

/** Both stems for non-Steam shortcuts; just the appid for native Steam
 *  titles (Steam doesn't allocate a 64-bit gameid for those). Mirrors
 *  `filenameStemsFor` in `plugins/steamgriddb/backend.ts`. */
function stemsFor(appId: number, source: SgdbGameSource): string[] {
  if (source === "shortcut") return [String(appId), shortcutGameId64(appId)];
  return [String(appId)];
}

function filenameFor(stem: string, type: ArtType, ext: string): string {
  switch (type) {
    case "grid_p": return `${stem}p${ext}`;
    case "grid_l": return `${stem}${ext}`;
    case "hero":   return `${stem}_hero${ext}`;
    case "logo":   return `${stem}_logo${ext}`;
    case "icon":   return `${stem}_icon${ext}`;
  }
}

function extFor(url: string): string {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".png")) return ".png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return ".jpg";
    if (path.endsWith(".webp")) return ".webp";
    if (path.endsWith(".ico")) return ".ico";
  } catch {
    /* Epic CDN URLs sometimes have query params the URL parser
       balks at — falling through to JPG is harmless. Steam reads
       both PNG and JPG transparently. */
  }
  return ".jpg";
}

/**
 * Disk-cached image fetch. Repeated installs (or Remove + Re-add to
 * Steam) of the same title hit local disk after the first download
 * — SGDB image URLs are effectively immutable, so the 30-day TTL is
 * the right freshness window.
 *
 * Layout: `$XDG_CACHE_HOME/steam-loader/sgdb-art/blobs/<sha256(url)>.<ext>`.
 * Same root the external-cache uses so a single `rm -rf` clears
 * everything this package puts on disk. Stored as raw bytes rather
 * than base64-in-JSON — image art is the wrong shape for the
 * existing JSON-on-disk external-cache, and the round-trip would
 * burn ~33% per blob.
 */
const BLOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function blobCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "steam-loader", "sgdb-art", "blobs");
}

function blobPathFor(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex");
  const ext = extFor(url);
  return join(blobCacheRoot(), `${hash}${ext}`);
}

async function downloadImage(url: string): Promise<ArrayBuffer> {
  const cachePath = blobPathFor(url);
  // Cache hit: fresh-enough file on disk → reuse without touching
  // the network. We `stat` to honour TTL because writes don't
  // record an `expiresAt` for blobs the way the JSON cache does.
  try {
    const s = await stat(cachePath);
    if (Date.now() - s.mtimeMs < BLOB_TTL_MS) {
      const buf = await readFile(cachePath);
      console.log(
        `[sgdb-art] cache HIT ${cachePath.split("/").pop()} (${buf.byteLength}B) ← ${url}`,
      );
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    }
  } catch {
    /* cache miss — fall through to network */
  }
  console.log(`[sgdb-art] cache MISS, fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // Best-effort persist. mkdir is recursive; a write failure here
  // means a subsequent install pays the network cost again, but
  // the current install still succeeds with the in-memory buffer.
  try {
    await mkdir(blobCacheRoot(), { recursive: true });
    await writeFile(cachePath, Buffer.from(buf));
    console.log(
      `[sgdb-art] cached ${cachePath.split("/").pop()} (${buf.byteLength}B)`,
    );
  } catch (err) {
    console.warn(
      `[sgdb-art] cache write failed for ${url}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return buf;
}

async function listUserDirs(): Promise<string[]> {
  try {
    const root = join(getSteamDir(), "userdata");
    const entries = await readdir(root);
    return entries
      .filter((u) => /^\d+$/.test(u))
      .map((u) => join(root, u));
  } catch {
    return [];
  }
}

function hasAnyFallback(
  fallbacks: Partial<Record<ArtType, string>>,
  types: ArtType[],
): boolean {
  for (const t of types) if (fallbacks[t]) return true;
  return false;
}
