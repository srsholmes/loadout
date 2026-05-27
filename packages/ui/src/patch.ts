/**
 * Runtime patching utilities for plugins that need to modify Steam's
 * objects and methods dynamically (post-load).
 *
 * For pre-load modifications, use `patches` in plugin.json instead.
 * These utilities are for cases where you need to patch at runtime,
 * e.g., patching SteamClient methods or discovered component instances.
 *
 * All patch functions return an unpatch function for cleanup.
 */

type PatchHandler<T> = (result: T, thisArg: unknown, args: unknown[]) => T | void;
type BeforePatchHandler = (thisArg: unknown, args: unknown[]) => unknown[] | void;
type InsteadPatchHandler = (
  original: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[],
) => unknown;

interface PatchedFunction {
  __loadoutOriginal?: (...args: unknown[]) => unknown;
  __loadoutPatches?: Array<{ type: string; handler: unknown }>;
}

/**
 * Patch a method to run a handler AFTER the original function.
 * The handler receives the original return value and can optionally
 * return a modified value.
 *
 * @example
 * ```ts
 * const unpatch = afterPatch(SteamClient.Apps, "GetAllApps", (result) => {
 *   // Modify the app list before it's returned
 *   return result.filter(app => app.name !== "Hidden Game");
 * });
 * ```
 */
export function afterPatch<T = unknown>(
  obj: Record<string, unknown>,
  method: string,
  handler: PatchHandler<T>,
): () => void {
  const original = obj[method];
  if (typeof original !== "function") {
    console.warn(`[loadout:patch] afterPatch: ${method} is not a function`);
    return () => {};
  }

  const patched = function (this: unknown, ...args: unknown[]) {
    const result = (original as (...a: unknown[]) => T).apply(this, args);
    try {
      const modified = handler(result, this, args);
      if (modified !== undefined) return modified;
    } catch (e) {
      console.error("[loadout:patch] afterPatch handler error:", e);
    }
    return result;
  } as unknown as PatchedFunction;

  patched.__loadoutOriginal = original as (...args: unknown[]) => unknown;
  obj[method] = patched;

  return function unpatch() {
    if (obj[method] === patched) {
      obj[method] = original;
    }
  };
}

/**
 * Patch a method to run a handler BEFORE the original function.
 * The handler can modify the arguments passed to the original.
 *
 * @example
 * ```ts
 * const unpatch = beforePatch(SteamClient.System, "OpenInBrowser", (_this, args) => {
 *   console.log("Opening URL:", args[0]);
 *   // Optionally return modified args
 * });
 * ```
 */
export function beforePatch(
  obj: Record<string, unknown>,
  method: string,
  handler: BeforePatchHandler,
): () => void {
  const original = obj[method];
  if (typeof original !== "function") {
    console.warn(`[loadout:patch] beforePatch: ${method} is not a function`);
    return () => {};
  }

  const patched = function (this: unknown, ...args: unknown[]) {
    try {
      const modifiedArgs = handler(this, args);
      if (Array.isArray(modifiedArgs)) {
        return (original as (...a: unknown[]) => unknown).apply(this, modifiedArgs);
      }
    } catch (e) {
      console.error("[loadout:patch] beforePatch handler error:", e);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as PatchedFunction;

  patched.__loadoutOriginal = original as (...args: unknown[]) => unknown;
  obj[method] = patched;

  return function unpatch() {
    if (obj[method] === patched) {
      obj[method] = original;
    }
  };
}

/**
 * Replace a method entirely with a custom implementation.
 * The handler receives the original function so it can call it if needed.
 *
 * @example
 * ```ts
 * const unpatch = insteadPatch(SteamClient.Apps, "RunGame", (original, _this, args) => {
 *   if (args[0] === blockedAppId) {
 *     console.log("Blocked!");
 *     return;
 *   }
 *   return original.apply(_this, args);
 * });
 * ```
 */
export function insteadPatch(
  obj: Record<string, unknown>,
  method: string,
  handler: InsteadPatchHandler,
): () => void {
  const original = obj[method];
  if (typeof original !== "function") {
    console.warn(`[loadout:patch] insteadPatch: ${method} is not a function`);
    return () => {};
  }

  const boundOriginal = (original as (...args: unknown[]) => unknown).bind(obj);
  const patched = function (this: unknown, ...args: unknown[]) {
    try {
      return handler(boundOriginal, this, args);
    } catch (e) {
      console.error("[loadout:patch] insteadPatch handler error:", e);
      return boundOriginal(...args);
    }
  } as unknown as PatchedFunction;

  patched.__loadoutOriginal = original as (...args: unknown[]) => unknown;
  obj[method] = patched;

  return function unpatch() {
    if (obj[method] === patched) {
      obj[method] = original;
    }
  };
}

/**
 * Find a React component's fiber node from a DOM element.
 * Useful for inspecting component props/state at runtime.
 */
export function getReactFiber(element: HTMLElement): unknown | null {
  const keys = Object.keys(element);
  for (const key of keys) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (element as unknown as Record<string, unknown>)[key];
    }
  }
  return null;
}

/**
 * Walk the React fiber tree from a starting fiber node,
 * finding the first node that matches the predicate.
 */
export function findInFiberTree(
  fiber: unknown,
  predicate: (fiber: unknown) => boolean,
  maxDepth = 100,
): unknown | null {
  type FiberNode = { child?: FiberNode; sibling?: FiberNode };
  const queue: Array<{ fiber: FiberNode; depth: number }> = [
    { fiber: fiber as FiberNode, depth: 0 },
  ];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) continue;
    try {
      if (predicate(item.fiber)) return item.fiber;
    } catch {
      // predicate threw, skip this node
    }
    if (item.fiber.child) queue.push({ fiber: item.fiber.child, depth: item.depth + 1 });
    if (item.fiber.sibling) queue.push({ fiber: item.fiber.sibling, depth: item.depth + 1 });
  }

  return null;
}
