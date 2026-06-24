import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginMeta, PluginBackend, RpcEvent } from "@loadout/types";
import { resolveMethod } from "@loadout/types";
import { withCommandPolicy, type CommandPolicy } from "@loadout/exec";
import { createSandboxedFetch } from "./sandboxed-fetch";
import { log, createPluginLogger } from "./logger";
import { chownToTarget } from "./target-user";

export interface LoadedPlugin {
  meta: PluginMeta;
  instance: PluginBackend;
  sandboxedFetch: typeof globalThis.fetch;
  /**
   * Per-plugin command capability gate, enforced at the `@loadout/exec`
   * choke point. Built from `meta.permissions.commands` (deny-by-default).
   * The rpc-handler scopes this around every RPC call, the same way
   * `sandboxedFetch` scopes network access. Omitted for trusted core
   * (`__core:*`) services, which run unrestricted.
   */
  commandPolicy?: CommandPolicy;
  hasApp: boolean;
}

export interface LoadPluginsArgs {
  pluginsDir: string;
  broadcast: (msg: RpcEvent) => void;
}

// AsyncLocalStorage for per-request fetch scoping (safe with concurrent requests)
const fetchStorage = new AsyncLocalStorage<typeof globalThis.fetch>();

// Capture the real fetch once, then install our proxy
const realFetch = globalThis.fetch;

// Replace globalThis.fetch with a proxy that checks AsyncLocalStorage first
const proxyFetch = function proxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const scopedFetch = fetchStorage.getStore();
  if (scopedFetch) {
    return scopedFetch(input, init);
  }
  return realFetch(input, init);
};
proxyFetch.preconnect = realFetch.preconnect;
globalThis.fetch = proxyFetch as typeof globalThis.fetch;

/**
 * Run a function with the given sandboxed fetch scoped via AsyncLocalStorage.
 * Safe for concurrent use — each async context gets its own fetch.
 */
export function withSandboxedFetch<T>(
  sandboxedFetch: typeof globalThis.fetch,
  fn: () => T | Promise<T>,
): Promise<T> {
  return fetchStorage.run(sandboxedFetch, async () => fn());
}

/**
 * In-process cross-plugin dispatch. Resolves `method` on the target
 * plugin's backend and invokes it inside the target's command policy +
 * sandboxed fetch — the same dual scope the WebSocket rpc-handler uses —
 * so the caller borrows none of its own capabilities. Throws (rejects)
 * when the target plugin isn't loaded or the method isn't callable, so
 * callers can fall back. Backing impl for the injected `callPlugin`.
 */
