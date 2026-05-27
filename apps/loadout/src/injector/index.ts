export { SteamInjector, type InjectorOptions } from "./injector";
export { buildComponentDiscoveryScript, type SteamComponentMeta, type SteamComponentPropMeta } from "./steam-components";
export { findSharedJSContext, findBigPictureTab, findQuickAccessTab, getTabs, isSharedJSContext, isBigPictureMode, isQuickAccessTab, type CEFTab, type GetTabsOptions } from "./tabs";
export { REACT_UTILS, GET_REACT_ROOT, FIND_IN_REACT_TREE, AFTER_PATCH } from "./react-utils";
export { DISCOVER_STEAM_REACT } from "./steam-react";
export { buildMenuPatchScript, type MenuPluginEntry } from "./menu-patcher";
export { buildRoutePatchScript, type RouteEntry } from "./route-patcher";
export { createGameSessionMonitor, type GameSessionMonitor, type GameSessionEvent, type GameSessionMonitorOptions, type CreateGameSessionMonitorOptions } from "./game-session-monitor";
