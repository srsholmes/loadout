/**
 * QAM (Quick Access Menu) modification utilities.
 *
 * Allows plugins to hide or modify existing QAM tabs by manipulating
 * the React fiber tree's tabs array (the same mechanism used for injection).
 *
 * These functions must be called from within the QuickAccess context
 * (e.g., from a QAM-type plugin's panel component).
 *
 * @example
 * ```ts
 * import { hideTab, modifyTab, getTabList } from "@loadout/ui/qam";
 *
 * // Hide the notifications tab
 * const unhide = hideTab("Notifications");
 *
 * // Rename a tab
 * const unmodify = modifyTab("Performance", { strTitle: "Perf" });
 *
 * // List all available tabs
 * const tabs = getTabList();
 * console.log(tabs); // [{ key: 0, strTitle: "Notifications" }, ...]
 * ```
 */

interface TabEntry {
  key: number;
  strTitle?: string;
  tab?: unknown;
  title?: unknown;
  panel?: unknown;
}

/**
 * Find the QAM tabs array by walking the React fiber tree.
 * Returns the tabs array or null if not found.
 */
function findTabsArray(): TabEntry[] | null {
  const divs = document.querySelectorAll("div");

  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    if (!div) continue;
    const keys = Object.keys(div);
    for (const key of keys) {
      if (!key.startsWith("__reactFiber")) continue;
      const fiber = (div as unknown as Record<string, unknown>)[key] as {
        memoizedProps?: { tabs?: TabEntry[]; activeTab?: unknown };
        child?: unknown;
        sibling?: unknown;
      };

      // BFS to find tabs container
      const queue = [fiber];
      let visited = 0;

      while (queue.length > 0 && visited < 500) {
        const node = queue.shift() as typeof fiber;
        if (!node) continue;
        visited++;

        if (
          node.memoizedProps &&
          Array.isArray(node.memoizedProps.tabs) &&
          node.memoizedProps.tabs.length > 0 &&
          node.memoizedProps.activeTab !== undefined
        ) {
          return node.memoizedProps.tabs;
        }

        if (node.child) queue.push(node.child as typeof fiber);
        if (node.sibling) queue.push(node.sibling as typeof fiber);
      }
    }
  }
  return null;
}

/**
 * Get a list of all current QAM tabs with their keys and titles.
 */
export function getTabList(): Array<{ key: number; title: string }> {
  const tabs = findTabsArray();
  if (!tabs) return [];
  return tabs.map((t) => ({
    key: t.key,
    title: t.strTitle ?? String(t.key),
  }));
}

/**
 * Hide an existing QAM tab by its title or key.
 * Returns an unhide function that restores the tab.
 */
export function hideTab(keyOrTitle: string | number): () => void {
  const tabs = findTabsArray();
  if (!tabs) {
    console.warn("[loadout:qam] Could not find tabs array");
    return () => {};
  }

  const idx = tabs.findIndex(
    (t) => t.key === keyOrTitle || t.strTitle === keyOrTitle,
  );
  if (idx === -1) {
    console.warn(`[loadout:qam] Tab not found: ${keyOrTitle}`);
    return () => {};
  }

  // Non-null: idx is a valid index (checked !== -1), so splice removes one entry.
  const removed = tabs.splice(idx, 1)[0]!;
  console.log(`[loadout:qam] Hidden tab: ${removed.strTitle ?? removed.key}`);

  return function unhide() {
    // Re-insert at original position (or end if tabs changed)
    const insertAt = Math.min(idx, tabs.length);
    tabs.splice(insertAt, 0, removed);
    console.log(`[loadout:qam] Restored tab: ${removed.strTitle ?? removed.key}`);
  };
}

/**
 * Modify properties of an existing QAM tab.
 * Returns a function that restores the original properties.
 */
export function modifyTab(
  keyOrTitle: string | number,
  modifications: Partial<Pick<TabEntry, "strTitle" | "tab" | "title" | "panel">>,
): () => void {
  const tabs = findTabsArray();
  if (!tabs) {
    console.warn("[loadout:qam] Could not find tabs array");
    return () => {};
  }

  const tab = tabs.find(
    (t) => t.key === keyOrTitle || t.strTitle === keyOrTitle,
  );
  if (!tab) {
    console.warn(`[loadout:qam] Tab not found: ${keyOrTitle}`);
    return () => {};
  }

  const originals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(modifications)) {
    originals[key] = (tab as unknown as Record<string, unknown>)[key];
    (tab as unknown as Record<string, unknown>)[key] = value;
  }

  console.log(`[loadout:qam] Modified tab: ${tab.strTitle ?? tab.key}`);

  return function restore() {
    for (const [key, value] of Object.entries(originals)) {
      (tab as unknown as Record<string, unknown>)[key] = value;
    }
    console.log(`[loadout:qam] Restored tab: ${tab.strTitle ?? tab.key}`);
  };
}
