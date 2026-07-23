import { useState, useEffect, useCallback } from "react";
import { authHeaders, apiUrl } from "../lib/backend";
import { onConnect, subscribe } from "@loadout/ui/ws-client";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon?: string;
  /**
   * Short human-readable subtitle shown under the plugin's page title.
   * Plugins can set this in their `package.json → plugin.subtitle` to
   * replace the default ("OneXPlayer APEX · CPU/GPU power limits",
   * "Detected: oxp_ec driver", etc.) that the topbar would otherwise
   * compose from `description`.
   */
  subtitle?: string;
  /**
   * Sidebar grouping — plugins with the same category end up in the same
   * section. Categories are derived at runtime in first-seen order from
   * the plugin list, so re-ordering this field moves a plugin's group.
   */
  category?: string;
  /** If true, the shell pre-loads this plugin's bundle and calls init() at startup. */
  loadOnStartup?: boolean;
  /**
   * If true, the plugin's React tree and DOM stays mounted after the
   * user switches to another plugin — hidden with `display: none` rather
   * than unmounted — so in-plugin state (open browser tabs, scroll
   * position, nested webview sessions, etc.) survives navigation.
   */
  keepAlive?: boolean;
  /**
   * Backend load status, present only on the `?installed=1` listing.
   * `disabled` plugins were never imported by the loader; `loaded` ones
   * are running (a loaded plugin the user just disabled keeps running
   * until the app restarts — that's the "restart required" state).
   */
  status?: "loaded" | "disabled" | "error";
}

function usePluginList(path: string) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlugins = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(apiUrl(path), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PluginInfo[] = await res.json();
      setPlugins(data);
      setLoading(false);
      return true;
    } catch (err) {
      console.error("[overlay] Failed to fetch plugins:", err);
      return false;
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    async function fetchWithRetry(attempt = 0) {
      if (cancelled) return;
      const ok = await fetchPlugins();
      if (!ok && !cancelled) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        retryTimer = setTimeout(() => fetchWithRetry(attempt + 1), delay);
      }
    }

    fetchWithRetry();

    // Re-fetch whenever the WebSocket (re)connects — server is up
    const unsub = onConnect(() => {
      if (!cancelled) fetchPlugins();
    });

    // Re-fetch when the loader loads a plugin at runtime (a disabled
    // plugin the user just re-enabled) so it appears without a restart.
    const unsubChanged = subscribe({
      plugin: "__system",
      event: "plugins-changed",
      handler: () => {
        if (!cancelled) fetchPlugins();
      },
    });

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      unsub();
      unsubChanged();
    };
  }, [fetchPlugins]);

  return { plugins, loading };
}

/**
 * Fetches the list of loaded plugins with a UI from the Bun server.
 * Retries with backoff if the server isn't ready yet, and re-fetches
 * whenever the WebSocket (re)connects or the plugin set changes.
 */
export function usePlugins() {
  return usePluginList("/api/plugins");
}

/**
 * Every plugin installed on disk — including disabled ones, which the
 * loader never imported — each tagged with `status`. This is the list
 * Settings and the welcome wizard use, so disabled plugins stay visible
 * and re-enableable there.
 */
export function useInstalledPlugins() {
  return usePluginList("/api/plugins?installed=1");
}
