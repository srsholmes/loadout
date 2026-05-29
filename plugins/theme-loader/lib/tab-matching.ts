/**
 * CEF tab matching for CSS injection targets.
 *
 * Steam exposes a CEF debug port (8080) with `/json` listing every
 * tab. We inject CSS into a strict allowlist of titles — the
 * SharedJSContext, Big Picture Mode's parent shell, the MainMenu
 * popup that hosts the visible BPM UI, and the QuickAccess popup.
 *
 * The `MainMenu_uid<N>` popup is the only `MainMenu*` tab BPM uses
 * today (see project_css_loader_bpm_tabs.md). We pin the match to
 * the `MainMenu_uid\d+` shape so a future Valve-side tab named
 * `MainMenuSettings` (or similar) does not silently catch our CSS.
 */

export interface CEFTabLike {
  title: string;
}

/**
 * Pattern: BPM's per-session popup tab title is `MainMenu_uid<N>`
 * where N is a small numeric session id (commonly 2). We pin the
 * regex to that exact shape — any other `MainMenu*` is rejected.
 */
const MAIN_MENU_UID_RE = /^MainMenu_uid\d+$/;

/** Pattern: QuickAccess shell + `QuickAccess_uid<N>` popup variant. */
const QUICK_ACCESS_RE = /^QuickAccess(?:_uid\d+)?$/;

/** Literal titles for the SharedJSContext / Steam Big Picture parent tabs. */
const LITERAL_TITLES = new Set<string>([
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
  "Steam Big Picture Mode",
]);

export function isTargetTab(tab: CEFTabLike): boolean {
  if (LITERAL_TITLES.has(tab.title)) return true;
  if (MAIN_MENU_UID_RE.test(tab.title)) return true;
  if (QUICK_ACCESS_RE.test(tab.title)) return true;
  return false;
}
