/**
 * Overlay-menu patcher — injects an *optional* "Loadout" entry into
 * Steam's main navigation menu that opens the Loadout overlay (issue
 * #169).
 *
 * Why this exists: the overlay is normally summoned by a controller
 * chord (the wake button). If that chord is mis-configured, or the
 * controller itself wedges on wake, the user has no way back into the
 * overlay to fix it / reboot the pads. A menu entry lives in Steam's own
 * focus tree, so it stays reachable by D-pad even when the wake chord is
 * dead — unlike a raw floating DOM button, which Steam's spatial nav
 * can't focus.
 *
 * Label + icon are fixed ("Loadout" + a gamepad glyph) — it's a single
 * well-known escape hatch, not a themeable widget.
 *
 * Mechanics (all in SharedJSContext, where #root + the full React tree
 * live — same context the plugin menu-patcher targets):
 *   1. Fiber-patch `MainNavMenuContainer` to splice one nav item in
 *      (technique lifted from ./menu-patcher, narrowed to a single item
 *      so the feature is independent of the plugin menu system — no
 *      plugin ships a `menu` target today, issue #60).
 *   2. Steam nav items are pure route items — activating one just calls
 *      `tempNavStore.m_history.push(route)`. We give the item a sentinel
 *      route and wrap `m_history.push`/`.replace` so that navigating to
 *      the sentinel instead fires the CDP binding (which pops the
 *      overlay) and is *swallowed* — the router never moves, so closing
 *      the overlay returns the user exactly where they were. Verified
 *      live: swallowing the push leaves `location.pathname` unchanged.
 *      A 150ms pathname poll is kept purely as a safety net: if a future
 *      Steam build routes the item some other way and the sentinel does
 *      land, we fire the overlay and `history.goBack()` so the user can
 *      never get stranded on a blank page again.
 *
 * The binding is added loader-side via `Runtime.addBinding` (see
 * injector.ts) because Steam's CEF blocks fetch() to localhost — the
 * same cross-CEF dispatch path the game-session monitor uses.
 *
 * Pure string builders so the structure is unit-testable without a live
 * Steam.
 */

import { REACT_UTILS } from "./react-utils";

/** DOM/global markers — shared with the remove script + injector cleanup. */
export const OVERLAY_MENU_STATE_GLOBAL = "__LOADOUT_OVERLAY_MENU";
/** Sentinel route the nav item points at; intercepted to trigger the overlay. */
export const OVERLAY_MENU_ROUTE = "/loadout/open-overlay";
/** CDP binding name the item calls to reach the loader. */
export const OVERLAY_MENU_BINDING = "__loadoutOverlayOpen";
/** Fixed menu label. */
export const OVERLAY_MENU_LABEL = "Loadout";

/**
 * Gamepad glyph (Lucide-derived, 24×24, stroke = currentColor). Rendered
 * at 60% of the icon slot so it reads at the same visual weight as
 * Steam's own nav glyphs (which sit inset in their slot rather than
 * filling it edge-to-edge).
 */
const GAMEPAD_ICON_PATH =
  "M6 12h4m-2-2v4M15 11h.01M18 13h.01M17.32 5H6.68a4 4 0 0 0-3.978 3.59C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z";

export interface OverlayMenuConfig {
  /** 1-based nav position; omit to insert right after Home. */
  position?: number;
}

/**
 * Build the SharedJSContext script that injects the "Loadout" nav entry
 * and arms the navigate-nowhere interception. Idempotent: re-running
 * cleans up the prior patch first, so it's safe to call on every
 * reinject.
 */
