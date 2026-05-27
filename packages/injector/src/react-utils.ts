/**
 * React Fiber utility functions — embedded as JS strings for CEF injection.
 *
 * These helpers walk React's internal fiber tree, which is how we locate
 * and patch Steam's QAM tabs and router components at runtime.
 */

/**
 * JS string: getReactRoot(element) — get the React fiber root from a DOM element.
 * Looks for the __reactFiber$* or __reactInternalInstance$* key.
 */
export const GET_REACT_ROOT = `
function getReactRoot(element) {
  if (!element) return null;
  var keys = Object.keys(element);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].startsWith("__reactFiber$") || keys[i].startsWith("__reactInternalInstance$")) {
      return element[keys[i]];
    }
    // React 18 createRoot uses __reactContainer$ — traverse to the fiber child
    if (keys[i].startsWith("__reactContainer$")) {
      var container = element[keys[i]];
      if (container && container.stateNode && container.stateNode.current) {
        return container.stateNode.current;
      }
      if (container && container.child) return container.child;
      return container;
    }
  }
  return null;
}
`.trim();

/**
 * JS string: findInReactTree(node, predicate) — walk the fiber tree
 * (child → sibling) to find the first node matching the predicate.
 * Returns the matching fiber node or null.
 */
export const FIND_IN_REACT_TREE = `
function findInReactTree(node, predicate, maxDepth) {
  if (!node) return null;
  if (!maxDepth) maxDepth = 100;
  var queue = [{ fiber: node, depth: 0 }];
  while (queue.length > 0) {
    var item = queue.shift();
    if (item.depth > maxDepth) continue;
    try {
      if (predicate(item.fiber)) return item.fiber;
    } catch (e) {}
    if (item.fiber.child) queue.push({ fiber: item.fiber.child, depth: item.depth + 1 });
    if (item.fiber.sibling) queue.push({ fiber: item.fiber.sibling, depth: item.depth + 1 });
  }
  return null;
}
`.trim();

/**
 * JS string: afterPatch(obj, method, handler) — monkey-patch a method.
 * `handler` receives (originalResult, thisArg, args) and can modify the return value.
 * Returns an unpatch function.
 */
export const AFTER_PATCH = `
function afterPatch(obj, method, handler) {
  var original = obj[method];
  if (typeof original !== "function") {
    console.warn("[loadout] afterPatch: " + method + " is not a function");
    return function() {};
  }
  obj[method] = function() {
    var args = Array.prototype.slice.call(arguments);
    var result = original.apply(this, args);
    try {
      var modified = handler(result, this, args);
      if (modified !== undefined) result = modified;
    } catch (e) {
      console.error("[loadout] afterPatch handler error:", e);
    }
    return result;
  };
  // Preserve displayName for React DevTools
  obj[method].displayName = original.displayName || original.name;
  obj[method].__steamLoaderOriginal = original;
  return function unpatch() {
    obj[method] = original;
  };
}
`.trim();

/** All React utility functions concatenated, ready for injection. */
export const REACT_UTILS = [GET_REACT_ROOT, FIND_IN_REACT_TREE, AFTER_PATCH].join("\n\n");
