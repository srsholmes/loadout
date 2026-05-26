import "./globals";

export { colors } from "./colors";

export { Button } from "./components/Button";
export type { ButtonVariant, ButtonSize } from "./components/Button";
export { IconButton } from "./components/IconButton";
export type { IconButtonVariant } from "./components/IconButton";
export { Panel } from "./components/Panel";
export { Text } from "./components/Text";
export type { TextVariant } from "./components/Text";
export { Field } from "./components/Field";
export { Toggle } from "./components/Toggle";
export { Slider } from "./components/Slider";
export { TextInput } from "./components/TextInput";
export { TabBar } from "./components/TabBar";
export { Spinner } from "./components/Spinner";

export {
  useFocusable,
  FocusContext,
  setFocus,
  getCurrentFocusKey,
  navigateByDirection,
  pauseNav,
  resumeNav,
  pushBackInterceptor,
  tryRunBackInterceptor,
} from "./spatial-nav";
export type {
  FocusableLayout,
  FocusDetails,
  UseFocusableConfig,
  UseFocusableResult,
  BackInterceptor,
} from "./spatial-nav";

export { applyFocusPulse, focusScaleClass } from "./focus-style";

export {
  ensureConnected,
  onConnect,
  call as wsCall,
  subscribe,
  getUrl as getWsUrl,
} from "./ws-client";
export type { CallArgs, SubscribeArgs } from "./ws-client";

export { BackendProvider, PluginProvider, useBackend } from "./backend";
export type { BackendApi } from "./backend";
