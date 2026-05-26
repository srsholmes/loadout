import { useEffect, useRef, useState } from "react";
import { Spinner } from "@loadout/ui";
import type { PluginInfo } from "./usePlugins";

const DEFAULT_PORT = 33820;

interface PluginModule {
  default?: PluginMountFn | React.ComponentType;
  mount?: PluginMountFn;
}

type PluginMountFn = (
  container: HTMLElement,
  opts: { parentFocusKey?: string },
) => (() => void) | void;

async function importPluginBundle(pluginId: string, port = DEFAULT_PORT): Promise<PluginModule> {
  const token = window.__LOADOUT_TOKEN__ ?? "";
  const url = `http://127.0.0.1:${port}/plugins/${pluginId}/app-bundle.js?token=${encodeURIComponent(token)}`;
  return (await import(/* @vite-ignore */ url)) as PluginModule;
}

/**
 * Mounts a plugin's app bundle inside its own React root. The plugin owns
 * its mount/unmount lifecycle; the shell only provides the container and
 * a parentFocusKey hint for spatial nav.
 */
export function PluginHost({ plugin }: { plugin: PluginInfo }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    (async () => {
      try {
        const mod = await importPluginBundle(plugin.id);
        if (cancelled) return;
        const mount = mod.mount ?? (mod.default as PluginMountFn | undefined);
        if (typeof mount !== "function") {
          throw new Error(`Plugin "${plugin.id}" does not export a mount function`);
        }
        const result = mount(container, { parentFocusKey: "content" });
        unmountRef.current = typeof result === "function" ? result : null;
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (unmountRef.current) {
        try {
          unmountRef.current();
        } catch {}
        unmountRef.current = null;
      }
    };
  }, [plugin.id]);

  if (error) {
    return (
      <div className="p-6">
        <h3 className="text-error font-semibold mb-2">Plugin failed to load</h3>
        <p className="text-sm text-base-content/70 break-words">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full">
      {loading && (
        <div className="flex flex-col items-center justify-center h-full gap-3">
          <Spinner />
          <p className="text-sm text-base-content/60">Loading {plugin.name}…</p>
        </div>
      )}
      <div ref={containerRef} className={loading ? "h-0 overflow-hidden" : "h-full"} />
    </div>
  );
}
