/**
 * CSS injection utilities for plugins that want to modify Steam's
 * visual appearance.
 *
 * Works with the component discovery system — use getComponentClass()
 * to get the CSS class hash for a discovered Steam component, then
 * target it with custom styles.
 *
 * @example
 * ```ts
 * import { injectCSS, getComponentClass } from "@loadout/ui";
 *
 * // Simple CSS injection
 * const cleanup = injectCSS(`
 *   .DialogButton { border-radius: 12px !important; }
 * `);
 *
 * // Target a specific Steam component by its discovered class
 * const btnClass = getComponentClass("DialogButton");
 * if (btnClass) {
 *   injectCSS(`.${btnClass} { background: linear-gradient(45deg, #ff6b6b, #ee5a24) !important; }`);
 * }
 *
 * // Cleanup on unmount
 * cleanup();
 * ```
 */

declare const globalThis: Record<string, unknown> & {
  __STEAM_COMPONENTS_META?: Array<{
    name: string;
    cssClass?: string;
  }>;
};

let styleCounter = 0;

/**
 * Inject CSS into the current document.
 * Returns a cleanup function that removes the injected styles.
 */
export function injectCSS(css: string): () => void {
  const id = `loadout-css-${++styleCounter}`;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  style.dataset.loadout = "plugin-css";
  document.head.appendChild(style);

  return function cleanup() {
    const el = document.getElementById(id);
    if (el) el.remove();
  };
}

/**
 * Inject CSS targeting a specific Steam component by its discovered name.
 * Automatically resolves the component's CSS class hash and wraps the
 * provided CSS rules with the correct selector.
 *
 * @param componentName - Name of the Steam component (e.g., "DialogButton")
 * @param css - CSS rules to apply. Use `&` as placeholder for the component's class.
 * @returns Cleanup function, or null if the component class wasn't found.
 *
 * @example
 * ```ts
 * // Style all DialogButton instances
 * const cleanup = injectComponentCSS("DialogButton", `
 *   & { background: #ff0000 !important; }
 *   &:hover { background: #cc0000 !important; }
 * `);
 * ```
 */
export function injectComponentCSS(
  componentName: string,
  css: string,
): (() => void) | null {
  const cssClass = getComponentClass(componentName);
  if (!cssClass) {
    console.warn(
      `[loadout:css] Component "${componentName}" has no CSS class. ` +
        `It may not be available or may not use CSS modules.`,
    );
    return null;
  }

  // Replace & with the actual class selector
  const resolvedCSS = css.replace(/&/g, `.${cssClass}`);
  return injectCSS(resolvedCSS);
}

/**
 * Get the CSS class hash for a discovered Steam component.
 * Returns null if the component hasn't been discovered or doesn't use CSS modules.
 */
export function getComponentClass(componentName: string): string | null {
  const meta = globalThis.__STEAM_COMPONENTS_META;
  if (!meta) return null;

  for (const entry of meta) {
    if (entry.name === componentName && entry.cssClass) {
      return entry.cssClass;
    }
  }
  return null;
}

/**
 * Get all discovered component CSS class mappings.
 * Useful for exploring available targets.
 */
export function getAllComponentClasses(): Record<string, string> {
  const meta = globalThis.__STEAM_COMPONENTS_META;
  if (!meta) return {};

  const result: Record<string, string> = {};
  for (const entry of meta) {
    if (entry.cssClass) {
      result[entry.name] = entry.cssClass;
    }
  }
  return result;
}
