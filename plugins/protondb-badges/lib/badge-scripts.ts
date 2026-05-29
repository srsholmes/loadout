/**
 * Pure JS-source generators for the badge runtime injected into Steam's
 * CEF tabs. These are STRING-producing functions: input is plain data
 * (settings, badge payloads), output is a JavaScript source string the
 * backend ships across CDP via `Runtime.evaluate`.
 *
 * Keeping these here as pure functions has two benefits:
 *   1. They can be unit-tested against snapshot/substring expectations
 *      without standing up a CDP connection.
 *   2. The backend stays focused on I/O + CDP plumbing — the badge
 *      DOM markup, CSS, and the small in-page state machine live in
 *      one place that's diffable against the source plugin.
 *
 * The shape of the runtime mirrors the source steam-loader plugin so
 * a regression here is visible against the original code:
 *
 *   - BPM tab (the gamepad-UI window) hosts `window.__protondb_badges`
 *     with `{ cleanup, updateBadge, removeBadge, updateSettings }`.
 *     Backend pushes badge data on every game-detection broadcast.
 *
 *   - Each store tab (store.steampowered.com inside Steam) hosts
 *     `window.__protondb_store_badges` with `{ cleanup, updateBadge,
 *     removeBadge }`. Backend pushes data on store-URL-change polls.
 *
 * No `fetch()` runs inside CEF (mixed-content blocks https://
 * steamloopback.host → http://localhost): the backend is the data
 * source and pushes via CDP.
 */

import type { ProtonDBSettings } from "./settings";

/**
 * Generate the shared stylesheet for the BPM badge + the Tux indicator
 * + the Submit button. Identical to the source plugin verbatim so the
 * rendered badge matches pixel-for-pixel.
 */
export function generateBadgeCSS(): string {
  return `
/* ProtonDB Badges - loadout */
#protondb-badges-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
  transition: filter 0.2s, outline 0.2s;
}
#protondb-badges-container:hover {
  filter: brightness(1.3);
  outline: 2px solid rgba(0,0,0,0.8);
}
#protondb-badges-container .protondb-badge-inner {
  display: flex; align-items: center;
}

/* Regular */
#protondb-badges-container.protondb-size-regular .protondb-icon { width: 28px; height: 28px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-regular .protondb-icon svg { width: 28px; height: 28px; }
#protondb-badges-container.protondb-size-regular .protondb-badge-inner { padding: 6px 18px; }
#protondb-badges-container.protondb-size-regular .protondb-label {
  margin-left: 10px; font-size: 24px; line-height: 24px; white-space: nowrap; font-weight: 500;
}

/* Small */
#protondb-badges-container.protondb-size-small .protondb-icon { width: 20px; height: 20px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-small .protondb-icon svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-small .protondb-badge-inner { padding: 6px 8px; }
#protondb-badges-container.protondb-size-small .protondb-label {
  margin-left: 6px; font-size: 12px; line-height: 12px; white-space: nowrap; font-weight: 500;
}

/* Minimalist */
#protondb-badges-container.protondb-size-minimalist .protondb-icon { width: 20px; height: 20px; display: flex; align-items: center; }
#protondb-badges-container.protondb-size-minimalist .protondb-icon svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-minimalist .protondb-badge-inner { padding: 6px; }
#protondb-badges-container.protondb-size-minimalist .protondb-label {
  display: none; margin-left: 10px; white-space: nowrap; font-weight: 500;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-small:hover .protondb-label {
  display: inline; font-size: 12px; line-height: 12px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-small:hover .protondb-badge-inner {
  padding: 6px 8px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-regular:hover .protondb-label {
  display: inline; font-size: 24px; line-height: 24px;
}
#protondb-badges-container.protondb-size-minimalist.protondb-hover-regular:hover .protondb-badge-inner {
  padding: 6px 18px;
}

/* Tux */
#protondb-badges-container .protondb-tux {
  display: flex; align-items: center; background: #1a1a2e; padding: 6px; color: #fff;
}
#protondb-badges-container.protondb-size-regular .protondb-tux svg { width: 28px; height: 28px; }
#protondb-badges-container.protondb-size-small .protondb-tux svg { width: 20px; height: 20px; }
#protondb-badges-container.protondb-size-minimalist .protondb-tux svg { width: 20px; height: 20px; }

/* Submit */
#protondb-badges-container .protondb-submit {
  display: flex; align-items: center; background: rgba(166,166,166,0.9);
  padding: 6px 10px; color: #000; font-size: 14px; font-weight: 500;
  cursor: pointer; border: none; text-decoration: none;
}
#protondb-badges-container .protondb-submit:hover { background: rgba(180,180,180,1); }

/* Tiers */
.protondb-tier-platinum .protondb-badge-inner { background: rgb(180,199,220); color: #000; }
.protondb-tier-gold .protondb-badge-inner     { background: rgb(207,181,59);  color: #000; }
.protondb-tier-silver .protondb-badge-inner   { background: rgb(166,166,166); color: #000; }
.protondb-tier-bronze .protondb-badge-inner   { background: rgb(205,127,50);  color: #000; }
.protondb-tier-borked .protondb-badge-inner   { background: rgb(255,0,0);     color: #000; }
.protondb-tier-pending .protondb-badge-inner  { background: rgb(68,68,68);    color: #fff; }
`;
}

