/**
 * TypeScript type definitions for Steam's internal React components.
 *
 * These types are hand-written based on runtime discovery of Valve's
 * webpack-bundled components. Props follow Steam's Hungarian notation:
 *   b = boolean, n = number, str = string, on = callback, rg = array
 *
 * Props may change between SteamOS versions. Use `Steam.has()` to check
 * availability at runtime before relying on a component.
 */

import type { CSSProperties, FC, ReactNode } from "react";

// ─── Buttons ───────────────────────────────────────────────────────────

export interface DialogButtonProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: (e: Event) => void;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Focus this button on mount */
  focusOnMount?: boolean;
  /** Called when activated via gamepad (A button / Enter) */
  onActivate?: (e: Event) => void;
}

/** Steam's standard dialog button — used in modals, settings panels, and toolbars */
export type DialogButtonComponent = FC<DialogButtonProps>;

/** Primary variant — typically blue/highlighted for the main action */
export type DialogButtonPrimaryComponent = FC<DialogButtonProps>;

/** Secondary variant — typically muted for cancel/back actions */
export type DialogButtonSecondaryComponent = FC<DialogButtonProps>;

// ─── Layout & Focus ────────────────────────────────────────────────────

export interface FocusableProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Called when this element is activated (A button / Enter) */
  onActivate?: (e: Event) => void;
  /** Called when cancel is pressed (B button / Escape) */
  onCancel?: (e: Event) => void;
  /** CSS class applied when this element has direct focus */
  focusClassName?: string;
  /** CSS class applied when any descendant has focus */
  focusWithinClassName?: string;
  /** Whether this element can receive gamepad/keyboard focus. Default: true */
  focusable?: boolean;
  /** Called when this element gains focus */
  onFocus?: (e: Event) => void;
  /** Called when this element loses focus */
  onBlur?: (e: Event) => void;
  /** Called when a gamepad direction is pressed */
  onGamepadDirection?: (e: Event) => void;
}

/** Wrapper that makes children focusable via gamepad/keyboard navigation */
export type FocusableComponent = FC<FocusableProps>;

export interface ScrollPanelProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Whether the scroll panel is focusable. Default: true */
  focusable?: boolean;
  /** Whether scrolling is enabled. Default: true */
  scrollable?: boolean;
}

/** Scrollable container with gamepad-aware scrolling */
export type ScrollPanelComponent = FC<ScrollPanelProps>;

// ─── Form Fields ───────────────────────────────────────────────────────

export interface SliderFieldProps {
  /** Minimum value */
  nMin?: number;
  /** Maximum value */
  nMax?: number;
  /** Step increment */
  nStep?: number;
  /** Current value */
  nValue?: number;
  /** Called when the slider value changes */
  onChange?: (value: number) => void;
  /** Label text displayed above the slider */
  label?: string;
  /** Description text shown below the label */
  description?: string;
  className?: string;
  /** Whether the field is disabled */
  disabled?: boolean;
}

/** Horizontal slider input field with label — used in Steam settings panels */
export type SliderFieldComponent = FC<SliderFieldProps>;

export interface ToggleFieldProps {
  /** Whether the toggle is checked */
  bChecked?: boolean;
  /** Called when the toggle state changes */
  onChange?: (checked: boolean) => void;
  /** Whether the field is disabled */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Description text shown below the label */
  description?: string;
  className?: string;
}

/** Toggle switch field with label — used for boolean settings */
export type ToggleFieldComponent = FC<ToggleFieldProps>;

export interface TextFieldProps {
  /** Current text value */
  value?: string;
  /** Called when the text changes */
  onChange?: (e: Event) => void;
  /** Placeholder text shown when empty */
  placeholder?: string;
  /** Label text */
  label?: string;
  /** Whether the field is disabled */
  disabled?: boolean;
  className?: string;
  /** Max length of input */
  nMaxLength?: number;
  /** Whether to use a multiline textarea */
  bMultiline?: boolean;
}

/** Text input field with label */
export type TextFieldComponent = FC<TextFieldProps>;

export interface DropdownOption {
  /** Display label for the option */
  label: string;
  /** Value identifier for the option */
  data: unknown;
}

export interface DropdownFieldProps {
  /** Array of options to display */
  rgOptions?: DropdownOption[];
  /** Currently selected option data value */
  selectedOption?: unknown;
  /** Default label shown when no option is selected */
  strDefaultLabel?: string;
  /** Called when an option is selected */
  onChange?: (option: DropdownOption) => void;
  /** Label text */
  label?: string;
  className?: string;
  /** Whether the field is disabled */
  disabled?: boolean;
}

/** Dropdown select field with label */
export type DropdownFieldComponent = FC<DropdownFieldProps>;

// ─── Dialogs & Modals ──────────────────────────────────────────────────

export interface DialogProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Dialog title */
  title?: string;
  /** Called when the dialog is cancelled */
  onCancel?: () => void;
}

/** Container for dialog content — provides Steam's dialog styling */
export type DialogComponent = FC<DialogProps>;

