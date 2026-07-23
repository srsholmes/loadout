/**
 * Shell-wide user config — persisted to `~/.config/loadout/config.json`
 * via the loader's `/api/user-config` endpoint. Survives reinstalls,
 * updates, and CEF profile wipes (localStorage lived in the CEF cache
 * dir which gets blown away on overlay reinstall).
 *
 * The cache is populated on boot by `loadUserConfig()` and kept in sync
 * via a CustomEvent so multiple hooks observing the same key stay
 * consistent. Reads are synchronous off the cache; writes optimistically
 * update the cache + fire-and-forget PATCH to the backend.
 */

import { useCallback, useEffect, useState } from "react";
import { authHeaders, apiUrl } from "./backend";

type Config = Record<string, unknown>;

const CHANGE_EVENT = "loadout:user-config-changed";
const MIRROR_KEY = "loadout:user-config-mirror";

let cache: Config = readMirror();
let loaded = false;

// Resolves once the backend's authoritative config has been merged into
// `cache` (success or failure). Callers that decide whether to *write* a
// default for an unset key (e.g. the gamescope auto-scale) must await this
// first — otherwise they race the boot fetch, read the not-yet-populated
// cache as "unset", and clobber the persisted value. This is especially
// likely right after an overlay reinstall, when the localStorage mirror
// (which normally seeds `cache` synchronously) has been wiped with the CEF
// cache dir, leaving the async fetch as the only source.
let resolveLoaded!: () => void;
const loadedPromise = new Promise<void>((resolve) => {
  resolveLoaded = resolve;
});

/** Resolves once `loadUserConfig()` has populated the cache from the backend. */
export function whenUserConfigLoaded(): Promise<void> {
  return loadedPromise;
}

function readMirror(): Config {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    return raw ? (JSON.parse(raw) as Config) : {};
  } catch {
    return {};
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(cache));
  } catch {}
}

function notify(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Load config from the backend once at boot. Safe to call multiple times. */
export async function loadUserConfig(): Promise<void> {
  try {
    const res = await fetch(apiUrl("/api/user-config"), {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = (await res.json()) as Config;
    // Backend is authoritative.
    cache = { ...cache, ...remote };
    writeMirror();
    loaded = true;
    notify();
  } catch (err) {
    console.warn("[userConfig] Failed to load from backend:", err);
  } finally {
    // Unblock `whenUserConfigLoaded()` even on failure: if the backend is
    // unreachable a PATCH wouldn't reach disk anyway, so there's nothing to
    // clobber, and we mustn't deadlock waiters forever.
    resolveLoaded();
  }
}

export function isUserConfigLoaded(): boolean {
  return loaded;
}

export function getConfigValue<T>(key: string, fallback: T): T {
  const v = cache[key];
  return (v === undefined ? fallback : v) as T;
}

export function setConfigValue<T>(key: string, value: T): void {
  cache[key] = value;
  writeMirror();
  fetch(apiUrl("/api/user-config"), {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: value }),
  }).catch((err) => {
    console.warn(`[userConfig] Failed to persist "${key}":`, err);
  });
  notify();
}

/**
 * Like setConfigValue, but resolves only after the backend PATCH has
 * landed (true) or failed (false). Use before actions that immediately
 * restart the backend — a fire-and-forget PATCH would race the restart
 * and the write could be lost.
 */
export async function setConfigValueFlushed<T>(key: string, value: T): Promise<boolean> {
  cache[key] = value;
  writeMirror();
  notify();
  try {
    const res = await fetch(apiUrl("/api/user-config"), {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[userConfig] Failed to persist "${key}":`, err);
    return false;
  }
}

/**
 * React hook mirroring `useState` semantics but backed by the persisted
 * config file. Re-renders when other components update the same key.
 */
export function useConfigValue<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => getConfigValue(key, defaultValue));
  useEffect(() => {
    const sync = () => setVal(getConfigValue(key, defaultValue));
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, [key, defaultValue]);
  const set = useCallback((v: T) => setConfigValue(key, v), [key]);
  return [val, set];
}
