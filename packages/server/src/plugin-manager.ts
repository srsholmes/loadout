import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest, PluginBackend, RpcEvent } from "@loadout/types";
import { bundleBackend } from "./bundler";
import { createPluginLogger, log } from "./logger";

export interface LoadedPlugin {
  manifest: PluginManifest;
  instance: PluginBackend;
  hasApp: boolean;
  dir: string;
}

export interface LoadPluginsArgs {
  pluginsDir: string;
  broadcast: (msg: RpcEvent) => void;
}

/**
 * Plugin id charset. Constrained so the id is safe in URL paths, log lines,
 * filesystem cache dirs, and JSON keys — no traversal, no shell-interesting
 * chars. Reject leading dash so `--foo`-style switches can't be smuggled.
 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function readManifest(pluginDir: string): Promise<PluginManifest | undefined> {
  const pluginJson = Bun.file(join(pluginDir, "plugin.json"));
  if (await pluginJson.exists()) {
    return (await pluginJson.json()) as PluginManifest;
  }
  const pkgJson = Bun.file(join(pluginDir, "package.json"));
  if (await pkgJson.exists()) {
    const pkg = await pkgJson.json();
    if (!pkg.plugin) return undefined;
    return {
      id: pkg.plugin.id ?? pkg.name,
      name: pkg.plugin.name ?? pkg.name,
      version: pkg.version ?? "0.0.0",
      description: pkg.plugin.description ?? pkg.description,
      author: pkg.plugin.author ?? pkg.author,
      ...pkg.plugin,
    } as PluginManifest;
  }
  return undefined;
}

export async function loadPlugins({
  pluginsDir,
  broadcast,
}: LoadPluginsArgs): Promise<Map<string, LoadedPlugin>> {
  const loaded = new Map<string, LoadedPlugin>();

  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    log.warn(`Plugins directory not found: ${pluginsDir}`);
    return loaded;
  }

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);
    let manifest: PluginManifest | undefined;
    try {
      manifest = await readManifest(pluginDir);
    } catch (err) {
      log.warn(`Skipping ${entry}: failed to read manifest (${err})`);
      continue;
    }
    if (!manifest) {
      log.debug(`Skipping ${entry}: no plugin.json or package.json with plugin field`);
      continue;
    }
    if (!PLUGIN_ID_RE.test(manifest.id)) {
      log.warn(
        `Skipping ${entry}: plugin id ${JSON.stringify(manifest.id)} does not match ${PLUGIN_ID_RE}`,
      );
      continue;
    }

    const backendPath = join(pluginDir, "backend.ts");
    const hasBackend = await Bun.file(backendPath).exists();
    let instance: PluginBackend = {};

    if (hasBackend) {
      try {
        const bundlePath = await bundleBackend(pluginDir, backendPath, manifest.id);
        const mod = await import(bundlePath);
        const BackendClass = mod.default;
        instance = new BackendClass();
      } catch (err) {
        log.error(`Failed to load backend for ${manifest.id}: ${err}`);
        continue;
      }
      instance.emit = ({ event, data }) =>
        broadcast({ type: "event", plugin: manifest!.id, event, data });
      instance.log = createPluginLogger(manifest.id);
      try {
        await instance.onLoad?.();
      } catch (err) {
        log.error(`onLoad failed for ${manifest.id}: ${err}`);
      }
    }

    const appPath = join(pluginDir, "app.tsx");
    const hasApp = await Bun.file(appPath).exists();

    loaded.set(manifest.id, { manifest, instance, hasApp, dir: pluginDir });
    log.info(
      `Loaded plugin: ${manifest.name} (${manifest.id}) [backend=${hasBackend}, app=${hasApp}]`,
    );
  }

  return loaded;
}
