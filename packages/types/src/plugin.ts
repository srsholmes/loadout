export interface PluginTarget {
  type: "panel" | "overlay";
  /** Named export from app.tsx to render. Defaults to "default". */
  export?: string;
  /** Display name in the overlay nav. */
  title?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  target?: PluginTarget;
  /** Capability gates from @loadout/device. Plugin is hidden when any required cap is false. */
  requires?: Array<"hasRGB" | "hasFanControl" | "hasTDP" | "hasBatteryControl">;
  /** If true, the overlay imports this plugin's bundle at startup and calls its `init(api)` export. */
  loadOnStartup?: boolean;
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface EmitPayload {
  event: string;
  data: unknown;
}

export interface PluginBackend {
  onLoad?(): Promise<void> | void;
  onUnload?(): Promise<void> | void;
  emit?(payload: EmitPayload): void;
  log?: PluginLogger;
}

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

export function resolveMethod(
  instance: PluginBackend,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (BLOCKED_METHODS.has(name)) return undefined;
  if (name.startsWith("_")) return undefined;
  const fn = (instance as Record<string, unknown>)[name];
  if (typeof fn !== "function") return undefined;
  return fn.bind(instance) as (...args: unknown[]) => unknown;
}
