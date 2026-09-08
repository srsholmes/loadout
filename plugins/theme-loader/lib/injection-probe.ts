/**
 * DOM-side verification for injected theme CSS.
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
 * Narrow the raw `Runtime.evaluate` value to the style ids we asked
 * about.
 *
 * Anything unexpected — a CEF that returned `undefined`, a page that
 * shadowed `document.getElementById`, a stale value from another query —
 * is treated as "nothing is missing" rather than as every id missing, so
 * a malformed probe can never trigger a re-injection storm.
 */
export function parseMissingStyles(raw: unknown, styleIds: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const asked = new Set(styleIds);
  return raw.filter((v): v is string => typeof v === "string" && asked.has(v));
}
