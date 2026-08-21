/**
 * CEF tab discovery via Chrome DevTools Protocol HTTP endpoints.
 * Queries Steam's CEF debug port to find and identify browser tabs.
 */

export interface CEFTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

// Tab titles Steam uses for the SharedJSContext
const SHARED_CTX_NAMES = [
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
];

// URL patterns for the GamepadUI / Big Picture context
const GAMEPADUI_URL_PATTERNS = [
  "https://steamloopback.host/routes/",
  "https://steamloopback.host/index.html",
];

export function isSharedJSContext(tab: CEFTab): boolean {
  const titleMatch = SHARED_CTX_NAMES.includes(tab.title);
  const urlMatch = GAMEPADUI_URL_PATTERNS.some((pattern) => tab.url.includes(pattern));
  return titleMatch && urlMatch;
}

export interface GetTabsOptions {
  debugPort: number;
  /** Max time to wait for CEF to be available (ms) */
  timeout?: number;
  /** Time between retries (ms) */
  retryInterval?: number;
  onRetry?: (reason: string) => void;
}

export async function getTabs({ debugPort, timeout, retryInterval = 3000, onRetry }: GetTabsOptions): Promise<CEFTab[]> {
  const deadline = timeout ? Date.now() + timeout : Infinity;
  let logged = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${debugPort}/json`, {
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 200) {
        return (await res.json()) as CEFTab[];
      }

      throw new Error(`/json returned status ${res.status}`);
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for CEF debug port on localhost:${debugPort}: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (!logged) {
        const reason = err instanceof Error ? err.message : String(err);
        onRetry?.(`Waiting for Steam CEF on port ${debugPort}... (${reason})`);
        logged = true;
      }

      await Bun.sleep(retryInterval);
    }
  }

  throw new Error(`Timed out waiting for CEF on port ${debugPort}`);
}

export async function findSharedJSContext(options: GetTabsOptions): Promise<CEFTab> {
  const tabs = await getTabs(options);
  const tab = tabs.find(isSharedJSContext);

  if (!tab) {
    const available = tabs.map((t) => `"${t.title}" (${t.url})`).join(", ");
    throw new Error(
      `SharedJSContext tab not found. Available tabs: ${available}`,
    );
  }

  return tab;
}

// The English window title. Steam localizes it (`SP_WindowTitle_BigPicture`
// — "Режим Big Picture", "Big-Picture-Modus", "Steamin televisiotila"), so it
// is a hint, never the test. See the same note in
// packages/steam-cef-badges/src/injector.ts, and issue #259.
const BIG_PICTURE_TITLE = "Steam Big Picture Mode";
// Steam's own marker for a Big Picture browser window — locale-independent,
// and carried by both the Gaming Mode and desktop BPM shapes.
const BPM_BROWSER_TYPE = "browserType=4";
// The Steam menu / QAM / toasts are browser-view popups, each its own CEF
// target. They are chrome drawn over the UI, never the UI window itself.
const BROWSER_VIEW_POPUP_MARKER = "browserviewpopup=1";

export function isBigPictureMode(tab: CEFTab): boolean {
  if (tab.url.includes(BROWSER_VIEW_POPUP_MARKER)) return false;
  if (tab.title === BIG_PICTURE_TITLE) return true;
  return tab.url.includes(BPM_BROWSER_TYPE);
}

export async function findBigPictureTab(options: GetTabsOptions): Promise<CEFTab> {
  const tabs = await getTabs(options);
  const tab = tabs.find(isBigPictureMode);

  if (!tab) {
    const available = tabs.map((t) => `"${t.title}" (${t.url})`).join(", ");
    throw new Error(
      `Big Picture Mode tab not found. Available tabs: ${available}`,
    );
  }

  return tab;
}
