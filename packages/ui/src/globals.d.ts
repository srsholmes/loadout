declare global {
  interface Window {
    __LOADOUT_TOKEN__?: string;
    __LOADOUT_SPATIAL_NAV?: {
      addFocusable(opts: unknown): void;
      removeFocusable(opts: { focusKey: string }): void;
      updateFocusable(focusKey: string, opts: unknown): void;
      setFocus(focusKey: string, details?: unknown): void;
      getCurrentFocusKey(): string;
      navigateByDirection(direction: string, details?: unknown): void;
      pause(): void;
      resume(): void;
      updateAllLayouts(): void;
      destroy(): void;
    };
    __LOADOUT_FOCUS_ID__?: number;
    __LOADOUT_BACK_INTERCEPTORS__?: Array<() => boolean>;
  }
}

export {};
