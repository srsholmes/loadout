/**
 * One-time bootstrap of the spatial-navigation singleton.
 *
 * `@loadout/ui` re-exports norigin's hooks directly. The shell bundles
 * `@loadout/ui` once (via Vite) and exposes it on `window.__LOADOUT_UI` so
 * plugin bundles get the same module. That makes the library's internal
 * `SpatialNavigation` instance a process-wide singleton — every focusable
 * component, in every React root, registers with the same focus tree.
 *
 * All this function does is call `init()` once.
 */
import { init } from "@noriginmedia/norigin-spatial-navigation";

let installed = false;

export function installSpatialNav(): void {
  if (installed) return;
  installed = true;
  init({ debug: false, visualDebug: false, shouldFocusDOMNode: true, throttle: 100 });
}
