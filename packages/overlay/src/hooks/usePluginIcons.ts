import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import type { PluginInfo } from "./usePlugins";
import { importPluginBundle } from "../lib/backend";

/** Icons from react-icons and similar libraries accept SVG props. */
export type PluginIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Lazily loads each plugin's `icon` export (a React component) so the
 * sidebar can render a plugin-provided icon instead of just the first
 * letter of the plugin name.
 *
 * We import each plugin's app bundle in parallel and read the `icon`
 * named export. Plugins that don't export an icon fall back to the
 * letter at the render site. Results are cached in module-scope so
 * re-mounts don't re-fetch.
 *
 * Why loading full app bundles (not a separate icon bundle): plugins
 * are already bundled once on demand, and module top-level code in
 * practice only defines components — nothing mounts until the shell
 * calls `mount()`. The extra bytes are paid once on sidebar mount in
 * parallel, which is acceptable for the UX win.
 */

const iconCache = new Map<string, PluginIconComponent | null>();
const inFlight = new Map<string, Promise<PluginIconComponent | null>>();

async function loadIcon(pluginId: string): Promise<PluginIconComponent | null> {
  if (iconCache.has(pluginId)) return iconCache.get(pluginId)!;
  const existing = inFlight.get(pluginId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const mod = (await importPluginBundle(pluginId)) as {
        icon?: PluginIconComponent;
      };
      const icon = typeof mod.icon === "function" ? mod.icon : null;
      iconCache.set(pluginId, icon);
      return icon;
    } catch (err) {
      console.warn(`[usePluginIcons] Failed to load icon for ${pluginId}:`, err);
      iconCache.set(pluginId, null);
      return null;
    } finally {
      inFlight.delete(pluginId);
    }
  })();
  inFlight.set(pluginId, promise);
  return promise;
}

export function usePluginIcons(plugins: PluginInfo[]): Record<string, PluginIconComponent | null> {
  const [icons, setIcons] = useState<Record<string, PluginIconComponent | null>>(() => {
    const initial: Record<string, PluginIconComponent | null> = {};
    for (const p of plugins) {
      if (iconCache.has(p.id)) initial[p.id] = iconCache.get(p.id)!;
    }
    return initial;
  });

  useEffect(() => {
    let cancelled = false;
    for (const plugin of plugins) {
      if (iconCache.has(plugin.id)) continue;
      loadIcon(plugin.id).then((icon) => {
        if (cancelled) return;
        setIcons((prev) => ({ ...prev, [plugin.id]: icon }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [plugins]);

  return icons;
}