/**
 * Generate the in-page badge runtime injected into the Big Picture Mode
 * tab. The backend pushes badge data via CDP (`updateBadge(payload)`);
 * no fetch() runs in the page because mixed-content rules would block
 * https → http://localhost.
 *
 * `settings` is JSON-stringified into the source so the in-page closure
 * has its own snapshot — subsequent `updateSettings(...)` calls swap
 * the live reference without re-injecting the runtime.
 */
export function generateBPMScript(settings: ProtonDBSettings): string {
  const settingsJson = JSON.stringify(settings);
  return `
(function() {
  if (window.__protondb_badges) window.__protondb_badges.cleanup();

  var currentAppId = null;
  var currentTier = null;
  var badgeEl = null;
  var settings = ${settingsJson};

  var TIER_LABELS = {
    platinum: "Platinum", gold: "Gold", silver: "Silver",
    bronze: "Bronze", borked: "Borked", pending: "Pending"
  };

  function removeBadge() {
    if (badgeEl) { badgeEl.remove(); badgeEl = null; currentTier = null; currentAppId = null; }
  }

  function createBadge(data) {
    var report = data.report;
    if (!report || !settings.enableLibraryBadge) { removeBadge(); return; }

    var tier = (report.tier || "pending").toLowerCase();
    // Always re-render. Skipping on same-tier left the submit href and
    // the click handler closure pointing at the previous appId, so
    // clicking the badge on a same-tier game opened the wrong ProtonDB
    // page. createElement cost is trivial; BPM nav is human-paced.
    removeBadge();
    currentAppId = data.appId || null;
    currentTier = tier;

    var label = TIER_LABELS[tier] || report.tier;

    var container = document.createElement("div");
    container.id = "protondb-badges-container";
    container.className = "protondb-tier-" + tier + " protondb-size-" + (settings.size || "regular");
    if (settings.size === "minimalist" && settings.labelOnHover !== "off") {
      container.className += " protondb-hover-" + settings.labelOnHover;
    }

    // Position
    var p = settings.position || "tl";
    container.style.position = "fixed";
    container.style.zIndex = "99999";
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.cursor = "pointer";
    if (p[0] === "t") container.style.top = "60px"; else container.style.bottom = "60px";
    if (p[1] === "l") container.style.left = "20px";
    else if (p[1] === "m") { container.style.left = "50%"; container.style.transform = "translateX(-50%)"; }
    else container.style.right = "20px";

    // SVG icons
    var ATOM_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" style="display:block"><circle cx="12" cy="12" r="2.5"/><g fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="12" cy="12" rx="10" ry="3.5"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(-60 12 12)"/></g></svg>';
    var TUX_SVG = '<svg viewBox="0 0 32 32" fill="currentColor" style="display:block"><path d="M16 2c-2.4 0-4.2 1.7-4.8 4-.3 1.2-.2 2.4.2 3.5-2.2 2-3.9 5-3.9 8.5 0 2 .6 3.8 1.6 5.3-.3.5-.6 1.1-.6 1.7 0 1.1.5 2 1.2 2.6.5.4 1.2.6 1.8.6h9c.6 0 1.3-.2 1.8-.6.7-.6 1.2-1.5 1.2-2.6 0-.6-.3-1.2-.6-1.7 1-1.5 1.6-3.3 1.6-5.3 0-3.5-1.7-6.5-3.9-8.5.4-1.1.5-2.3.2-3.5C20.2 3.7 18.4 2 16 2zm-3 8.5c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5-1.5-.7-1.5-1.5.7-1.5 1.5-1.5zm6 0c.8 0 1.5.7 1.5 1.5s-.7 1.5-1.5 1.5-1.5-.7-1.5-1.5.7-1.5 1.5-1.5zm-4.5 5h3c0 1.7-.7 3-1.5 3s-1.5-1.3-1.5-3z"/></svg>';

    // Badge inner
    var inner = document.createElement("div");
    inner.className = "protondb-badge-inner";
    var icon = document.createElement("span");
    icon.className = "protondb-icon";
    icon.innerHTML = ATOM_SVG;
    inner.appendChild(icon);
    var labelEl = document.createElement("span");
    labelEl.className = "protondb-label";
    labelEl.textContent = label;
    inner.appendChild(labelEl);
    container.appendChild(inner);

    // Tux
    if (data.linuxSupport) {
      var tux = document.createElement("div");
      tux.className = "protondb-tux";
      tux.innerHTML = TUX_SVG;
      container.appendChild(tux);
    }

    // Submit
    if (settings.showSubmitButton && currentAppId) {
      var submit = document.createElement("a");
      submit.className = "protondb-submit";
      submit.href = "https://www.protondb.com/contribute?appId=" + currentAppId;
      submit.target = "_blank";
      submit.textContent = "Submit";
      submit.addEventListener("click", function(e) { e.stopPropagation(); });
      container.appendChild(submit);
    }

    container.addEventListener("click", function() {
      if (currentAppId) window.open("https://www.protondb.com/app/" + currentAppId, "_blank");
    });

    document.body.appendChild(container);
    badgeEl = container;
  }

  // Backend pushes data via CDP — no polling needed. Settings changes
  // re-inject the whole runtime (backend.updateSettings triggers
  // _injectBadgeSystem again), so there is no in-page settings hook.
  window.__protondb_badges = {
    cleanup: function() {
      removeBadge();
    },
    updateBadge: function(data) {
      createBadge(data);
    },
    removeBadge: removeBadge,
  };
})();
`;
}

