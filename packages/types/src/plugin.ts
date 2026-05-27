/**
 * The `__core:` event namespace.
 *
 * Loader-owned services broadcast on plugin IDs of the form
 * `__core:<service-name>` so plugins can subscribe to them through the
 * normal RPC `event` channel without needing a bespoke hook. The leading
 * `__` is reserved — plugin manifests whose `id` starts with `__` are
 * rejected by the loader to keep this namespace clean.
 *
 * Known services (each owns its own message schema; see the service
 * source for the payload shape):
 *
 * - `__core:game-detection` — emits `gameChanged` with `{ currentGame,
 *   recentSessions }` whenever the active Steam app changes. Owner:
 *   `packages/loader/src/services/game-detection.ts`. Consumers should
 *   prefer subscribing here over polling Steam's CDP URL bar.
 * - `__system` — diagnostic broadcasts from the loader itself
 *   (e.g. `inject-failed` when the injector retry ladder gives up).
 *
 * New core services should follow `__core:<kebab>` naming and be
 * documented here.
 */
export interface PluginPermissions {
  network?: string[];
  filesystem?: string[];
  steam_apis?: string[];
  system?: string[];
}

export interface PluginPatchReplacement {
  /** String or regex pattern to match in the module source */
  match: string;
  /** Replacement string. $self references the plugin module, $1/$2 for capture groups */
  replace: string;
}

export interface PluginPatch {
  /** Find the webpack module. String = source must contain it. Array = all must match. */
  find: string | string[];
  /** Replacements to apply to the matched module source */
  replacement: PluginPatchReplacement | PluginPatchReplacement[];
  /** If true, patch is optional — won't error if the module isn't found */
  optional?: boolean;
}

export interface PluginTarget {
  /** Where the plugin renders */
  type: "qam" | "panel" | "overlay" | "css" | "menu";
  /** Which named export from panel.tsx to render. Defaults to "default" || "Panel" */
  export?: string;
  /** Display name in the QAM tab bar (required for type: "qam") */
  title?: string;
  /** Where to insert in the QAM tab bar. Default: append to end */
  position?: number | string;
  /** Positioning for overlay-type plugins */
  overlayPosition?: { top?: string; bottom?: string; left?: string; right?: string };
  /** Size for overlay-type plugins */
  overlaySize?: { width?: string; height?: string };
  /** If true, overlay has no background (for HUD-style widgets) */
  transparent?: boolean;
  /**
   * Route path for `type: "menu"` entries. The injector navigates here
   * when the user activates the menu item. Falls back to the first key
   * of `PluginMeta.routes` if omitted.
   */
  route?: string;
  /** Optional icon (emoji / image URL) shown beside the menu label for `type: "menu"`. */
  icon?: string;
}

export interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions?: PluginPermissions;
  /** Rendering target(s). If omitted, defaults to overlay panel behavior. Array for multi-target plugins. */
  target?: PluginTarget | PluginTarget[];
  /** Map of route path → named export from panel.tsx. Paths must be prefixed with /loadout/{pluginId}/ */
  routes?: Record<string, string>;
  /** Webpack module patches — modify Steam's components before they render (Vencord-style) */
  patches?: PluginPatch[];
  /** CSS files to inject (for type: "css" plugins). Map of filename → target context */
  styles?: Record<string, "SharedJSContext" | "QuickAccess" | "BigPictureMode">;
  /**
   * If true, the overlay shell will import this plugin's app bundle at
   * startup and call its exported `init(api)` function (if any) — even
   * before the user opens the plugin's UI. Used for plugins that need to
   * apply persistent settings (e.g. sound-loader installing sound
   * overrides). Defaults to false.
   */
  loadOnStartup?: boolean;
}

export interface EmitPayload {
  event: string;
  data: unknown;
}

/**
 * Minimal logger contract the loader injects onto every backend instance
 * as `instance.log` right after construction. Plugins can call
 * `this.log?.info(...)` without importing the loader. Mirrors the
 * `Logger` interface in `packages/loader/src/logger.ts`.
 */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface PluginBackend {
  onLoad?(): Promise<void> | void;
  onUnload?(): Promise<void> | void;
  emit?(payload: EmitPayload): void;
  /**
   * Scoped logger injected by the loader after instantiation. Backends
   * may declare this field locally to use it without a cast, e.g.
   * `log?: PluginLogger`. Optional because plugins that don't log
   * never need to reference it.
   */
  log?: PluginLogger;
}

export interface ResolveMethodArgs {
  instance: PluginBackend;
  name: string;
}

/** Methods that must not be callable via RPC. */
const BLOCKED_METHODS = new Set([
  "onLoad",
  "onUnload",
  "emit",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
]);

/**
 * Look up a method on a plugin instance by name.
 * Returns the bound function or undefined if it doesn't exist.
 * Blocks lifecycle methods and Object.prototype methods from RPC dispatch.
 */
export function resolveMethod({
  instance,
  name,
}: ResolveMethodArgs): ((...args: unknown[]) => unknown) | undefined {
  if (BLOCKED_METHODS.has(name)) return undefined;
  if (name.startsWith("_")) return undefined; // Convention: underscore = private

  const fn = (instance as Record<string, unknown>)[name];
  if (typeof fn !== "function") return undefined;
  return fn.bind(instance) as (...args: unknown[]) => unknown;
}
