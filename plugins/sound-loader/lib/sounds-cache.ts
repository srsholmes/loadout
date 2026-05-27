/**
 * Community sound-pack registry cache.
 *
 * Pulls the audio-pack directory from `api.deckthemes.com` at runtime
 * rather than bundling a snapshot. Keeps us out of the
 * fork-the-registry business: we only consume the upstream API, the
 * way the official Decky AudioLoader plugin does.
 *
 * Shape and lifecycle mirror `theme-loader/lib/themes-cache.ts`:
 *   - 24h TTL with stale-while-revalidate
 *   - Cached to `~/.cache/loadout/sound-loader/community-packs.json`
 *   - State machine exposed via {@link getCommunityPacksStatus}
 *
 * Endpoint shape: `/themes/legacy/audio` returns a bare array (not the
 * `{total, items[]}` envelope `/themes` returns) — the pagination loop
 * terminates when an empty page comes back rather than counting against
 * a `total`.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CommunityPackEntry } from "./types";

const API_BASE = "https://api.deckthemes.com";
const ENDPOINT = "/themes/legacy/audio";
const PER_PAGE = 50;
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "loadout", "sound-loader");
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

let CACHE_DIR =
  process.env.LOADOUT_SOUND_CACHE_DIR &&
  process.env.LOADOUT_SOUND_CACHE_DIR.length > 0
    ? process.env.LOADOUT_SOUND_CACHE_DIR
    : DEFAULT_CACHE_DIR;
let CACHE_PATH = join(CACHE_DIR, "community-packs.json");

interface ApiAudioSummary {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  target?: string;
  download_url?: string;
  preview_image?: string | null;
  source?: string;
  manifest_version?: number;
  music?: boolean;
  last_changed?: string;
}

export type PacksState = "pending" | "ready" | "error";

export interface PacksStatus {
  state: PacksState;
  /** ms epoch of the last successful sync, or null. */
  syncedAt: number | null;
  /** Number of packs currently in memory. */
  entryCount: number;
  /** Last fetch error message, if any. */
  lastError: string | null;
}

let entries: CommunityPackEntry[] | null = null;
let lastSyncedAt: number | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;

function parseGithub(source: string | undefined): string | null {
  if (!source) return null;
  // Strip a trailing `@<sha>` reference (used by some upstream entries).
  const clean = source.replace(/\s*@\s*[0-9a-f]+\s*$/i, "").trim();
  const m = clean.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\/|\.git)?$/i);
  return m ? `https://github.com/${m[1]}` : null;
}

function summaryToEntry(s: ApiAudioSummary): CommunityPackEntry | null {
  if (!s.id || !s.download_url) return null;
  return {
    id: s.id,
    name: (s.name ?? s.id).trim(),
    author: (s.author ?? "Unknown").trim(),
    description: s.description ?? "",
    version: s.version ?? "",
    downloadUrl: s.download_url,
    previewImageUrl: s.preview_image ?? null,
    githubUrl: parseGithub(s.source),
    lastChanged: s.last_changed ?? "",
    manifestVersion: s.manifest_version ?? 1,
    music: Boolean(s.music),
  };
}

