/**
 * Navigation API for Loadout plugins.
 *
 * Wraps Steam's internal Navigation singleton (discovered at runtime
 * from webpack modules and stored on globalThis.__LOADOUT_NAVIGATION).
 *
 * Usage:
 *   import { navigate, navigateBack, navigateToPage } from "@loadout/ui";
 *
 *   navigate("/loadout/my-plugin/settings");  // Go to route
 *   navigateBack();                                  // Go back
 *   navigateToPage("/loadout/my-plugin/settings"); // Close QAM + navigate
 */

declare const globalThis: Record<string, unknown> & {
  __LOADOUT_NAVIGATION?: NavigationSingleton;
};

interface NavigationSingleton {
  Navigate(path: string): void;
  NavigateBack(): void;
  CloseSideMenus(): void;
}

function getNavigation(): NavigationSingleton | null {
  const nav = globalThis.__LOADOUT_NAVIGATION;
  if (!nav) {
    console.warn(
      "[loadout] Navigation singleton not found. " +
      "Component discovery may not have run yet."
    );
    return null;
  }
  return nav;
}

/** Navigate to a Steam route path. */
export function navigate(path: string): void {
  getNavigation()?.Navigate(path);
}

/** Navigate back in Steam's history stack. */
export function navigateBack(): void {
  getNavigation()?.NavigateBack();
}

/** Close QAM/side menus. */
export function closeSideMenus(): void {
  getNavigation()?.CloseSideMenus();
}

/** Close QAM side panel, then navigate to a full-page route. */
export function navigateToPage(path: string): void {
  const nav = getNavigation();
  if (!nav) return;
  nav.CloseSideMenus();
  nav.Navigate(path);
}
