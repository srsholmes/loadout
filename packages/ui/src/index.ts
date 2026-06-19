export { colors } from "./colors";
export { hideOverlay } from "./host";
export {
  LoadoutProvider,
  PluginProvider,
  mountComponent,
  mountHeaderStub,
  useBackend,
  useCurrentGame,
  GAME_DETECTION_SERVICE_ID,
} from "./sdk";
export type { CurrentGame, GameSessionRecord, PluginMountOpts } from "./sdk";
export { Alert } from "./components/Alert";
export type { AlertVariant } from "./components/Alert";
export { Panel } from "./components/Panel";
export { Text } from "./components/Text";
export { Button } from "./components/Button";
export { IconButton } from "./components/IconButton";
export type { IconButtonVariant } from "./components/IconButton";
export { HeaderBackButton, useHeaderBack } from "./components/HeaderBackButton";
export type { HeaderBackButtonProps } from "./components/HeaderBackButton";
export { SearchField } from "./components/SearchField";
export { Badge } from "./components/Badge";
export { GameCard, collectionBadgeVariant } from "./components/GameCard";
export type { GameCardProps } from "./components/GameCard";
export { NowPlaying } from "./components/NowPlaying";
export { GameHero } from "./components/GameHero";
export type { GameHeroProps } from "./components/GameHero";
export {
  friendlyCollectionName,
  collectionSearchTokens,
} from "./collection-aliases";
export { fuzzySearchGames } from "./lib/fuzzy-game-search";
export type { FuzzyGameLike } from "./lib/fuzzy-game-search";
export { useIntersectionGate } from "./hooks/useIntersectionGate";
export type { UseIntersectionGateOptions } from "./hooks/useIntersectionGate";
export { Spinner } from "./components/Spinner";
export {
  PluginHeader,
  PluginHeaderSlotProvider,
} from "./components/PluginHeader";
export { Field } from "./components/Field";
export { Toggle } from "./components/Toggle";
export { TabBar } from "./components/TabBar";
export { TextInput } from "./components/TextInput";
export { Slider } from "./components/Slider";
export { Select } from "./components/Select";
export type { SelectOption } from "./components/Select";
export { SegmentedItem } from "./components/Segmented";

// Spatial navigation — custom hook that uses local React hooks but registers
// with the shell's SpatialNavigation singleton for cross-root D-pad nav.
export { useFocusable, FocusContext, setFocus, getCurrentFocusKey, navigateByDirection, pushBackInterceptor, tryRunBackInterceptor } from "./spatial-nav";
export type { FocusableComponentLayout, FocusDetails, BackInterceptor } from "./spatial-nav";

// App-wide on-screen keyboard SDK — singleton + React hook + handler stack.
// Plugins push a custom handler to override the default DOM dispatcher.
export {
  useOverlayKeyboard,
  pushKeystrokeHandler,
  setKeyboardDefaultHandler,
  setKeyboardVisible,
  isKeyboardVisible,
  dispatchKey,
} from "./keyboard";
export type { ResolvedKey, KeystrokeHandler } from "./keyboard";

// Cross-root toast bridge — plugins dispatch a window CustomEvent
// that the shell-mounted Toaster forwards to its singleton store.
export { notify, TOAST_EVENT } from "./notify";
export type { ToastKind, NotifyOptions, ToastEventDetail } from "./notify";

export * as Steam from "./steam";
export { navigate, navigateBack, closeSideMenus, navigateToPage } from "./navigation";

// Patching API — runtime modification of Steam objects/methods
export { afterPatch, beforePatch, insteadPatch, getReactFiber, findInFiberTree } from "./patch";

// CSS injection API — modify Steam's visual appearance
export { injectCSS, injectComponentCSS, getComponentClass, getAllComponentClasses } from "./css";

// QAM modification API — hide/modify existing Quick Access Menu tabs
export { getTabList, hideTab, modifyTab } from "./qam";

// Context menu injection API — add items to Steam's right-click menus
export { addContextMenuItem } from "./menu";

export type {
  DialogButtonProps,
  FocusableProps,
  ScrollPanelProps,
  SliderFieldProps,
  ToggleFieldProps,
  TextFieldProps,
  DropdownFieldProps,
  DropdownOption,
  DialogProps,
  ConfirmDialogProps,
  ModalRootProps,
  MenuProps,
  MenuItemProps,
  MenuGroupProps,
  TabsProps,
  NavigationAPI,
  ProgressBarProps,
  SteamSpinnerProps,
  GamepadUIProps,
  SteamClientAPI,
} from "./steam-types";
