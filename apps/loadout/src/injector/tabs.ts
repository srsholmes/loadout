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

const BIG_PICTURE_TITLE = "Steam Big Picture Mode";

export function isBigPictureMode(tab: CEFTab): boolean {
  // Gaming mode: "Steam Big Picture Mode"
  // Desktop BPM: "Steam" with browserType=4 in the URL
  if (tab.title === BIG_PICTURE_TITLE) return true;
  if (tab.title === "Steam" && tab.url.includes("browserType=4")) return true;
  return false;
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

const QUICK_ACCESS_PREFIX = "QuickAccess_uid";

export function isQuickAccessTab(tab: CEFTab): boolean {
  return tab.title.startsWith(QUICK_ACCESS_PREFIX);
}

/**
 * Find the active QuickAccess tab. There may be multiple (one per Steam window),
 * so we pick the one with the most content (largest div count heuristic via URL params).
 */
export async function findQuickAccessTab(options: GetTabsOptions): Promise<CEFTab> {
  const tabs = await getTabs(options);
  const qaTabs = tabs.filter(isQuickAccessTab);

  if (qaTabs.length === 0) {
    const available = tabs.map((t) => `"${t.title}" (${t.url})`).join(", ");
    throw new Error(
      `QuickAccess tab not found. Available tabs: ${available}`,
    );
  }

  // Return the first one — typically the Big Picture Mode QAM
  return qaTabs[0];
}
