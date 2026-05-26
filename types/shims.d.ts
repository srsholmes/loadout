// Ambient type shims (no top-level imports/exports, so this stays a script).

declare module "three";

// eslint-disable-next-line @typescript-eslint/no-explicit-any, no-var
declare var __electrobun: any;

interface Window {
  __electroview?: { rpc?: unknown };
  // Electrobun's preload installs this; its source mutates it, so we type it
  // permissively. Restricting to `unknown` would crash electrobun's own .ts
  // source under tsc since it does `window.__electrobun!.receiveMessageFromBun = ...`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __electrobun?: any;
  __LOADOUT_REACT?: unknown;
  __LOADOUT_REACT_JSX_RUNTIME?: unknown;
  __LOADOUT_REACT_JSX_DEV_RUNTIME?: unknown;
  __LOADOUT_REACT_DOM?: unknown;
  __LOADOUT_REACT_DOM_CLIENT?: unknown;
  __LOADOUT_UI?: unknown;
}
