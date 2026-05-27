/**
 * Steam React Discovery — JS snippet that finds React and ReactDOM from
 * Steam's webpack bundle and aliases __VENDOR_* globals to them.
 *
 * Must run BEFORE any plugin bundles are evaluated, because plugin bundles
 * are compiled with react imports mapped to globalThis.__VENDOR_REACT.
 * If __VENDOR_REACT points to a different React than Steam's, we get
 * "Objects are not valid as a React child" errors (two React instances).
 *
 * This snippet is safe to evaluate multiple times (idempotent).
 */

/**
 * JS code that discovers Steam's React/ReactDOM via webpack and sets:
 * - globalThis.__VENDOR_REACT
 * - globalThis.__VENDOR_REACT_JSX_RUNTIME
 * - globalThis.__VENDOR_REACT_JSX_DEV_RUNTIME
 * - globalThis.__VENDOR_REACT_DOM
 * - globalThis.__VENDOR_REACT_DOM_CLIENT
 * - globalThis.__STEAM_REACT (direct reference)
 * - globalThis.__STEAM_REACT_DOM (direct reference)
 *
 * Also exposes the wpRequire function as globalThis.__STEAM_WP_REQUIRE
 * for use by other injection scripts.
 */
export const DISCOVER_STEAM_REACT = `
(function() {
  if (globalThis.__STEAM_REACT) return; // Already discovered

  var wpRequire;
  if (window.webpackChunksteamui) {
    window.webpackChunksteamui.push([[Symbol()], {}, function(r) { wpRequire = r; }]);
  }
  if (!wpRequire) {
    console.warn("[loadout] webpackChunksteamui not found — cannot discover React");
    return;
  }
  globalThis.__STEAM_WP_REQUIRE = wpRequire;

  // Find React
  var React = null;
  try { React = wpRequire(51745); } catch(e) {}
  if (!React || !React.createElement) {
    React = null;
    var ids = Object.keys(wpRequire.c || {});
    for (var i = 0; i < ids.length; i++) {
      try {
        var mod = wpRequire(ids[i]);
        if (mod && mod.createElement && mod.useState && mod.useEffect) {
          React = mod;
          break;
        }
      } catch(e) {}
    }
  }

  // Find ReactDOM / ReactDOM/client
  var ReactDOM = null;
  var ReactDOMClient = null;
  if (wpRequire) {
    var ids2 = Object.keys(wpRequire.c || {});
    for (var j = 0; j < ids2.length; j++) {
      try {
        var mod2 = wpRequire(ids2[j]);
        if (mod2 && mod2.createRoot && mod2.hydrateRoot && !ReactDOMClient) {
          ReactDOMClient = mod2;
        }
        if (mod2 && mod2.render && mod2.createPortal && !ReactDOM) {
          ReactDOM = mod2;
        }
        if (ReactDOM && ReactDOMClient) break;
      } catch(e) {}
    }
  }

  if (React) {
    globalThis.__STEAM_REACT = React;
    globalThis.__VENDOR_REACT = React;
    globalThis.__VENDOR_REACT_JSX_RUNTIME = React;
    globalThis.__VENDOR_REACT_JSX_DEV_RUNTIME = React;
    console.log("[loadout] React aliased from Steam webpack");
  } else {
    console.warn("[loadout] Could not find React in Steam webpack");
  }

  if (ReactDOM) {
    globalThis.__STEAM_REACT_DOM = ReactDOM;
    globalThis.__VENDOR_REACT_DOM = ReactDOM;
  }

  if (ReactDOMClient) {
    globalThis.__VENDOR_REACT_DOM_CLIENT = ReactDOMClient;
  }
})();
`.trim();
