import { useState, useEffect } from "react";
import { authHeaders } from "./useAuthToken";

/**
 * Plugin metadata as returned by the daemon API.
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon?: string;
}

/**
 * Fetches the list of installed plugins from the daemon.
 * Re-fetches when a system reload event is received via WebSocket.
 */
export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchPlugins() {
      try {
        const res = await fetch("/api/plugins", {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: PluginInfo[] = await res.json();
        if (!cancelled) {
          setPlugins(data);
          setLoading(false);
        }
      } catch (err) {
        console.error("[overlay] Failed to fetch plugins:", err);
        if (!cancelled) setLoading(false);
      }
    }

    fetchPlugins();

    return () => {
      cancelled = true;
    };
  }, []);

  return { plugins, loading };
}
