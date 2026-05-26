import { useEffect, useState } from "react";
import type { PluginManifest } from "@loadout/types";

export interface PluginInfo extends PluginManifest {
  hasApp: boolean;
}

const DEFAULT_PORT = 33820;

export interface UsePluginsOptions {
  port?: number;
}

export function usePlugins(opts: UsePluginsOptions = {}): {
  plugins: PluginInfo[];
  loading: boolean;
  error: string | null;
} {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const port = opts.port ?? DEFAULT_PORT;
    const token = window.__LOADOUT_TOKEN__ ?? "";
    const url = `http://127.0.0.1:${port}/api/plugins`;
    fetch(url, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        setPlugins(data.plugins ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [opts.port]);

  return { plugins, loading, error };
}
