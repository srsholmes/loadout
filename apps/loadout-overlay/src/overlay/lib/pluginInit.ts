/**
 * Plugin startup initialization.
 *
 * Plugins that need to apply persistent settings before their UI is opened
 * (e.g. sound-loader installing sound overrides) can opt in by setting
 * `"loadOnStartup": true` in their `package.json`'s `plugin` field, and
 * exporting an `init(api)` function from their `app.tsx`.
 *
 * The shell calls each opted-in plugin's `init(api)` once after the
 * backend WebSocket is connected. The api gives the plugin scoped access
 * to its own backend (call methods, subscribe to events). Init usually
 * runs for the lifetime of the app — the unsubscribe return is rarely
 * needed but supported for symmetry.
 */
import type { PluginInfo } from "../hooks/usePlugins";
import { authHeaders, apiUrl, importPluginBundle } from "./backend";
import { call as wsCall, subscribe } from "@loadout/ui/ws-client";

export interface PluginInitAPI {
  /** Call a method on this plugin's backend. */
  call(method: string, ...args: unknown[]): Promise<unknown>;
  /** Subscribe to an event from this plugin's backend. Returns unsubscribe. */
  subscribe(event: string, handler: (data: unknown) => void): () => void;
}

interface PluginInitModule {
  init?: (api: PluginInitAPI) => void | Promise<void> | (() => void);
}

function makeApi(pluginId: string): PluginInitAPI {
  return {
    call: (method, ...args) => wsCall({ plugin: pluginId, method, args }),
    subscribe: (event, handler) =>
      subscribe({ plugin: pluginId, event, handler }),
  };
}

/**
 * Fetch the plugin list and run init() for every plugin that opted in
 * via `loadOnStartup: true`. Errors are logged but don't block other
 * plugins.
 */
export async function runStartupInits(): Promise<void> {
  let plugins: PluginInfo[];
  try {
    const res = await fetch(apiUrl("/api/plugins"), { headers: authHeaders() });
    if (!res.ok) {
      console.warn(`[pluginInit] /api/plugins HTTP ${res.status}`);
      return;
    }
    plugins = (await res.json()) as PluginInfo[];
  } catch (err) {
    console.warn("[pluginInit] Failed to fetch plugin list:", err);
    return;
  }

  const startupPlugins = plugins.filter((p) => p.loadOnStartup);
  if (startupPlugins.length === 0) return;

  console.log(
    `[pluginInit] Running init() for ${startupPlugins.length} startup plugin(s):`,
    startupPlugins.map((p) => p.id).join(", "),
  );

  // Run inits in parallel — they're independent and we don't want one slow
  // plugin to block the others.
  await Promise.all(
    startupPlugins.map(async (plugin) => {
      try {
        const mod = (await importPluginBundle(plugin.id)) as PluginInitModule;
        if (typeof mod.init !== "function") {
          console.log(
            `[pluginInit] ${plugin.id} is loadOnStartup but exports no init() — skipping`,
          );
          return;
        }
        await mod.init(makeApi(plugin.id));
        console.log(`[pluginInit] init() complete for ${plugin.id}`);
      } catch (err) {
        console.error(`[pluginInit] init() failed for ${plugin.id}:`, err);
      }
    }),
  );
}
