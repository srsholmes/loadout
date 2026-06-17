/**
 * Route Patcher — generates JavaScript that runs in Steam's SharedJSContext
 * to register custom routes for plugin pages.
 *
 * Strategy:
 * 1. Find the Router component's route array from webpack modules
 * 2. Append custom Route entries that render plugin named exports
 * 3. Store unpatch functions for cleanup on hot reload
 */

import { REACT_UTILS } from "./react-utils";

export interface RouteEntry {
  /** Route path, e.g. "/loadout/hello-world-qam/settings" */
  path: string;
  /** Plugin ID that owns this route */
  pluginId: string;
  /** Named export from the plugin that provides the route component */
  exportName: string;
}

/**
 * Build a JS snippet that patches Steam's router to add custom routes.
 * Evaluated in Steam's CEF context via CDP.
 */
export function buildRoutePatchScript(routes: RouteEntry[]): string {
  const routesJson = JSON.stringify(routes);

  return `
(function() {
  "use strict";

  ${REACT_UTILS}

  var ROUTES = ${routesJson};
  var unpatchFns = globalThis.__LOADOUT_ROUTE_UNPATCHERS || [];

  // Clean up previous patches (hot reload)
  for (var u = 0; u < unpatchFns.length; u++) {
    try { unpatchFns[u](); } catch(e) {}
  }
  unpatchFns = [];
  globalThis.__LOADOUT_ROUTE_UNPATCHERS = unpatchFns;

  var React = globalThis.__VENDOR_REACT;
  if (!React) {
    console.error("[loadout:routes] React not available");
    return;
  }

  if (!window.webpackChunksteamui) {
    console.warn("[loadout:routes] webpackChunksteamui not found");
    return;
  }

  // Get webpack require
  var wpRequire;
  try {
    window.webpackChunksteamui.push([
      [Symbol()],
      {},
      function(require) { wpRequire = require; }
    ]);
  } catch(e) {
    console.error("[loadout:routes] Failed to get webpack require:", e);
    return;
  }

  if (!wpRequire || !wpRequire.m) {
    console.warn("[loadout:routes] webpack require not available");
    return;
  }

  // Find the module that contains the route definitions
  // Steam's routes are typically in a module that has an array of route config objects
  // with { path, component } shape, and references paths like "/library", "/settings", etc.
  var allModules = [];
  var ids = Object.keys(wpRequire.m);
  for (var i = 0; i < ids.length; i++) {
    try {
      var mod = wpRequire(ids[i]);
      if (mod) allModules.push(mod);
    } catch(e) {}
  }

  // Strategy: Find a function that creates Route elements and patch it
  // Look for components whose source references "Route" and common Steam paths
  var routerPatched = false;

  for (var mi = 0; mi < allModules.length && !routerPatched; mi++) {
    var mod = allModules[mi];
    if (!mod || typeof mod !== "object") continue;
    var keys = Object.keys(mod);

    for (var ki = 0; ki < keys.length && !routerPatched; ki++) {
      var val = mod[keys[ki]];
      if (typeof val !== "function") continue;

      try {
        var src = String(val);
        if (src.length > 50000 || src.length < 100) continue;

        // Look for the main app routes component — typically references
        // "/library" or "/settings" and uses Route/Switch
        if ((src.includes("/library") || src.includes("/settings"))
            && (src.includes("Route") || src.includes("route"))
            && (src.includes("Switch") || src.includes("switch") || src.includes("Routes"))) {

          var unpatch = afterPatch(mod, keys[ki], function(result) {
            return injectRoutes(result);
          });

          unpatchFns.push(unpatch);
          routerPatched = true;
          console.log("[loadout:routes] Patched router component to add " + ROUTES.length + " route(s)");
        }
      } catch(e) {}
    }
  }

  if (!routerPatched) {
    console.warn("[loadout:routes] Could not find router component to patch. Routes will use fallback.");
    // Fallback: register routes via Navigation.RegisterRoute if available
    registerRoutesFallback();
  }

  function injectRoutes(reactElement) {
    if (!reactElement || !reactElement.props) return reactElement;

    // The element likely has children that are Route elements
    // We need to add our custom routes
    var children = reactElement.props.children;
    if (!children) return reactElement;

    var customRouteElements = ROUTES.map(function(route) {
      return React.createElement(PluginRoute, {
        key: "loadout-route-" + route.path,
        path: route.path,
        pluginId: route.pluginId,
        exportName: route.exportName,
      });
    });

    // Clone the element with additional children
    if (Array.isArray(children)) {
      return React.cloneElement(reactElement, null,
        children.concat(customRouteElements)
      );
    } else {
      return React.cloneElement(reactElement, null,
        children, customRouteElements
      );
    }
  }

  // Component that renders a plugin's named export for a route
  function PluginRoute(props) {
    var pluginMod = globalThis["__LOADOUT_PLUGIN_" + props.pluginId];
    if (!pluginMod) {
      return React.createElement("div", {
        style: { padding: 32, color: "#8f98a0" }
      }, "Plugin " + props.pluginId + " not loaded");
    }
    var Component = pluginMod[props.exportName];
    if (!Component) {
      return React.createElement("div", {
        style: { padding: 32, color: "#8f98a0" }
      }, "Export '" + props.exportName + "' not found in plugin " + props.pluginId);
    }
    return React.createElement(Component);
  }

  // Fallback: use Steam's Navigation API to handle custom paths
  function registerRoutesFallback() {
    var nav = globalThis.__LOADOUT_NAVIGATION;
    if (!nav) {
      console.warn("[loadout:routes] Navigation singleton not available for fallback routing");
      return;
    }

    // Listen for navigation events and intercept our custom paths
    // This is less integrated but works as a fallback
    var originalNavigate = nav.Navigate;
    nav.Navigate = function(path) {
      for (var i = 0; i < ROUTES.length; i++) {
        if (path === ROUTES[i].path) {
          renderFullPageRoute(ROUTES[i]);
          return;
        }
      }
      return originalNavigate.call(this, path);
    };

    unpatchFns.push(function() {
      nav.Navigate = originalNavigate;
    });

    console.log("[loadout:routes] Registered " + ROUTES.length + " route(s) via Navigation fallback");
  }

  // Render a plugin route as a full-page overlay
  function renderFullPageRoute(route) {
    var ReactDOM = globalThis.__VENDOR_REACT_DOM_CLIENT;
    if (!ReactDOM) return;

    var existing = document.getElementById("loadout-route-overlay");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "loadout-route-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:999998;background:#1a1a1a;overflow-y:auto;";
    document.body.appendChild(overlay);

    var root = ReactDOM.createRoot(overlay);
    root.render(React.createElement(PluginRoute, {
      path: route.path,
      pluginId: route.pluginId,
      exportName: route.exportName,
    }));

    // Allow navigateBack to close the overlay
    var nav = globalThis.__LOADOUT_NAVIGATION;
    if (nav) {
      var origBack = nav.NavigateBack;
      nav.NavigateBack = function() {
        overlay.remove();
        root.unmount();
        nav.NavigateBack = origBack;
        return origBack.call(this);
      };
      unpatchFns.push(function() {
        nav.NavigateBack = origBack;
      });
    }
  }
})();
  `.trim();
}
