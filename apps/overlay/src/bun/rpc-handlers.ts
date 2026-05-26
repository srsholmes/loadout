// RPC handler factory for the overlay's BrowserView.defineRPC surface.
// M1 surface only:
//   - show / hide / toggle (drive triple-flag overlay state)
//   - isGamescopeMode
//   - getControllerShortcuts / setControllerShortcuts
//   - getOverlayVisibility
//
// Steam-restart / system-shutdown / sound-file reads are deferred to a
// later milestone when their plugins land.

import type { Ref } from "./lifecycle";
import type { ControllerShortcuts } from "../webview/lib/electrobun";
import { validateSetControllerShortcutsParams } from "./rpc-validation";
import {
  requestShow,
  requestHide,
  requestToggle,
  type OverlayState,
} from "./lib/overlay-state";

export interface RpcHandlerDeps {
  state: OverlayState;
  shortcuts: Ref<ControllerShortcuts>;
  gamescopeMode: boolean;
}

export function buildRpcHandlers(deps: RpcHandlerDeps) {
  return {
    requests: {
      show: async () => {
        requestShow(deps.state);
      },
      hide: async () => {
        requestHide(deps.state);
      },
      toggle: async (): Promise<boolean> => requestToggle(deps.state),
      isGamescopeMode: async () => deps.gamescopeMode,
      getControllerShortcuts: async () => deps.shortcuts.current,
      setControllerShortcuts: async (params?: unknown) => {
        const next = validateSetControllerShortcutsParams(params);
        if (next === null) {
          console.warn("[overlay] setControllerShortcuts ignored — malformed payload", params);
          return;
        }
        deps.shortcuts.current = next;
      },
      getOverlayVisibility: async (): Promise<{ isOpen: boolean }> => ({
        isOpen: deps.state.isOpen,
      }),
    },
    messages: {},
  };
}