export async function callPluginMethod(
  plugins: Map<string, LoadedPlugin>,
  targetId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const entry = plugins.get(targetId);
  if (!entry) throw new Error(`Plugin "${targetId}" is not loaded`);

  const fn = resolveMethod({ instance: entry.instance, name: method });
  if (!fn) {
    throw new Error(`Method "${method}" not found on plugin "${targetId}"`);
  }

  const inner = () => withSandboxedFetch(entry.sandboxedFetch, () => fn(...args));
  return entry.commandPolicy
    ? withCommandPolicy(entry.commandPolicy, inner)
    : inner();
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
  log.info(`Found ${entries.length} entries in plugins directory`);

  for (const entry of entries) {
    const pluginDir = join(pluginsDir, entry);

    // Read plugin metadata from plugin.json or package.json "plugin" field
    let meta: PluginMeta;
    try {
      const pluginJsonPath = join(pluginDir, "plugin.json");
      const pkgJsonPath = join(pluginDir, "package.json");

      if (await Bun.file(pluginJsonPath).exists()) {
        meta = (await Bun.file(pluginJsonPath).json()) as PluginMeta;
      } else if (await Bun.file(pkgJsonPath).exists()) {
        const pkg = await Bun.file(pkgJsonPath).json();
        if (!pkg.plugin) {
          log.debug(`Skipping ${entry}: package.json has no "plugin" field`);
          continue;
        }
        meta = {
          id: pkg.plugin.id ?? entry,
          name: pkg.plugin.name ?? pkg.name ?? entry,
          version: pkg.version ?? "0.0.0",
          description: pkg.plugin.description ?? pkg.description ?? "",
          author: pkg.plugin.author ?? pkg.author ?? "",
          ...pkg.plugin,
          // Permissions live at the top level of package.json (sibling
          // of "plugin"), so the spread above doesn't capture them.
          // Without this, package.json-style plugins always run with
          // empty permissions and every sandboxedFetch gets blocked —
          // which is what bit the now-retired gaming-mode-browser
          // plugin when it tried to reach Steam's CEF debug port.
          permissions: pkg.plugin.permissions ?? pkg.permissions,
        } as PluginMeta;
      } else {
        log.debug(`Skipping ${entry}: no plugin.json or package.json`);
        continue;
      }
    } catch {
      log.warn(`Skipping ${entry}: failed to read manifest`);
      continue;
    }

    log.info(`Loading plugin: ${meta.name} (${meta.id}) v${meta.version}`);

    // Create sandboxed fetch for this plugin based on its permissions
    const sandboxedFetch = createSandboxedFetch(meta.id, meta.permissions);

    // Create a scoped logger for this plugin and patch console for its context
    const pluginLog = createPluginLogger(meta.id);

    // Build the per-plugin command policy. Every subprocess the plugin
    // launches through @loadout/exec is checked against this (deny-by-
    // default) and logged via the plugin's own logger for an audit trail.
    const commandPolicy: CommandPolicy = {
      pluginId: meta.id,
      allowed: meta.permissions?.commands ?? [],
      log: (m) => pluginLog.info(m),
    };

    // Bundle and load backend (optional — CEF-only plugins may not have one).
    // Compiled Bun binaries can't resolve node_modules from dynamically
    // imported files. Bun.build() resolves all imports at bundle time,
    // producing a self-contained .js file that import() can load.
    const backendPath = join(pluginDir, "backend.ts");
    let instance: PluginBackend = {} as PluginBackend;
    const hasBackend = await Bun.file(backendPath).exists();

    if (hasBackend) {
      try {
        const bundlePath = await bundleBackend(pluginDir, backendPath, meta.id);
        const mod = await import(bundlePath);
        const BackendClass = mod.default;
        instance = new BackendClass();
        log.debug(`Backend class instantiated for ${meta.id}`);
      } catch (err) {
        log.error(`Failed to load backend for ${meta.id}: ${err}`);
        continue;
      }

      // Inject emit and logger
      instance.emit = ({ event, data }) => {
        broadcast({ type: "event", plugin: meta.id, event, data });
      };
      instance.log = pluginLog;

      // Inject the cross-plugin call handle. Late-binds against `loaded`,
      // so a plugin can call one that's registered later in this loop. The
      // target method runs inside the *target's* command policy + sandboxed
      // fetch (not this plugin's), mirroring the rpc-handler's dispatch.
      instance.callPlugin = (targetId, method, ...args) =>
        callPluginMethod(loaded, targetId, method, args);

      // Call onLoad inside both gates: command policy (subprocess
      // capability) wrapping the sandboxed fetch (network capability).
      try {
        await withCommandPolicy(commandPolicy, () =>
          withSandboxedFetch(sandboxedFetch, () => instance.onLoad?.()),
        );
        log.info(`onLoad completed for ${meta.id}`);
      } catch (err) {
        log.error(`onLoad failed for ${meta.id}: ${err}`);
      }
    } else {
      log.info(`No backend.ts for ${meta.id} — loading as frontend-only plugin`);
    }

    // Check if plugin has an app.tsx frontend for the overlay
    const appPath = join(pluginDir, "app.tsx");
    const hasApp = await Bun.file(appPath).exists();

    // Frontend bundles are compiled on the fly when requested via HTTP
    loaded.set(meta.id, { meta, instance, sandboxedFetch, commandPolicy, hasApp });
    log.info(`Loaded plugin: ${meta.name} (${meta.id}) [backend=${hasBackend ? "yes" : "no"}, frontend=${hasApp ? "yes" : "no"}]`);
  }

  return loaded;
}

/**
 * Bundle a plugin's backend.ts into a self-contained .js file.
 * Compiled Bun binaries can't resolve node_modules from dynamically
 * imported .ts files. Bun.build() inlines all dependencies so the
 * resulting .js file has no external imports.
 */
async function bundleBackend(
  pluginDir: string,
  backendPath: string,
  pluginId: string,
): Promise<string> {
  const cacheDir = join(pluginDir, ".cache");
  const bundlePath = join(cacheDir, "backend.bundle.js");

  // Skip rebuild if bundle is newer than source and package.json
  const srcFile = Bun.file(backendPath);
  const pkgFile = Bun.file(join(pluginDir, "package.json"));
  const cachedFile = Bun.file(bundlePath);
  if (await cachedFile.exists()) {
    const cachedStat = cachedFile.lastModified;
    const srcStat = (await srcFile.exists()) ? srcFile.lastModified : 0;
    const pkgStat = (await pkgFile.exists()) ? pkgFile.lastModified : 0;
    if (cachedStat >= srcStat && cachedStat >= pkgStat) {
      return bundlePath;
    }
  }

  await mkdir(cacheDir, { recursive: true });
  // The root service writes this cache into the user's home. Chown it back
  // so a later user-run `prepare-plugins` (reinstall) can overwrite it —
  // otherwise the root-owned .cache dir is unwritable by the user.
  chownToTarget(cacheDir);

  const result = await Bun.build({
    entrypoints: [backendPath],
    target: "bun",
    format: "esm",
    minify: false,
    outdir: cacheDir,
    naming: "backend.bundle.js",
  });

  if (!result.success) {
    const logs = result.logs.map(String).join("\n");
    throw new Error(`Backend bundle failed for ${pluginId}:\n${logs}`);
  }

  chownToTarget(bundlePath);
  return bundlePath;
}
