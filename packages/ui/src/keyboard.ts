// App-wide on-screen-keyboard SDK surface.
//
// Plugins (which bundle their own React) and the overlay shell (which
// has its own React root) both consume this module via
// `@loadout/ui`. The actual store lives on `window.__SL_OSK__` so
// it crosses the React-root boundary the same way the back-interceptor
// stack and spatial-nav singleton do (see ./spatial-nav.ts).
//
// The overlay shell is responsible for two things at boot:
//   1. Registering a default keystroke dispatcher (DOM-level — types
//      into `document.activeElement`) via `setKeyboardDefaultHandler`.
//   2. Mounting the actual keyboard component so `visible` has a UI.
//
// Plugins do at most one thing:
//   - Call `pushKeystrokeHandler` from a `useEffect` when their custom
//     routing should win over the default dispatcher. Returns the
//     unsubscribe; tear down on unmount or when the plugin is no longer
//     the active route.

import { useSyncExternalStore } from "react";

export type ResolvedKey =
  | { type: "char"; value: string }
  | { type: "space" }
  | { type: "backspace" }
  | { type: "enter" };

/** Return `true` to consume the keystroke. Void / false falls through
 *  to the next handler down the stack and finally the default. */
export type KeystrokeHandler = (k: ResolvedKey) => boolean | void;

interface OskStore {
  visible: boolean;
  handlers: KeystrokeHandler[];
  defaultHandler: KeystrokeHandler | null;
  listeners: Set<() => void>;
  setVisible(v: boolean): void;
  toggle(): void;
  pushHandler(fn: KeystrokeHandler): () => void;
  setDefaultHandler(fn: KeystrokeHandler | null): void;
  dispatch(k: ResolvedKey): void;
  subscribe(cb: () => void): () => void;
}

declare global {
  interface Window {
    __SL_OSK__?: OskStore;
  }
}

function getStore(): OskStore {
  if (typeof window === "undefined") {
    return makeNoopStore();
  }
  if (window.__SL_OSK__) return window.__SL_OSK__;
  const store = makeStore();
  window.__SL_OSK__ = store;
  return store;
}

function makeStore(): OskStore {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  const store: OskStore = {
    visible: false,
    handlers: [],
    defaultHandler: null,
    listeners,
    setVisible(v) {
      if (this.visible === v) return;
      this.visible = v;
      notify();
    },
    toggle() {
      this.setVisible(!this.visible);
    },
    pushHandler(fn) {
      this.handlers.push(fn);
      return () => {
        const idx = this.handlers.indexOf(fn);
        if (idx >= 0) this.handlers.splice(idx, 1);
      };
    },
    setDefaultHandler(fn) {
      this.defaultHandler = fn;
    },
    dispatch(k) {
      // Walk handlers end → start; first to return `true` consumes.
      for (let i = this.handlers.length - 1; i >= 0; i--) {
        try {
          if (this.handlers[i](k) === true) return;
        } catch (err) {
          console.warn("[osk] handler threw", err);
        }
      }
      // Default fallback — set by the overlay shell at boot.
      try {
        this.defaultHandler?.(k);
      } catch (err) {
        console.warn("[osk] default handler threw", err);
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return store;
}

function makeNoopStore(): OskStore {
  return {
    visible: false,
    handlers: [],
    defaultHandler: null,
    listeners: new Set(),
    setVisible() {},
    toggle() {},
    pushHandler: () => () => {},
    setDefaultHandler() {},
    dispatch() {},
    subscribe: () => () => {},
  };
}

/** React hook — returns visibility plus open/close imperatives. */
export function useOverlayKeyboard(): {
  visible: boolean;
  setVisible(v: boolean): void;
  toggle(): void;
} {
  const store = getStore();
  const visible = useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.visible,
    () => false,
  );
  return {
    visible,
    setVisible: (v) => store.setVisible(v),
    toggle: () => store.toggle(),
  };
}

/** Register a custom keystroke handler. The most recently pushed
 *  handler that returns `true` consumes the keystroke. Returns the
 *  unsubscribe function — call on unmount. */
export function pushKeystrokeHandler(fn: KeystrokeHandler): () => void {
  return getStore().pushHandler(fn);
}

/** Overlay-shell-only: register the default keystroke dispatcher
 *  (DOM mutation against `document.activeElement`). Call once at boot. */
export function setKeyboardDefaultHandler(
  fn: KeystrokeHandler | null,
): void {
  getStore().setDefaultHandler(fn);
}

/** Imperative API used by the keyboard component itself to deliver
 *  keystrokes to the store. */
export function dispatchKey(k: ResolvedKey): void {
  getStore().dispatch(k);
}

/** Imperative show/hide — for non-React paths (focusin listeners,
 *  hotkey handlers, plugin host-message handlers). */
export function setKeyboardVisible(v: boolean): void {
  getStore().setVisible(v);
}

export function isKeyboardVisible(): boolean {
  return getStore().visible;
}
