/**
 * Menu Patcher — injects custom entries into Steam's main navigation menu
 * (the sidebar with Home, Library, Store, etc.) by patching the React fiber tree.
 *
 * Plugins declare menu entries via target.type === "menu" in plugin.json.
 * The injector collects these and passes them here for injection.
 *
 * Technique adapted from DeckWebBrowser's menuPatch:
 * 1. Find MainNavMenuContainer in the React fiber tree
 * 2. Wrap the outer menu component to intercept renders
 * 3. Patch the inner menu component (Be) to intercept its output
 * 4. BFS the output for the menu items array
 * 5. Splice in new items using Steam's own React from webpack
 *
 * Critical: must use Steam's React (from webpackChunksteamui), NOT __VENDOR_REACT.
 * Elements created with a different React instance won't render in Steam's tree.
 */

import { REACT_UTILS } from "./react-utils";

export interface MenuPluginEntry {
  pluginId: string;
  title: string;
  route: string;
  /** Where to insert: number = 1-based index, or omit to insert after Home */
  position?: number;
  icon?: string;
}

/**
 * Build a JS snippet that injects entries into Steam's main nav menu.
 * Evaluated via CDP in the SharedJSContext.
 */
export function buildMenuPatchScript(plugins: MenuPluginEntry[]): string {
  const pluginsJson = JSON.stringify(plugins);

  return `
(function() {
  "use strict";

  ${REACT_UTILS}

  var PLUGINS = ${pluginsJson};

  // Clean up previous patch
  if (window.__LOADOUT_MENU_CLEANUP) {
    try { window.__LOADOUT_MENU_CLEANUP(); } catch(e) {}
    delete window.__LOADOUT_MENU_CLEANUP;
  }

  // Step 1: Get Steam's React from webpack (NOT __VENDOR_REACT)
  var steamReact;
  if (window.webpackChunksteamui) {
    var wpRequire;
    window.webpackChunksteamui.push([[Symbol()], {}, function(r) { wpRequire = r; }]);
    if (wpRequire) {
      // Try known React module ID first, fall back to scanning
      try { steamReact = wpRequire(51745); } catch(e) {}
      if (!steamReact || !steamReact.createElement) {
        steamReact = null;
        var ids = Object.keys(wpRequire.c || {});
        for (var mi = 0; mi < ids.length; mi++) {
          try {
            var mod = wpRequire(ids[mi]);
            if (mod && mod.createElement && mod.useState && mod.useEffect) {
              steamReact = mod;
              break;
            }
          } catch(e) {}
        }
      }
    }
  }

  if (!steamReact) {
    console.warn("[loadout:menu] Could not find Steam's React via webpack");
    return;
  }

  // Step 2: Get the React fiber root from #root
  var fiberRoot = getReactRoot(document.getElementById("root"));
  if (!fiberRoot) {
    console.warn("[loadout:menu] No React fiber root found on #root");
    return;
  }

  // Step 3: Find MainNavMenuContainer
  var menuNode = findInReactTree(fiberRoot, function(node) {
    return node && node.memoizedProps && node.memoizedProps.navID === "MainNavMenuContainer";
  });

  if (!menuNode || !menuNode.return || !menuNode.return.type) {
    console.warn("[loadout:menu] MainNavMenuContainer not found");
    return;
  }

  // Step 4: Wrap the outer menu component
  var orig = menuNode.return.type;
  var patchedInnerMenu = null;

  function menuWrapper(props) {
    var ret = orig(props);

    // Navigate to inner menu component: ret.props.children.props.children[0]
    var cc = ret && ret.props && ret.props.children &&
             ret.props.children.props && ret.props.children.props.children;
    if (!cc || !cc[0] || !cc[0].type) return ret;

    if (patchedInnerMenu) {
      cc[0].type = patchedInnerMenu;
    } else {
      var origInner = cc[0].type;

      cc[0].type = function patchedMenuInner() {
        var innerRet = origInner.apply(this, arguments);

        // BFS the render output for the menu items array
        var isMenuItem = function(e) { return e && e.props && e.props.label && e.props.route; };
        var searchQueue = [innerRet];
        var found = null;
        var searched = 0;

        while (searchQueue.length > 0 && searched < 200) {
          var node = searchQueue.shift();
          searched++;
          if (!node) continue;

          if (Array.isArray(node) && node.some(isMenuItem)) {
            found = node;
            break;
          }

          if (node.props) {
            if (Array.isArray(node.props.children)) {
              if (node.props.children.some(isMenuItem)) {
                found = node.props.children;
                break;
              }
              for (var ci = 0; ci < node.props.children.length; ci++) {
                searchQueue.push(node.props.children[ci]);
              }
            } else if (node.props.children) {
              searchQueue.push(node.props.children);
            }
          }
        }

        if (!found) return innerRet;

        // Remove previously injected items
        for (var ri = found.length - 1; ri >= 0; ri--) {
          if (found[ri] && found[ri].key && String(found[ri].key).startsWith("loadout-menu-")) {
            found.splice(ri, 1);
          }
        }

        var refItem = found.find(isMenuItem);
        if (!refItem) return innerRet;

        // Inject each plugin entry using Steam's React
        for (var p = 0; p < PLUGINS.length; p++) {
          var plugin = PLUGINS[p];

          var iconEl = steamReact.createElement("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "center" }
          }, steamReact.createElement("svg", {
            xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 36 36", fill: "none",
            style: { width: "100%", height: "100%" }
          },
            steamReact.createElement("circle", { cx: 18, cy: 18, r: 15, stroke: "currentColor", strokeWidth: 2, fill: "none" }),
            steamReact.createElement("path", { d: "M3 18h30M18 3c-4 4-6 9-6 15s2 11 6 15c4-4 6-9 6-15s-2-11-6-15", stroke: "currentColor", strokeWidth: 2, fill: "none" })
          ));

          var newItem = steamReact.createElement(refItem.type, {
            key: "loadout-menu-" + plugin.pluginId,
            route: plugin.route,
            label: plugin.title,
            onFocus: refItem.props.onFocus,
            icon: iconEl
          });

          // Insert at requested position (1-based), default after Home
          var pos = plugin.position || 2;
          var itemIndexes = [];
          for (var ii = 0; ii < found.length; ii++) {
            if (found[ii] && found[ii].$$typeof && found[ii].type !== "div") {
              itemIndexes.push(ii);
            }
          }

          if (pos > 0 && pos <= itemIndexes.length) {
            found.splice(itemIndexes[pos - 1] + 1, 0, newItem);
          } else {
            found.splice(itemIndexes.length > 0 ? itemIndexes[0] + 1 : 0, 0, newItem);
          }
        }

        return innerRet;
      };

      patchedInnerMenu = cc[0].type;
    }

    return ret;
  }

  // Step 5: Apply the patch + alternate
  menuNode.return.type = menuWrapper;
  if (menuNode.return.alternate) {
    menuNode.return.alternate.type = menuWrapper;
  }

  // Step 6: Force re-render
  var fiber = menuNode;
  while (fiber) {
    if (fiber.memoizedState) {
      var hs = fiber.memoizedState;
      while (hs) {
        if (hs.queue && hs.queue.dispatch) {
          try { hs.queue.dispatch({ __steamLoaderForce: Date.now() }); } catch(e) {}
          break;
        }
        hs = hs.next;
      }
      break;
    }
    fiber = fiber.return;
  }

  // Step 7: Cleanup function
  window.__LOADOUT_MENU_CLEANUP = function() {
    menuNode.return.type = orig;
    if (menuNode.return.alternate) menuNode.return.alternate.type = orig;
    // Force re-render to remove items
    var f = menuNode;
    while (f) {
      if (f.memoizedState) {
        var h = f.memoizedState;
        while (h) {
          if (h.queue && h.queue.dispatch) {
            try { h.queue.dispatch({ __steamLoaderForce: Date.now() }); } catch(e) {}
            break;
          }
          h = h.next;
        }
        break;
      }
      f = f.return;
    }
  };

  console.log("[loadout:menu] Menu patched — " + PLUGINS.length + " item(s) injected");
})();
  `.trim();
}
