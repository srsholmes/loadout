/**
 * Building and verifying the JavaScript that puts theme CSS into a Steam
 * CEF tab, and takes it back out.
 *
 * A live CDP socket only proves the tab still exists — it says nothing
 * about whether our `<style>` element is still in that tab's document.
 * Steam reloads the documents it hosts (during startup, and when Big
 * Picture opens or closes), which wipes every injected style while
 * leaving the CDP target, and therefore our WebSocket, perfectly
 * healthy. The only reliable check is to ask the page itself.
 *
 * These helpers are pure so the expression and its result parsing can be
 * unit-tested without a CEF to talk to.
 */

/**
 * Derive the `<style>` element id for a theme.
 *
 * The sanitising pass alone is not injective — it maps every character
 * outside `[A-Za-z0-9-_]` to `_`, so hand-installed packs `my.theme` and
 * `my_theme` would share one element: enabling both leaves one silently
 * overwriting the other, and only one of them can ever be healed or
 * removed. A short hash of the untouched id restores uniqueness while
 * keeping the readable prefix that makes these elements identifiable in
 * DevTools. (Registry ids are UUIDs, so this needs local packs to hit.)
 */
export function styleIdFor(themeId: string): string {
  // djb2. Not cryptographic — this only needs to separate ids that the
  // sanitiser collapses together.
  let hash = 5381;
  for (let i = 0; i < themeId.length; i++) {
    hash = ((hash << 5) + hash + themeId.charCodeAt(i)) >>> 0;
  }
  const safe = themeId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return `theme-loader-${safe}-${hash.toString(36)}`;
}

/**
 * Marker written into a `<style>` whose theme assembled to no CSS at all.
 *
 * `assemblePackCss` legitimately returns `""` — a manifest with an empty
 * `inject` map, or a pack whose CSS files are all missing after an
 * interrupted install. An empty `<style>` would read as "missing" to
 * {@link buildMissingStylesExpression} forever, so the pass would rebuild
 * that theme on every tick for the life of the session. Writing a comment
 * instead keeps the element non-empty and inert.
 */
export const EMPTY_CSS_MARKER = "/* theme-loader: no css */";

/**
 * Build the expression `Runtime.evaluate` runs in a tab to report which
 * of `styleIds` are not actually applying CSS right now.
 *
 * A style counts as missing when the element is absent, has been
 * detached from the document, or is present but empty — the last case
 * happens when an injection was interrupted between `appendChild` and
 * the `textContent` assignment, which leaves a marker element that would
 * otherwise read as "already themed" forever.
 */
export function buildMissingStylesExpression(styleIds: string[]): string {
  return `
    (function() {
      var ids = ${JSON.stringify(styleIds)};
      var missing = [];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (!el || !el.isConnected || !el.textContent) missing.push(ids[i]);
      }
      return missing;
    })()
  `;
}

/**
 * Build the expression that injects (or replaces) one `<style>`.
 *
 * Lives here, beside the probe it is verified by, so both the escaping
 * and the mid-load `document.head` fallback are testable without a CEF
 * to talk to.
 */
export function buildInjectStyleExpression(
  { styleId, css }: { styleId: string; css: string },
): string {
  const body = css.length > 0 ? css : EMPTY_CSS_MARKER;
  const escapedCSS = body
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
  return `
    (function() {
      let existing = document.getElementById(${JSON.stringify(styleId)});
      if (existing) existing.remove();

      let style = document.createElement("style");
      style.id = ${JSON.stringify(styleId)};
      style.classList.add("theme-loader-style");
      style.dataset.loadoutPlugin = "theme-loader";
      // <head> can still be null on a tab caught mid-load during boot;
      // documentElement always exists, and a <style> works from there.
      (document.head || document.documentElement).appendChild(style);
      style.textContent = \`${escapedCSS}\`;
    })()
  `;
}

/** Build the expression that removes one injected `<style>`. */
export function buildRemoveStyleExpression(styleId: string): string {
  return `
    (function() {
      let el = document.getElementById(${JSON.stringify(styleId)});
      if (el && el.parentNode) el.parentNode.removeChild(el);
    })()
  `;
}

/**
 * Build the expression that removes theme CSS this plugin injected but no
 * longer accounts for, returning the ids it removed.
 *
 * Removal is otherwise driven entirely by `activeThemes`, which is the
 * wrong source of truth at the one moment it matters: `disableTheme`
 * removes the style from the tabs it is *currently* connected to and then
 * deletes the entry regardless. If the connection list was empty or stale
 * at that moment — Steam restarting, or every socket dropped after failed
 * injections — the CSS stays in a tab that is about to be re-adopted, and
 * nothing ever looks at it again. The theme reads as off everywhere in
 * the model and is still on screen, and even "Reapply themes" won't clear
 * it, because that only re-injects what is active.
 *
 * Scoped to `[data-loadout-plugin="theme-loader"]` so it can never touch
 * another plugin's styles, or Steam's own.
 */
export function buildOrphanSweepExpression(expectedStyleIds: string[]): string {
  return `
    (function() {
      var keep = ${JSON.stringify(expectedStyleIds)};
      var els = document.querySelectorAll('style[data-loadout-plugin="theme-loader"]');
      var removed = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (keep.indexOf(el.id) !== -1) continue;
        removed.push(el.id);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
      return removed;
    })()
  `;
}

/**
 * Narrow the raw `Runtime.evaluate` value to the style ids we asked
 * about.
 *
 * Anything unexpected — a CEF that returned `undefined`, a page that
 * shadowed `document.getElementById`, a stale value from another query —
 * is treated as "nothing is missing" rather than as every id missing, so
 * a malformed probe can never trigger a re-injection storm.
 */
export function parseMissingStyles(
  { raw, styleIds }: { raw: unknown; styleIds: string[] },
): string[] {
  if (!Array.isArray(raw)) return [];
  const asked = new Set(styleIds);
  return raw.filter((v): v is string => typeof v === "string" && asked.has(v));
}