async function readCache(): Promise<{ data: CommunityPackEntry[]; mtime: number } | null> {
  try {
    const [text, st] = await Promise.all([
      readFile(CACHE_PATH, "utf-8"),
      stat(CACHE_PATH),
    ]);
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) return null;
    return { data: data as CommunityPackEntry[], mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

// Hard ceilings on the pagination loop. Audio-pack count is in the low
// hundreds; these only kick in if the API ever returns inconsistent data
// (duplicates, infinite paging).
const MAX_PAGES = 50;
const MAX_ENTRIES = 5000;

async function fetchUpstream(): Promise<CommunityPackEntry[]> {
  const all: CommunityPackEntry[] = [];
  const seenIds = new Set<string>();
  let page = 1;

  while (page <= MAX_PAGES && all.length < MAX_ENTRIES) {
    const url = `${API_BASE}${ENDPOINT}?page=${page}&perPage=${PER_PAGE}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const items = (await res.json()) as ApiAudioSummary[];
    if (!Array.isArray(items) || items.length === 0) break;

    let newThisPage = 0;
    for (const s of items) {
      const entry = summaryToEntry(s);
      if (!entry || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      all.push(entry);
      newThisPage++;
    }
    // If a page returned only duplicates we've already seen, stop —
    // some legacy endpoints don't paginate stably.
    if (newThisPage === 0) break;
    page++;
  }

  return all;
}

async function writeCacheIfChanged(text: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const nextHash = createHash("sha256").update(text).digest("hex");
  try {
    const existing = await readFile(CACHE_PATH, "utf-8");
    const existingHash = createHash("sha256").update(existing).digest("hex");
    if (existingHash === nextHash) return;
  } catch { /* no existing cache */ }
  await writeFile(CACHE_PATH, text);
}

async function performFetch(): Promise<void> {
  try {
    const data = await fetchUpstream();
    entries = data;
    await writeCacheIfChanged(JSON.stringify(data));
    lastSyncedAt = Date.now();
    lastError = null;
    console.log(`[sound-loader] Synced ${data.length} packs from api.deckthemes.com`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[sound-loader] Pack registry sync failed: ${lastError}`);
    throw err;
  }
}

function startBackgroundRevalidate(): void {
  if (inflight) return;
  inflight = performFetch().catch(() => { /* keep stale cache */ }).finally(() => {
    inflight = null;
  });
}

/**
 * Returns the in-memory pack registry. Call once at plugin start to
 * prime the cache; subsequent calls return immediately.
 *
 * Same precedence as themes-cache:
 * - In-memory present and fresh: return it (no network).
 * - In-memory present but stale: return it; revalidate in background.
 * - On-disk cache present and fresh: load it, return.
 * - On-disk cache present but stale: load it; revalidate in background.
 * - No cache: fetch synchronously. On failure, return [] (status "error").
 */
export async function ensureCommunityPacks(): Promise<CommunityPackEntry[]> {
  if (entries) {
    if (lastSyncedAt && Date.now() - lastSyncedAt > TTL_MS) {
      startBackgroundRevalidate();
    }
    return entries;
  }

  const cached = await readCache();
  if (cached) {
    entries = cached.data;
    lastSyncedAt = cached.mtime;
    if (Date.now() - cached.mtime > TTL_MS) {
      startBackgroundRevalidate();
    }
    return entries;
  }

  if (!inflight) {
    inflight = performFetch().finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch {
    // Status reflects the failure.
  }
  return entries ?? [];
}

/** Synchronous accessor — returns whatever is in memory, or null. */
export function getCommunityPacksSync(): CommunityPackEntry[] | null {
  return entries;
}

export function getCommunityPacksStatus(): PacksStatus {
  let state: PacksState;
  if (entries && entries.length > 0) state = "ready";
  else if (lastError) state = "error";
  else state = "pending";
  return {
    state,
    syncedAt: lastSyncedAt,
    entryCount: entries?.length ?? 0,
    lastError,
  };
}

/** Force a refresh now; returns the resulting status. */
export async function refreshCommunityPacks(opts: { force?: boolean } = {}): Promise<PacksStatus> {
  const fresh = lastSyncedAt && Date.now() - lastSyncedAt < TTL_MS;
  if (!opts.force && fresh && entries) return getCommunityPacksStatus();
  if (!inflight) {
    inflight = performFetch().finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch {
    // Status already updated by performFetch.
  }
  return getCommunityPacksStatus();
}

/** Reset module state. Test-only. */
export function _resetForTests(opts?: { cacheDir?: string }): void {
  entries = null;
  lastSyncedAt = null;
  lastError = null;
  inflight = null;
  if (opts?.cacheDir) {
    CACHE_DIR = opts.cacheDir;
    CACHE_PATH = join(CACHE_DIR, "community-packs.json");
  }
}

/** Path of the on-disk cache. Exported for tests / diagnostics. */
export function getCachePath(): string {
  return CACHE_PATH;
}