export interface ConfirmDialogProps {
  children?: ReactNode;
  className?: string;
  /** Text for the OK/confirm button. Default: "OK" */
  strOKButtonText?: string;
  /** Text for the cancel button. Default: "Cancel" */
  strCancelButtonText?: string;
  /** Called when OK is pressed */
  onOK?: () => void;
  /** Called when Cancel is pressed */
  onCancel?: () => void;
  /** Dialog title */
  strTitle?: string;
  /** Description body text */
  strDescription?: string;
}

/** Modal confirmation dialog with OK/Cancel buttons */
export type ConfirmDialogComponent = FC<ConfirmDialogProps>;

export interface ModalRootProps {
  children?: ReactNode;
  className?: string;
  /** Function to close this modal */
  closeModal?: () => void;
  /** Hide the main window when showing popout modals */
  bHideMainWindowForPopouts?: boolean;
}

/** Root wrapper for modal dialogs — handles backdrop and focus trapping */
export type ModalRootComponent = FC<ModalRootProps>;

// ─── Menus ─────────────────────────────────────────────────────────────

export interface MenuProps {
  children?: ReactNode;
  /** Menu title/label */
  label?: string;
  /** Called when the menu is cancelled/dismissed */
  onCancel?: () => void;
  /** Text for the cancel action */
  cancelText?: string;
  className?: string;
}

/** Context menu container */
export type MenuComponent = FC<MenuProps>;

export interface MenuItemProps {
  children?: ReactNode;
  /** Called when this menu item is selected */
  onSelected?: () => void;
  /** Whether this item is interactable. Default: true */
  bInteractableItem?: boolean;
  className?: string;
  /** Whether this item is disabled */
  disabled?: boolean;
}

/** Individual menu item within a Menu */
export type MenuItemComponent = FC<MenuItemProps>;

export interface MenuGroupProps {
  children?: ReactNode;
  /** Group label text */
  label?: string;
  className?: string;
}

/** Groups related menu items under a label */
export type MenuGroupComponent = FC<MenuGroupProps>;

// ─── Navigation ────────────────────────────────────────────────────────

export interface TabsProps {
  children?: ReactNode;
  /** Currently active tab identifier */
  activeTab?: string;
  /** Called when a tab is selected */
  onShowTab?: (tabId: string) => void;
  className?: string;
}

/** Tab navigation bar */
export type TabsComponent = FC<TabsProps>;

/** Steam's internal Navigation singleton (not a React component — an API object) */
export interface NavigationAPI {
  /** Navigate to a route path */
  Navigate(path: string): void;
  /** Navigate back in history */
  NavigateBack(): void;
  /** Close side menus (QAM, etc.) */
  CloseSideMenus(): void;
  /** Navigation manager instance */
  NavigationManager?: unknown;
}

// ─── Feedback ──────────────────────────────────────────────────────────

export interface ProgressBarProps {
  /** Progress value from 0 to 1 */
  nProgress?: number;
  /** Transition animation duration in seconds */
  nTransitionSec?: number;
  className?: string;
}

/** Horizontal progress bar */
export type ProgressBarComponent = FC<ProgressBarProps>;

export interface SteamSpinnerProps {
  /** Spinner size: "small", "medium", or "large" */
  size?: "small" | "medium" | "large";
  className?: string;
}

/** Steam's loading spinner animation */
export type SteamSpinnerComponent = FC<SteamSpinnerProps>;

// ─── Game UI ───────────────────────────────────────────────────────────

export interface GamepadUIProps {
  /** Desktop GamepadUI configuration */
  GamepadUIDesktop?: unknown;
  className?: string;
}

/** Top-level GamepadUI component */
export type GamepadUIComponent = FC<GamepadUIProps>;

// ─── SteamClient API ───────────────────────────────────────────────────

/** Type-safe interface for window.SteamClient API namespaces */
export interface SteamClientAPI {
  Apps: unknown;
  Auth: unknown;
  Broadcast: unknown;
  Browser: unknown;
  BrowserView: unknown;
  ClientNotifications: unknown;
  Cloud: unknown;
  CloudStorage: unknown;
  Compat: unknown;
  CommunityItems: unknown;
  Console: unknown;
  Customization: unknown;
  Downloads: unknown;
  FamilySharing: unknown;
  FriendSettings: unknown;
  Friends: unknown;
  GameNotes: unknown;
  GameRecording: unknown;
  GameSessions: unknown;
  Input: unknown;
  InstallFolder: unknown;
  Installs: unknown;
  MachineStorage: unknown;
  Messaging: unknown;
  Music: unknown;
  Notifications: unknown;
  OpenVR: unknown;
  Overlay: unknown;
  Parental: unknown;
  RemotePlay: unknown;
  RoamingStorage: unknown;
  Screenshots: unknown;
  ServerBrowser: unknown;
  Settings: unknown;
  SharedConnection: unknown;
  Stats: unknown;
  SteamChina: unknown;
  Storage: unknown;
  Streaming: unknown;
  System: unknown;
  UI: unknown;
  URL: unknown;
  Updates: unknown;
  User: unknown;
  WebChat: unknown;
  WebUITransport: unknown;
  Window: unknown;
  /** @internal */
  _internal: unknown;
}
