/**
 * Pure builders for the launch-options string Quick Links writes to a
 * non-Steam shortcut's `LaunchOptions`. Kept in `lib/` so the
 * substitution rules are tested without a backend mock.
 *
 * The returned string carries a `{url}` placeholder that the caller
 * substitutes per launch (or with `about:blank` at install time for
 * direct-from-Steam launches that don't pass a URL).
 */

export interface DisplayResolution {
  width: number;
  height: number;
}

/**
 * Per-browser-family launch flag template. Returns the flags that go
 * BETWEEN the browser-invocation prefix and the `{url}` placeholder.
 */
export function browserSizeFlags(
  browserId: string,
  res: DisplayResolution,
): string {
  if (browserId.includes("firefox") || browserId.includes("librewolf")) {
    // Firefox: --new-tab routes the URL into a tab in the existing
    // window when Firefox is already running (the fast-path direct-
    // exec case). Cold-start still works — Firefox makes the window
    // with a tab in it. No CLI window-sizing outside --screenshot
    // mode.
    void res; // no CLI sizing for firefox
    return "--new-tab";
  }
  // Chromium-family flags. See gaming-mode-browser commit history
  // (folded into this plugin for #121) for the rationale on each.
  return `--window-size=${res.width},${res.height} --window-position=0,0 --force-device-scale-factor=1.5`;
}

/**
 * Build a launch-options string with `{url}` placeholder. Caller
 * substitutes the placeholder per launch (or with about:blank at
 * install time for direct-from-Steam launches).
 */
export function buildLaunchOptionsBase(
  browserId: string,
  res: DisplayResolution,
  innerArgs: string,
): string {
  const flags = browserSizeFlags(browserId, res);
  return innerArgs.length > 0
    ? `${innerArgs} ${flags} {url}`
    : `${flags} {url}`;
}
