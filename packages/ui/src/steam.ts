/**
 * Lazy proxy exports for Steam's internal React components.
 *
 * These proxies defer resolution until first use, connecting to the real
 * Steam components discovered at runtime from the webpack bundle.
 *
 * Usage in plugins:
 *   import { Steam } from "@loadout/ui";
 *   // or
 *   import { DialogButton, Focusable, SliderField } from "@loadout/ui/steam";
 *
 *   function MyPanel() {
 *     return (
 *       <Steam.Focusable>
 *         <Steam.DialogButton onClick={() => {}}>Click me</Steam.DialogButton>
 *       </Steam.Focusable>
 *     );
 *   }
 *
 * If a component is not found (e.g., SteamOS update changed things),
 * a warning is logged and the proxy returns null. Only the plugin that
 * uses the missing component is affected — others keep working.
 */

import type {
  DialogButtonComponent,
  DialogButtonPrimaryComponent,
  DialogButtonSecondaryComponent,
  FocusableComponent,
  ScrollPanelComponent,
  SliderFieldComponent,
  ToggleFieldComponent,
  TextFieldComponent,
  DropdownFieldComponent,
  DialogComponent,
  ConfirmDialogComponent,
  ModalRootComponent,
  MenuComponent,
  MenuItemComponent,
  MenuGroupComponent,
  TabsComponent,
  ProgressBarComponent,
  SteamSpinnerComponent,
  GamepadUIComponent,
} from "./steam-types";

declare const globalThis: Record<string, unknown> & {
  __STEAM_COMPONENTS?: Record<string, unknown>;
};

function createSteamProxy<T extends object = Record<string, unknown>>(componentName: string): T {
  let resolved: T | null | undefined = undefined; // undefined = not yet tried

  const handler: ProxyHandler<T> = {
    apply(_target, thisArg, args) {
      if (resolved === undefined) {
        resolved = (globalThis.__STEAM_COMPONENTS?.[componentName] as T) ?? null;
        if (!resolved) {
          console.warn(
            `[loadout] Steam component "${componentName}" not found. ` +
            `It may not be available in this SteamOS version.`
          );
        }
      }
      if (!resolved || typeof resolved !== "function") return null;
      return (resolved as unknown as (...a: unknown[]) => unknown).apply(thisArg, args);
    },

    get(_target, prop, receiver) {
      // React checks these during reconciliation
      if (prop === Symbol.toPrimitive || prop === "$$typeof" || prop === Symbol.toStringTag) {
        if (resolved === undefined) {
          resolved = (globalThis.__STEAM_COMPONENTS?.[componentName] as T) ?? null;
        }
        return resolved ? Reflect.get(resolved, prop, receiver) : undefined;
      }

      // Allow typeof checks
      if (prop === "prototype") {
        if (resolved === undefined) {
          resolved = (globalThis.__STEAM_COMPONENTS?.[componentName] as T) ?? null;
        }
        return resolved ? Reflect.get(resolved, prop, receiver) : undefined;
      }

      // Lazy resolve on any other property access
      if (resolved === undefined) {
        resolved = (globalThis.__STEAM_COMPONENTS?.[componentName] as T) ?? null;
        if (!resolved) {
          console.warn(
            `[loadout] Steam component "${componentName}" not found. ` +
            `Accessed prop: ${String(prop)}`
          );
        }
      }

      if (!resolved) return undefined;
      return Reflect.get(resolved, prop, receiver);
    },
  };

  // Use a function as the proxy target so `apply` trap works (React calls components)
   
  const target = function SteamComponentProxy() {} as unknown as T;
  return new Proxy(target, handler);
}

// ---------- Buttons ----------
/** Steam's standard dialog button */
export const DialogButton = createSteamProxy<DialogButtonComponent>("DialogButton");
/** Primary dialog button — highlighted for main actions */
export const DialogButtonPrimary = createSteamProxy<DialogButtonPrimaryComponent>("DialogButtonPrimary");
/** Secondary dialog button — muted for cancel/back */
export const DialogButtonSecondary = createSteamProxy<DialogButtonSecondaryComponent>("DialogButtonSecondary");

// ---------- Layout & Focus ----------
/** Wrapper that makes children focusable via gamepad/keyboard */
export const Focusable = createSteamProxy<FocusableComponent>("Focusable");
/** Scrollable container with gamepad-aware scrolling */
export const ScrollPanel = createSteamProxy<ScrollPanelComponent>("ScrollPanel");

// ---------- Form Fields ----------
/** Horizontal slider input with label */
export const SliderField = createSteamProxy<SliderFieldComponent>("SliderField");
/** Toggle switch with label */
export const ToggleField = createSteamProxy<ToggleFieldComponent>("ToggleField");
/** Text input with label */
export const TextField = createSteamProxy<TextFieldComponent>("TextField");
/** Dropdown select with label */
export const DropdownField = createSteamProxy<DropdownFieldComponent>("DropdownField");

// ---------- Dialogs & Modals ----------
/** Dialog content container */
export const Dialog = createSteamProxy<DialogComponent>("Dialog");
/** Confirmation dialog with OK/Cancel */
export const ConfirmDialog = createSteamProxy<ConfirmDialogComponent>("ConfirmDialog");
/** Modal root wrapper with backdrop */
export const ModalRoot = createSteamProxy<ModalRootComponent>("ModalRoot");

// ---------- Menus ----------
/** Context menu container */
export const Menu = createSteamProxy<MenuComponent>("Menu");
/** Menu item */
export const MenuItem = createSteamProxy<MenuItemComponent>("MenuItem");
/** Menu item group with label */
export const MenuGroup = createSteamProxy<MenuGroupComponent>("MenuGroup");

// ---------- Navigation ----------
/** Tab navigation bar */
export const Tabs = createSteamProxy<TabsComponent>("Tabs");

// ---------- Feedback ----------
/** Horizontal progress bar */
export const ProgressBar = createSteamProxy<ProgressBarComponent>("ProgressBar");
/** Steam's loading spinner */
export const SteamSpinner = createSteamProxy<SteamSpinnerComponent>("SteamSpinner");

// ---------- Game UI ----------
/** Top-level GamepadUI component */
export const GamepadUI = createSteamProxy<GamepadUIComponent>("GamepadUI");

// ---------- Utility ----------

/**
 * Get a Steam component by name at runtime. Useful for components
 * not yet included in the named exports above.
 *
 *   const MyComponent = Steam.get("SomeInternalComponent");
 */
export function get<T = unknown>(componentName: string): T | null {
  return (globalThis.__STEAM_COMPONENTS?.[componentName] as T) ?? null;
}

/**
 * Check if a Steam component is available. Useful for conditional rendering
 * when a component may not exist in all SteamOS versions.
 *
 *   if (Steam.has("SliderField")) { ... }
 */
export function has(componentName: string): boolean {
  return componentName in (globalThis.__STEAM_COMPONENTS ?? {});
}

/**
 * Get the names of all discovered Steam components.
 */
export function listAll(): string[] {
  return Object.keys(globalThis.__STEAM_COMPONENTS ?? {});
}
