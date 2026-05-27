/**
 * Expose shared modules on globalThis so plugin bundles (compiled at
 * runtime by Bun.build with vendorGlobalsPlugin / sdkGlobalPlugin)
 * can share the same React instance and UI SDK as the overlay shell.
 *
 * This MUST be imported before anything else in main.tsx.
 */
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as LoadoutUI from "@loadout/ui";
import { SpatialNavigation } from "@noriginmedia/norigin-spatial-navigation";
import * as sounds from "./lib/sounds";

globalThis.__VENDOR_REACT = React;
globalThis.__VENDOR_REACT_JSX_RUNTIME = ReactJsxRuntime;
globalThis.__VENDOR_REACT_JSX_DEV_RUNTIME = ReactJsxDevRuntime;
globalThis.__VENDOR_REACT_DOM = ReactDOM;
globalThis.__VENDOR_REACT_DOM_CLIENT = ReactDOMClient;
globalThis.__LOADOUT_SDK = LoadoutUI;
// `SpatialNavigation`'s real type has narrower parameter shapes than
// `SpatialNavBridge` (the minimal facade typed in window-globals.d.ts),
// so go via `unknown` rather than re-importing the full norigin type
// here — the bridge intentionally only exposes the surface the overlay
// + UI library use.
window.__SPATIAL_NAV__ =
  SpatialNavigation as unknown as Window["__SPATIAL_NAV__"];
window.__SL_SOUNDS__ = sounds;
