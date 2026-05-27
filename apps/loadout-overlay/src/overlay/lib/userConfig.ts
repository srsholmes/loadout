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
 *
 * Migration: on first boot with an empty backend config, any legacy
 * `localStorage` keys we recognize get folded in and pushed up so
 * users don't lose existing favorites/theme/etc.
 */

import { useCallback, useEffect, useState } from "react";
import { authHeaders, apiUrl } from "./backend";

type Config = Record<string, unknown>;

const CHANGE_EVENT = "loadout:user-config-changed";
const MIRROR_KEY = "loadout:user-config-mirror";

// localStorage key → config key. Used once for migration so users don't
// lose settings from before the file-backed config existed.
const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  "loadout-favorite-plugins": "favoritePlugins",
  "loadout-sidebar-auto-collapse": "sidebarAutoCollapse",
  "loadout-theme": "theme",
  "loadout-startup-view": "startupView",
  "loadout-ui-scale-v2": "uiScale",
  "loadout-last-route": "lastRoute",
  "loadout-home-widgets": "homeWidgets",
  "loadout-home-layout": "homeLayout",
  "loadout-controller-shortcuts": "controllerShortcuts",
  "loadout-sfx-volume": "sfxVolume",
  "loadout-sfx-enabled": "sfxEnabled",
};

let cache: Config = readMirror();
let loaded = false;

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

function parseLegacy(raw: string): unknown {
  // Values like "1"/"0", JSON arrays, or bare strings. Best-effort parse.
  try { return JSON.parse(raw); } catch {}
  if (raw === "1") return true;
  if (raw === "0") return false;
  return raw;
}

function collectLegacyMigration(): Config {
  const migrated: Config = {};
  for (const [lsKey, cfgKey] of Object.entries(LEGACY_LOCALSTORAGE_KEYS)) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw === null) continue;
      migrated[cfgKey] = parseLegacy(raw);
    } catch {}
  }
  return migrated;
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

    // First-run migration: if the backend config is empty but the
    // browser has legacy localStorage values, push those up.
    if (Object.keys(remote).length === 0) {
      const legacy = collectLegacyMigration();
      if (Object.keys(legacy).length > 0) {
        cache = { ...cache, ...legacy };
        writeMirror();
        // Persist the migrated values. Non-blocking — if it fails the
        // user keeps their state in the local mirror for this session.
        fetch(apiUrl("/api/user-config"), {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(legacy),
        }).catch(() => {});
      }
    } else {
      // Backend is authoritative on reload.
      cache = { ...cache, ...remote };
      writeMirror();
    }
    loaded = true;
    notify();
  } catch (err) {
    console.warn("[userConfig] Failed to load from backend:", err);
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
