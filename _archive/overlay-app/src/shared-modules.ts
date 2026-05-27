/**
 * Expose the norigin SpatialNavigation singleton on window so plugin
 * bundles can register focusable elements in the same focus tree as
 * the overlay shell.
 *
 * Only the imperative singleton is shared — no React hooks cross the
 * boundary. Plugins use a custom useFocusable hook (in @loadout/ui)
 * that calls this singleton with their own local React hooks.
 *
 * This MUST be imported before anything else in entry.tsx.
 */
import { SpatialNavigation } from "@noriginmedia/norigin-spatial-navigation";

(window as any).__SPATIAL_NAV__ = SpatialNavigation;
