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
  /** Optional: pre-#259 callers matched on title alone. Without it the Big
   *  Picture window is only found on an English client. */
  url?: string;
}

/**
 * Pattern: BPM's per-session popup tab title is `MainMenu_uid<N>`
 * where N is a small numeric session id (commonly 2). We pin the
 * regex to that exact shape — any other `MainMenu*` is rejected.
 */
const MAIN_MENU_UID_RE = /^MainMenu_uid\d+$/;

/** Pattern: QuickAccess shell + `QuickAccess_uid<N>` popup variant. */
const QUICK_ACCESS_RE = /^QuickAccess(?:_uid\d+)?$/;

/** Literal titles for the SharedJSContext / Steam Big Picture parent tabs.
 *
 *  "Steam Big Picture Mode" is Steam's `SP_WindowTitle_BigPicture`
 *  localization string, so it is translated in every non-English client and
 *  matches nothing there — "Режим Big Picture" on the Russian Deck this was
 *  reproduced on. It stays in the set as a fast path for English; the window
 *  is really found by {@link BPM_BROWSER_TYPE}. See issue #259. */
const LITERAL_TITLES = new Set<string>([
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
  "Steam Big Picture Mode",
]);

/** Steam's own marker for a Big Picture browser window, carried in the tab
 *  URL and identical in every locale:
 *  `about:blank?createflags=6292738&…&browserType=4&useragent=Valve%20Steam%20Gamepad`
 *
 *  The MainMenu / QuickAccess popups don't carry it (they are
 *  `browserviewpopup=1`), so this only ever adds the parent window — which
 *  is the tab the visible BPM UI is painted in, and therefore the one whose
 *  absence meant no theme CSS applied at all. */
const BPM_BROWSER_TYPE = "browserType=4";

export function isTargetTab(tab: CEFTabLike): boolean {
  if (tab.url?.includes(BPM_BROWSER_TYPE)) return true;
  if (LITERAL_TITLES.has(tab.title)) return true;
  if (MAIN_MENU_UID_RE.test(tab.title)) return true;
  if (QUICK_ACCESS_RE.test(tab.title)) return true;
  return false;
}
