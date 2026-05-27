/**
 * Context Menu injection utilities.
 *
 * Allows plugins to add custom items to Steam's context menus
 * (right-click menus on games, library items, etc.) using the
 * afterPatch mechanism on Steam's menu components.
 *
 * @example
 * ```ts
 * import { addContextMenuItem } from "@loadout/ui/menu";
 *
 * // Add a custom item to game context menus
 * const cleanup = addContextMenuItem({
 *   id: "my-plugin-action",
 *   label: "My Custom Action",
 *   onClick: (appId) => {
 *     console.log("Action triggered for app:", appId);
 *   },
 *   position: 3, // Insert at position 3 in the menu
 * });
 *
 * // Remove on plugin unload
 * cleanup();
 * ```
 */

import { afterPatch } from "./patch";

interface MenuItemConfig {
  /** Unique ID for this menu item */
  id: string;
  /** Display label */
  label: string;
  /** Click handler. Receives context data if available. */
  onClick: (contextData?: unknown) => void;
  /** Position in the menu (0-indexed). Omit to append at end. */
  position?: number;
  /** Whether the item is disabled */
  disabled?: boolean;
}

// Track registered menu items globally
declare const globalThis: Record<string, unknown> & {
  __LOADOUT_MENU_ITEMS?: MenuItemConfig[];
  __STEAM_COMPONENTS?: Record<string, unknown>;
};

/**
 * Register a custom context menu item. It will appear in Steam's
 * context menus where applicable.
 *
 * Returns a cleanup function that removes the menu item.
 */
export function addContextMenuItem(config: MenuItemConfig): () => void {
  if (!globalThis.__LOADOUT_MENU_ITEMS) {
    globalThis.__LOADOUT_MENU_ITEMS = [];
    installMenuPatch();
  }

  globalThis.__LOADOUT_MENU_ITEMS.push(config);
  console.log(`[loadout:menu] Registered menu item: ${config.label}`);

  return function cleanup() {
    const items = globalThis.__LOADOUT_MENU_ITEMS;
    if (!items) return;
    const idx = items.findIndex((item) => item.id === config.id);
    if (idx !== -1) {
      items.splice(idx, 1);
      console.log(`[loadout:menu] Removed menu item: ${config.label}`);
    }
  };
}

let menuPatchInstalled = false;

/**
 * Install the afterPatch hook on Steam's Menu component to inject custom items.
 */
function installMenuPatch(): void {
  if (menuPatchInstalled) return;
  menuPatchInstalled = true;

  // The Menu component is discovered and available via __STEAM_COMPONENTS
  const components = globalThis.__STEAM_COMPONENTS;
  if (!components) {
    console.warn(
      "[loadout:menu] Steam components not yet discovered. " +
        "Menu injection will be available after component discovery.",
    );
    return;
  }

  const MenuComponent = components.Menu;
  if (!MenuComponent || typeof MenuComponent !== "function") {
    console.warn("[loadout:menu] Menu component not found");
    return;
  }

  const MenuItem = components.MenuItem;
  if (!MenuItem) {
    console.warn("[loadout:menu] MenuItem component not found");
    return;
  }

  // Patch the Menu component's render to inject custom items
  afterPatch(
    components as Record<string, unknown>,
    "Menu",
    (result: unknown) => {
      const items = globalThis.__LOADOUT_MENU_ITEMS;
      if (!items || items.length === 0) return;

      // Result should be React elements — we need to inject MenuItem children
      // This is a best-effort approach; the exact structure depends on Steam's version
      try {
        const React = (globalThis as Record<string, unknown>).__VENDOR_REACT as {
          createElement: (...args: unknown[]) => unknown;
          Children: { toArray: (children: unknown) => unknown[] };
        };
        if (!React) return;

        for (const item of items) {
          const menuItem = React.createElement(MenuItem as unknown, {
            key: `loadout-${item.id}`,
            onSelected: item.onClick,
            bInteractableItem: !item.disabled,
          }, item.label);

          // If result has props.children, append the item
          const resultObj = result as { props?: { children?: unknown[] } };
          if (resultObj?.props?.children && Array.isArray(resultObj.props.children)) {
            if (item.position !== undefined) {
              resultObj.props.children.splice(item.position, 0, menuItem);
            } else {
              resultObj.props.children.push(menuItem);
            }
          }
        }
      } catch (e) {
        console.error("[loadout:menu] Failed to inject menu items:", e);
      }
    },
  );

  console.log("[loadout:menu] Menu patch installed");
}