/**
 * Generate the in-page badge runtime injected into each store tab
 * (store.steampowered.com inside Steam). Simpler than the BPM badge:
 * no settings, no submit button, single fixed position at the bottom.
 *
 * Like the BPM script, the backend drives data by calling
 * `updateBadge({ report, appId })` over CDP — no in-page fetching.
 */
export function generateStoreScript(): string {
  return `
(function() {
  if (window.__protondb_store_badges) window.__protondb_store_badges.cleanup();

  var currentAppId = null;
  var badgeEl = null;

  var TIER_LABELS = { platinum:"Platinum", gold:"Gold", silver:"Silver", bronze:"Bronze", borked:"Borked", pending:"Pending" };
  var TIER_COLORS = { platinum:"#b4c7dc", gold:"#cfb53b", silver:"#a6a6a6", bronze:"#cd7f32", borked:"#ff0000", pending:"#444" };
  var TIER_TEXT = { platinum:"#000", gold:"#000", silver:"#000", bronze:"#000", borked:"#000", pending:"#fff" };

  function removeBadge() { if (badgeEl) { badgeEl.remove(); badgeEl = null; currentAppId = null; } }

  function createBadge(data) {
    var report = data.report;
    if (!report) { removeBadge(); return; }
    removeBadge();
    currentAppId = data.appId || null;
    var tier = (report.tier||"pending").toLowerCase();
    var el = document.createElement("div");
    el.id = "protondb-store-badge";
    el.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;align-items:center;padding:8px 20px;border-radius:8px;cursor:pointer;background:"+
      (TIER_COLORS[tier]||"#444")+";color:"+(TIER_TEXT[tier]||"#000")+";font-family:sans-serif;font-weight:700;box-shadow:0 2px 12px rgba(0,0,0,0.4);transition:filter 0.2s;";
    el.innerHTML='<span style="width:28px;height:28px;display:flex;align-items:center"><svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><circle cx="12" cy="12" r="2.5"/><g fill="none" stroke="currentColor" stroke-width="1.2"><ellipse cx="12" cy="12" rx="10" ry="3.5"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(-60 12 12)"/></g></svg></span><span style="margin-left:10px;font-size:24px">'+(TIER_LABELS[tier]||tier)+'</span>';
    el.addEventListener("click",function(){if(currentAppId)window.open("https://www.protondb.com/app/"+currentAppId,"_blank");});
    el.addEventListener("mouseenter",function(){el.style.filter="brightness(1.3)";});
    el.addEventListener("mouseleave",function(){el.style.filter="";});
    document.body.appendChild(el);
    badgeEl = el;
  }

  // Backend pushes data via CDP — no polling or fetch needed
  window.__protondb_store_badges = {
    cleanup: function() { removeBadge(); },
    updateBadge: function(data) { createBadge(data); },
    removeBadge: removeBadge
  };
})();
`;
}

