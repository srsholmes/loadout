/**
 * Community theme registry cache.
 *
 * Pulls the CSS-theme directory from `api.deckthemes.com` at runtime
 * rather than bundling a snapshot. This keeps us out of the
 * fork-the-registry business: we only consume the upstream API, the
 * way the official Decky plugin and the SDH-CssLoader desktop client do.
 *
 * Shape and lifecycle mirror `translations-cache.ts`:
 *   - 24h TTL with stale-while-revalidate
 *   - Cached to `~/.cache/loadout/theme-loader/community-themes.json`
 *   - State machine exposed via {@link getCommunityThemesStatus}
 *
 * The runtime entry shape (`CommunityThemeEntry` in `lib/types.ts`)
 * is intentionally a strict subset of the API summary — only the
 * fields we display or need to install. We deliberately do NOT
 * resolve GitHub subdirs at runtime (the old build-time scrape
 * script did, but it's not needed for installation since
 * `api.deckthemes.com/blobs/{downloadBlobId}` is the canonical
 * install source).
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CommunityThemeEntry } from "./types";

const API_BASE = "https://api.deckthemes.com";
const PER_PAGE = 50;
const FILTERS = "CSS";
const ORDER = "Most Downloaded";
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "loadout", "theme-loader");
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

let CACHE_DIR =
  process.env.LOADOUT_THEME_CACHE_DIR &&
  process.env.LOADOUT_THEME_CACHE_DIR.length > 0
    ? process.env.LOADOUT_THEME_CACHE_DIR
    : DEFAULT_CACHE_DIR;
let CACHE_PATH = join(CACHE_DIR, "community-themes.json");

interface ApiThemeSummary {
  id: string;
  name: string;
  displayName?: string;
  type: string;
  version?: string;
  target?: string;
  author?: { username?: string };
  specifiedAuthor?: string;
  submitted?: string;
  updated?: string;
  starCount?: number;
  description?: string;
  source?: string;
  images?: { id: string }[];
  download?: { id: string; downloadCount?: number };
}

interface ApiListResponse {
  total: number;
  items: ApiThemeSummary[];
}

export type ThemesState = "pending" | "ready" | "error";

export interface ThemesStatus {
  state: ThemesState;
  /** ms epoch of the last successful sync, or null. */
  syncedAt: number | null;
  /** Number of themes currently in memory. */
  entryCount: number;
  /** Last fetch error message, if any. */
  lastError: string | null;
}

let entries: CommunityThemeEntry[] | null = null;
let lastSyncedAt: number | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;

function parseGithub(source: string | undefined): { repo: string | null; url: string | null } {
  if (!source) return { repo: null, url: null };
  // Strip a trailing `@<sha>` reference (used by some upstream entries).
  const clean = source.replace(/\s*@\s*[0-9a-f]+\s*$/i, "").trim();
  const m = clean.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\/|\.git)?$/i);
  // Group 1 always captures when the match succeeds.
  if (m) return { repo: m[1]!, url: `https://github.com/${m[1]}` };
  return { repo: null, url: null };
}

function authorOf(s: ApiThemeSummary): string {
  return (s.specifiedAuthor ?? s.author?.username ?? "Unknown").trim();
}

function thumbnailOf(s: ApiThemeSummary): string | null {
  const id = s.images?.[0]?.id;
  return id ? `${API_BASE}/blobs/${id}` : null;
}

function summaryToEntry(s: ApiThemeSummary): CommunityThemeEntry | null {
  if (!s.download?.id) return null;
  const gh = parseGithub(s.source);
  return {
    id: s.id,
    name: (s.displayName ?? s.name ?? s.id).trim(),
    author: authorOf(s),
    description: s.description ?? "",
    version: s.version ?? "",
    downloadBlobId: s.download.id,
    githubRepo: gh.repo,
    githubUrl: gh.url,
    thumbnailUrl: thumbnailOf(s),
    downloadCount: s.download.downloadCount ?? 0,
    starCount: s.starCount ?? 0,
    updated: s.updated ?? s.submitted ?? "",
    target: s.target ?? "",
  };
}

async function readCache(): Promise<{ data: CommunityThemeEntry[]; mtime: number } | null> {
  try {
    const [text, st] = await Promise.all([
      readFile(CACHE_PATH, "utf-8"),
      stat(CACHE_PATH),
    ]);
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) return null;
    return { data: data as CommunityThemeEntry[], mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

// Hard ceilings on the pagination loop. The API typically returns a few
// hundred CSS-type themes, so these are well above any sane upstream
// state — they only kick in if the API ever returns inconsistent counts
// (e.g. `total` huge, items array non-empty with duplicates).
const MAX_PAGES = 50;
const MAX_ENTRIES = 5000;

async function fetchUpstream(): Promise<CommunityThemeEntry[]> {
  const all: CommunityThemeEntry[] = [];
  const seenIds = new Set<string>();
  let page = 1;
  let total = Infinity;

  while (all.length < total && page <= MAX_PAGES && all.length < MAX_ENTRIES) {
    const url =
      `${API_BASE}/themes?page=${page}&perPage=${PER_PAGE}` +
      `&filters=${encodeURIComponent(FILTERS)}&order=${encodeURIComponent(ORDER)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const listing = (await res.json()) as ApiListResponse;
    total = listing.total;
    if (!listing.items?.length) break;
    for (const s of listing.items) {
      const entry = summaryToEntry(s);
      if (!entry || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      all.push(entry);
    }
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
    console.log(`[theme-loader] Synced ${data.length} themes from api.deckthemes.com`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[theme-loader] Theme registry sync failed: ${lastError}`);
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
 * Returns the in-memory theme registry. Call once at plugin start to
 * prime the cache; subsequent calls return immediately.
 *
 * Same precedence as translations-cache:
 * - In-memory present and fresh: return it (no network).
 * - In-memory present but stale: return it; revalidate in background.
 * - On-disk cache present and fresh: load it, return.
 * - On-disk cache present but stale: load it; revalidate in background.
 * - No cache: fetch synchronously. On failure, return [] (status "error").
 */
export async function ensureCommunityThemes(): Promise<CommunityThemeEntry[]> {
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
export function getCommunityThemesSync(): CommunityThemeEntry[] | null {
  return entries;
}

export function getCommunityThemesStatus(): ThemesStatus {
  let state: ThemesState;
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
export async function refreshCommunityThemes(opts: { force?: boolean } = {}): Promise<ThemesStatus> {
  const fresh = lastSyncedAt && Date.now() - lastSyncedAt < TTL_MS;
  if (!opts.force && fresh && entries) return getCommunityThemesStatus();
  if (!inflight) {
    inflight = performFetch().finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch {
    // Status already updated by performFetch.
  }
  return getCommunityThemesStatus();
}

/** Reset module state. Test-only. */
export function _resetForTests(opts?: { cacheDir?: string }): void {
  entries = null;
  lastSyncedAt = null;
  lastError = null;
  inflight = null;
  if (opts?.cacheDir) {
    CACHE_DIR = opts.cacheDir;
    CACHE_PATH = join(CACHE_DIR, "community-themes.json");
  }
}

/** Path of the on-disk cache. Exported for tests / diagnostics. */
export function getCachePath(): string {
  return CACHE_PATH;
}
