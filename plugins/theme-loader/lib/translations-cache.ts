/**
 * Class-name translation cache.
 *
 * Steam re-hashes its compiled CSS class names on every release, which
 * breaks community themes that selectors-target older builds. The
 * deckthemes API publishes a JSON map of every observed Steam class
 * name across builds, keyed by a stable identifier with the current
 * build's name as the last entry of each variant array. We use that
 * map at apply-time to rewrite stale selectors forward.
 *
 * The map is fetched at runtime (not bundled). It is cached under
 * `~/.cache/loadout/theme-loader/css-translations.json` and
 * refreshed every 24h (matches the upstream `cache-control` header).
 *
 * State machine, exposed via {@link getTranslationsStatus}:
 *
 *   pending → no translations available (no cache + no successful fetch)
 *   ready   → map is loaded; theme apply may proceed
 *   error   → last fetch failed and no cache exists; apply should block
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const STABLE_URL = "https://api.deckthemes.com/stable.json";
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "loadout", "theme-loader");
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

let CACHE_DIR =
  process.env.LOADOUT_CSS_CACHE_DIR &&
  process.env.LOADOUT_CSS_CACHE_DIR.length > 0
    ? process.env.LOADOUT_CSS_CACHE_DIR
    : DEFAULT_CACHE_DIR;
let CACHE_PATH = join(CACHE_DIR, "css-translations.json");

type RawTranslations = Record<string, string[]>;

export type TranslationsState = "pending" | "ready" | "error";

export interface TranslationsStatus {
  state: TranslationsState;
  /** ms epoch of the last successful sync (cache mtime), or null. */
  syncedAt: number | null;
  /** Number of (oldName → currentName) entries currently in memory. */
  entryCount: number;
  /** Last fetch error message, if any. */
  lastError: string | null;
}

let translations: Map<string, string> | null = null;
let lastSyncedAt: number | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;

function buildMap(data: RawTranslations): Map<string, string> {
  const map = new Map<string, string>();
  for (const variants of Object.values(data)) {
    if (!Array.isArray(variants) || variants.length < 2) continue;
    const current = variants[variants.length - 1];
    for (let i = 0; i < variants.length - 1; i++) {
      if (variants[i] !== current) {
        map.set(variants[i], current);
      }
    }
  }
  return map;
}

async function readCache(): Promise<{ data: RawTranslations; mtime: number } | null> {
  try {
    const [text, st] = await Promise.all([
      readFile(CACHE_PATH, "utf-8"),
      stat(CACHE_PATH),
    ]);
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return { data: data as RawTranslations, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

async function fetchUpstream(): Promise<RawTranslations> {
  const res = await fetch(STABLE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("upstream did not return a JSON object");
  }
  return parsed as RawTranslations;
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
    translations = buildMap(data);
    await writeCacheIfChanged(JSON.stringify(data));
    lastSyncedAt = Date.now();
    lastError = null;
    console.log(`[theme-loader] Synced ${translations.size} class translations from api.deckthemes.com`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[theme-loader] Translation sync failed: ${lastError}`);
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
 * Returns the in-memory translation map. Call once at plugin start to
 * prime the cache; subsequent calls return immediately.
 *
 * Behavior:
 * - In-memory present and fresh: return it (no network).
 * - In-memory present but stale (>24h): return it; revalidate in background.
 * - On-disk cache present and fresh: load it, return.
 * - On-disk cache present but stale: load it; revalidate in background.
 * - No cache: fetch synchronously. On failure, leave map unset and
 *   return an empty Map (status will be "error").
 */
export async function ensureTranslations(): Promise<Map<string, string>> {
  if (translations) {
    if (lastSyncedAt && Date.now() - lastSyncedAt > TTL_MS) {
      startBackgroundRevalidate();
    }
    return translations;
  }

  const cached = await readCache();
  if (cached) {
    translations = buildMap(cached.data);
    lastSyncedAt = cached.mtime;
    if (Date.now() - cached.mtime > TTL_MS) {
      startBackgroundRevalidate();
    }
    return translations;
  }

  if (!inflight) {
    inflight = performFetch().finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch {
    // Status reflects the failure.
  }
  return translations ?? new Map();
}

/** Synchronous accessor used by `theme-pack.ts` during CSS assembly. */
export function getTranslationsSync(): Map<string, string> | null {
  return translations;
}

export function getTranslationsStatus(): TranslationsStatus {
  let state: TranslationsState;
  if (translations && translations.size > 0) state = "ready";
  else if (lastError) state = "error";
  else state = "pending";
  return {
    state,
    syncedAt: lastSyncedAt,
    entryCount: translations?.size ?? 0,
    lastError,
  };
}

/** Force a refresh now; returns the resulting status. */
export async function refreshTranslations(opts: { force?: boolean } = {}): Promise<TranslationsStatus> {
  const fresh = lastSyncedAt && Date.now() - lastSyncedAt < TTL_MS;
  if (!opts.force && fresh && translations) return getTranslationsStatus();
  if (!inflight) {
    inflight = performFetch().finally(() => { inflight = null; });
  }
  try {
    await inflight;
  } catch {
    // Status already updated by performFetch.
  }
  return getTranslationsStatus();
}

/** Reset module state. Test-only. */
export function _resetForTests(opts?: { cacheDir?: string }): void {
  translations = null;
  lastSyncedAt = null;
  lastError = null;
  inflight = null;
  if (opts?.cacheDir) {
    CACHE_DIR = opts.cacheDir;
    CACHE_PATH = join(CACHE_DIR, "css-translations.json");
  }
}

/** Path of the on-disk cache. Exported for tests / diagnostics. */
export function getCachePath(): string {
  return CACHE_PATH;
}
