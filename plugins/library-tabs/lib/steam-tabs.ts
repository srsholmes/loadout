/**
 * Real tabs in Steam's own library. [iso]
 *
 * Steam builds its library tab bar inline in a `useMemo` — `AllGames`,
 * `Installed`, `Favorites`, a single `Collections`, and so on — and returns it
 * as `rgTabs`. Nothing reads a store, so no amount of correctly-written data
 * can add a tab. Writing collections (see `mirror.ts`) puts our games *inside*
 * the one Collections tab; it cannot put a tab beside it.
 *
 * So we patch that module's source before it executes (see the `patches` block
 * in `package.json`). Two things make this far safer than TabMaster's
 * equivalent, which swaps React's `useMemo` dispatcher at render time:
 *
 *   1. If the patch fails to apply, Steam renders stock. TabMaster's failure
 *      mode is the library page dying mid-render.
 *   2. The replacement is a guarded call — `__LOADOUT_LT ? … : p` — so even a
 *      *successful* patch with no runtime installed is a no-op.
 *
 * The tabs render through **Steam's own collection view**, not ours. Our
 * replacement runs inside the patched module's scope, so Steam's renderer and
 * JSX factory are in scope as locals; we hand the renderer a collection-shaped
 * object and the tiles come out native. No React of ours ever enters Steam.
 *
 * This file is pure: it builds strings. The strings are what cross into Steam.
 */

/** One tab as Steam needs to know about it. Membership is already evaluated. */
export interface SteamTabPayload {
  /** Stable, namespaced so it can never collide with a Steam tab id. */
  id: string;
  title: string;
  appIds: string[];
}

/** The global the patch reads. Namespaced, and the only surface we add. */
export const RUNTIME_GLOBAL = "__LOADOUT_LT";

/**
 * The replacement expression for the patch.
 *
 * `p` is Steam's tab array, `i` its JSX factory, `Gc` the collection view and
 * `d` the props every tab's content is spread with. All four are locals in the
 * patched scope — which is the whole reason source patching beats reaching in
 * from outside.
 *
 * Guarded twice: absent runtime yields `p`, and a throwing runtime is caught
 * in `extend` itself. A library that renders without our tabs is a
 * disappointment; a library that does not render is a support ticket.
 */
export function tabsReplacement(): string {
  return `return[(globalThis.${RUNTIME_GLOBAL}?globalThis.${RUNTIME_GLOBAL}.extend(p,i,Gc,d):p).filter(e=>e),k!=F]`;
}

/** The source text the patch looks for. */
export const TABS_FIND = "return[p.filter(e=>e),k!=F]";

/**
 * The runtime, installed into Steam's context over CDP.
 *
 * Deliberately a separate step from the patch. The patch is declarative and
 * lands at Steam start; the runtime carries data that changes whenever a rule
 * changes, and re-installing it is just another CDP eval.
 */
export function buildTabsRuntime(): string {
  return `
(function () {
  var G = globalThis;
  if (G.${RUNTIME_GLOBAL}) return "already-installed";

  G.${RUNTIME_GLOBAL} = {
    /** Latest evaluated tabs. Replaced wholesale by setTabs. */
    data: [],

    setTabs: function (next) {
      G.${RUNTIME_GLOBAL}.data = Array.isArray(next) ? next : [];
      return G.${RUNTIME_GLOBAL}.data.length;
    },

    /**
     * Build a collection-shaped object Steam's own view can render.
     *
     * Steam's tile grid reads \`visibleApps\`, so appIds are resolved to app
     * overviews here. An id the store doesn't know — an uninstalled shortcut,
     * a game removed from the account — is dropped rather than passed through
     * as null, which would blank a tile.
     */
    collectionFor: function (tab) {
      var as = G.appStore;
      var apps = [];
      if (as && typeof as.GetAppOverviewByAppID === "function") {
        for (var i = 0; i < tab.appIds.length; i++) {
          var app = null;
          try { app = as.GetAppOverviewByAppID(Number(tab.appIds[i])); } catch (e) {}
          if (app) apps.push(app);
        }
      }
      return {
        id: tab.id,
        displayName: tab.title,
        allApps: apps,
        visibleApps: apps,
        // Steam checks these before offering drag-and-drop or an edit affordance.
        // Our membership comes from rules, so hand-editing it in Steam would be
        // silently undone by the next sync — better to not offer it.
        bIsDynamic: true,
        bIsEditable: false,
        bAllowsDragAndDrop: false,
      };
    },

    /**
     * Append our tabs to Steam's array.
     *
     * Appends rather than splices: a user who has learnt where AllGames sits
     * should still find it there. Any throw returns Steam's own array
     * untouched, so a bad payload costs us our tabs, never the library.
     */
    extend: function (tabs, jsx, View, shared) {
      try {
        var data = G.${RUNTIME_GLOBAL}.data;
        if (!Array.isArray(data) || data.length === 0) return tabs;

        var existing = {};
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i] && tabs[i].id) existing[tabs[i].id] = true;
        }

        var out = tabs.slice();
        for (var j = 0; j < data.length; j++) {
          var tab = data[j];
          if (!tab || !tab.id || existing[tab.id]) continue;
          var collection = G.${RUNTIME_GLOBAL}.collectionFor(tab);
          out.push({
            id: tab.id,
            // Steam runs titles through its localisation lookup, where a
            // missing "#"-prefixed token renders as the raw token. User tab
            // names have no token, so they pass through as themselves.
            title: tab.title,
            content: jsx.jsx(View, Object.assign({ collection: collection }, shared)),
          });
        }
        return out;
      } catch (e) {
        if (G.console && G.console.warn) {
          G.console.warn("[loadout:library-tabs] tab injection failed", e);
        }
        return tabs;
      }
    },
  };
  return "installed";
})()`.trim();
}

/** The CDP expression that pushes freshly-evaluated tabs into Steam. */
export function setTabsExpression(tabs: readonly SteamTabPayload[]): string {
  return `(globalThis.${RUNTIME_GLOBAL} ? globalThis.${RUNTIME_GLOBAL}.setTabs(${JSON.stringify(tabs)}) : -1)`;
}

/**
 * Namespace a tab id so it can never collide with one of Steam's.
 *
 * Steam matches the active tab by id and falls back to `rgTabs[0]` when it
 * doesn't find one. A tab of ours called `AllGames` would therefore shadow
 * Steam's and quietly change what the library opens on.
 */
export function steamTabId(tabId: string): string {
  return `loadout-${tabId}`;
}