export function buildOverlayMenuInjectScript(config: OverlayMenuConfig = {}): string {
  const cfg = {
    label: OVERLAY_MENU_LABEL,
    iconPath: GAMEPAD_ICON_PATH,
    route: OVERLAY_MENU_ROUTE,
    binding: OVERLAY_MENU_BINDING,
    position: config.position ?? 2,
    stateGlobal: OVERLAY_MENU_STATE_GLOBAL,
  };
  const cfgJson = JSON.stringify(cfg);

  return `
(function() {
  "use strict";

  ${REACT_UTILS}

  var CFG = ${cfgJson};

  // Tear down any previous patch (hot reload / re-inject).
  if (window[CFG.stateGlobal] && typeof window[CFG.stateGlobal].cleanup === "function") {
    try { window[CFG.stateGlobal].cleanup(); } catch (e) {}
  }

  // ── Trigger plumbing ────────────────────────────────────────────
  function fireOverlay() {
    try { if (typeof window[CFG.binding] === "function") window[CFG.binding](""); } catch (e) {}
  }
  function currentPath() {
    try {
      var ns = window.tempNavStore;
      var p = ns && ns.m_history && ns.m_history.location && ns.m_history.location.pathname;
      return p || window.location.pathname || "";
    } catch (e) { return ""; }
  }
  function isSentinel(to) {
    var p = (typeof to === "string") ? to : (to && to.pathname) || "";
    return typeof p === "string" && p.indexOf(CFG.route) === 0;
  }

  // Primary path: intercept navigation to the sentinel route and swallow
  // it, opening the overlay instead. The router never moves → no blank page.
  var history = null, origPush = null, origReplace = null;
  try {
    var ns = window.tempNavStore;
    history = ns && ns.m_history;
    if (history && !history.__loadoutOverlayWrapped) {
      origPush = history.push.bind(history);
      origReplace = history.replace.bind(history);
      history.push = function(to) { if (isSentinel(to)) { fireOverlay(); return; } return origPush.apply(this, arguments); };
      history.replace = function(to) { if (isSentinel(to)) { fireOverlay(); return; } return origReplace.apply(this, arguments); };
      history.__loadoutOverlayWrapped = true;
    }
  } catch (e) {}

  // Safety net: if navigation ever slips through to the sentinel anyway,
  // open the overlay and step back so the user is never stranded.
  var watchId = setInterval(function() {
    if (isSentinel(currentPath())) {
      fireOverlay();
      try { if (history && typeof history.goBack === "function") history.goBack(); } catch (e) {}
    }
  }, 150);

  // ── Menu injection ──────────────────────────────────────────────
  var steamReact;
  if (window.webpackChunksteamui) {
    var wpRequire;
    window.webpackChunksteamui.push([[Symbol()], {}, function(r) { wpRequire = r; }]);
    if (wpRequire) {
      try { steamReact = wpRequire(51745); } catch (e) {}
      if (!steamReact || !steamReact.createElement) {
        steamReact = null;
        var ids = Object.keys(wpRequire.c || {});
        for (var mi = 0; mi < ids.length; mi++) {
          try {
            var mod = wpRequire(ids[mi]);
            if (mod && mod.createElement && mod.useState && mod.useEffect) { steamReact = mod; break; }
          } catch (e) {}
        }
      }
    }
  }

  function installCleanup(unpatchMenu) {
    window[CFG.stateGlobal] = {
      cleanup: function() {
        try { clearInterval(watchId); } catch (e) {}
        try {
          if (history && history.__loadoutOverlayWrapped) {
            if (origPush) history.push = origPush;
            if (origReplace) history.replace = origReplace;
            delete history.__loadoutOverlayWrapped;
          }
        } catch (e) {}
        try { if (unpatchMenu) unpatchMenu(); } catch (e) {}
        try { delete window[CFG.stateGlobal]; } catch (e) {}
      }
    };
  }

  if (!steamReact) {
    console.warn("[loadout:overlay-menu] Steam React not found — trigger armed, menu item skipped");
    installCleanup(null);
    return;
  }

  var fiberRoot = getReactRoot(document.getElementById("root"));
  if (!fiberRoot) { console.warn("[loadout:overlay-menu] No fiber root"); installCleanup(null); return; }

  var menuNode = findInReactTree(fiberRoot, function(node) {
    return node && node.memoizedProps && node.memoizedProps.navID === "MainNavMenuContainer";
  });
  if (!menuNode || !menuNode.return || !menuNode.return.type) {
    console.warn("[loadout:overlay-menu] MainNavMenuContainer not found");
    installCleanup(null);
    return;
  }

  var orig = menuNode.return.type;
  var patchedInner = null;

  // Steam's own nav icons are a fixed 1.25rem (20px @ root 16px) square —
  // measured live against the sibling items. Our <svg> has no intrinsic
  // size, so without an explicit width Steam's icon wrapper balloons to
  // the row height (~115px). Pin it to 1.25rem so the wrapper collapses to
  // the exact sibling size; rem tracks Steam's UI scale.
  function makeIcon() {
    return steamReact.createElement("svg", {
      xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
      style: { width: "1.25rem", height: "1.25rem", display: "block", flex: "0 0 auto" }
    }, steamReact.createElement("path", { d: CFG.iconPath }));
  }

  function menuWrapper(props) {
    var ret = orig(props);
    var cc = ret && ret.props && ret.props.children &&
             ret.props.children.props && ret.props.children.props.children;
    if (!cc || !cc[0] || !cc[0].type) return ret;

    if (patchedInner) { cc[0].type = patchedInner; return ret; }
    var origInner = cc[0].type;

    cc[0].type = function patchedMenuInner() {
      var innerRet = origInner.apply(this, arguments);

      var isMenuItem = function(e) { return e && e.props && e.props.label && e.props.route; };
      var queue = [innerRet], found = null, searched = 0;
      while (queue.length > 0 && searched < 200) {
        var node = queue.shift(); searched++;
        if (!node) continue;
        if (Array.isArray(node) && node.some(isMenuItem)) { found = node; break; }
        if (node.props) {
          if (Array.isArray(node.props.children)) {
            if (node.props.children.some(isMenuItem)) { found = node.props.children; break; }
            for (var ci = 0; ci < node.props.children.length; ci++) queue.push(node.props.children[ci]);
          } else if (node.props.children) {
            queue.push(node.props.children);
          }
        }
      }
      if (!found) return innerRet;

      // Drop our previously-injected item so re-renders don't duplicate it.
      for (var ri = found.length - 1; ri >= 0; ri--) {
        if (found[ri] && found[ri].key === "loadout-overlay-open") found.splice(ri, 1);
      }

      var refItem = found.find(isMenuItem);
      if (!refItem) return innerRet;

      var newItem = steamReact.createElement(refItem.type, {
        key: "loadout-overlay-open",
        route: CFG.route,
        label: CFG.label,
        onFocus: refItem.props.onFocus,
        icon: makeIcon()
      });

      var itemIndexes = [];
      for (var ii = 0; ii < found.length; ii++) {
        if (found[ii] && found[ii].$$typeof && found[ii].type !== "div") itemIndexes.push(ii);
      }
      var pos = CFG.position;
      if (pos > 0 && pos <= itemIndexes.length) {
        found.splice(itemIndexes[pos - 1] + 1, 0, newItem);
      } else {
        found.splice(itemIndexes.length > 0 ? itemIndexes[0] + 1 : 0, 0, newItem);
      }
      return innerRet;
    };
    patchedInner = cc[0].type;
    return ret;
  }

  menuNode.return.type = menuWrapper;
  if (menuNode.return.alternate) menuNode.return.alternate.type = menuWrapper;

  function forceRerender(node) {
    var f = node;
    while (f) {
      if (f.memoizedState) {
        var hs = f.memoizedState;
        while (hs) {
          if (hs.queue && hs.queue.dispatch) {
            try { hs.queue.dispatch({ __loadoutForce: Date.now() }); } catch (e) {}
            break;
          }
          hs = hs.next;
        }
        break;
      }
      f = f.return;
    }
  }
  forceRerender(menuNode);

  installCleanup(function() {
    try {
      menuNode.return.type = orig;
      if (menuNode.return.alternate) menuNode.return.alternate.type = orig;
      forceRerender(menuNode);
    } catch (e) {}
  });

  console.log("[loadout:overlay-menu] Injected '" + CFG.label + "' entry (navigate-nowhere)");
})();
  `.trim();
}

/** Build the teardown script (called when the user disables the toggle). */
export function buildOverlayMenuRemoveScript(): string {
  return `
(function() {
  var s = window["${OVERLAY_MENU_STATE_GLOBAL}"];
  if (s && typeof s.cleanup === "function") {
    try { s.cleanup(); } catch (e) {}
    return "removed";
  }
  return "nothing_to_remove";
})();
  `.trim();
}
