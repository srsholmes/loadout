import { useState, useEffect, useCallback } from "react";
import { authHeaders, apiUrl } from "../lib/backend";
import { onConnect } from "@loadout/ui/ws-client";

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
}

/**
 * Fetches the list of installed plugins from the Bun server.
 * Retries with backoff if the server isn't ready yet, and
 * re-fetches whenever the WebSocket (re)connects.
 */
export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlugins = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(apiUrl("/api/plugins"), {
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
  }, []);

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

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      unsub();
    };
  }, [fetchPlugins]);

  return { plugins, loading };
}