/**
 * Generate the one-liner expression that pushes a badge payload to the
 * in-page `__protondb_badges` runtime. Used by the backend to drive
 * the BPM badge on game-detection broadcasts.
 *
 * `payload` is JSON-serialised into the expression so the produced
 * source never has to handle quote escaping for badge data.
 *
 * Pass `null` to clear the badge — emits a `removeBadge()` call instead.
 */
export function generateBPMPushExpression(
  payload: { report: unknown; linuxSupport: boolean; settings: ProtonDBSettings; appId: string } | null,
): string {
  if (!payload) {
    return `if (window.__protondb_badges) window.__protondb_badges.removeBadge();`;
  }
  return `if (window.__protondb_badges) window.__protondb_badges.updateBadge(${JSON.stringify(payload)});`;
}

/**
 * Generate the one-liner expression that pushes a store-badge payload
 * (or a clear) to the in-page `__protondb_store_badges` runtime.
 */
export function generateStorePushExpression(
  payload: { report: unknown; appId: string } | null,
): string {
  if (!payload) {
    return `if (window.__protondb_store_badges) window.__protondb_store_badges.removeBadge();`;
  }
  return `if (window.__protondb_store_badges) window.__protondb_store_badges.updateBadge(${JSON.stringify(payload)});`;
}

/**
 * Generate the expression that injects (or replaces) a stylesheet inside
 * a CEF tab. The same `styleId` lets a subsequent inject replace the
 * previous rules — we delete the existing node first so successive
 * settings updates don't pile dead `<style>` tags onto `document.head`.
 *
 * The `data-loadout-plugin` attribute is a debug breadcrumb — `document.
 * querySelectorAll('[data-loadout-plugin]')` from DevTools lists every
 * plugin-injected style node at a glance.
 */
export function generateStyleInjectionExpression(
  styleId: string,
  css: string,
): string {
  // Escape: backslash → \\, backtick → \`, $ → \$ so the CSS round-trips
  // through a tagged-template-style `\`...\`` literal in the page.
  const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `
    (function() {
      var e = document.getElementById(${JSON.stringify(styleId)});
      if (e) e.remove();
      var s = document.createElement("style");
      s.id = ${JSON.stringify(styleId)};
      s.dataset.loadoutPlugin = "protondb-badges";
      document.head.appendChild(s);
      s.textContent = \`${escaped}\`;
    })()
  `;
}

/**
 * Generate the expression that tears down both BPM and store runtimes
 * and removes the injected stylesheet from a tab. Used on unload.
 */
export function generateCleanupExpression(styleId: string): string {
  return `
    if(window.__protondb_badges) window.__protondb_badges.cleanup();
    if(window.__protondb_store_badges) window.__protondb_store_badges.cleanup();
    var s=document.getElementById(${JSON.stringify(styleId)}); if(s)s.remove();
  `;
}

/**
 * Read the `appid` out of a Steam store-tab URL. Returns `null` when the
 * URL isn't on a game-detail page (storefront, search, library, etc.).
 *
 * Exported so the backend's store-tab poller and unit tests share the
 * same parsing path.
 */
export function parseStoreAppId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/);
  return match ? match[1] : null;
}
