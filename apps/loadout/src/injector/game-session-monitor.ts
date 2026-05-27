/**
 * Game Session Monitor — subscribes to SteamClient.GameSessions via the CEF
 * bridge and forwards game launch/exit events so downstream consumers (e.g. the
 * TDP profile engine) can react automatically.
 *
 * The monitor injects JavaScript into Steam's SharedJSContext that registers
 * for app lifetime notifications. When a game starts or stops, the injected
 * code calls back to the Bun server's RPC endpoint which routes the event to
 * the appropriate plugin backend (tdp-control).
 */

import type { CDPClient } from "../steam-cdp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GameSessionEvent {
  type: "launch" | "exit";
  appId: number;
  gameName: string;
  timestamp: number;
}

export interface GameSessionMonitorOptions {
  onGameLaunch: (appId: number, gameName: string) => void;
  onGameExit: (appId: number, gameName: string) => void;
}

export interface GameSessionMonitor {
  /** Remove the subscription and clean up injected state. */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal: build the JS that runs inside Steam's CEF context
// ---------------------------------------------------------------------------

/**
 * Build the JS that tears down the game session subscription inside Steam's CEF.
 */
function buildCleanupScript(): string {
  return `
(function() {
  if (window.__loadoutGameSessionMonitor) {
    try {
      window.__loadoutGameSessionMonitor.stop();
    } catch (e) {
      console.warn("[loadout:game-session] Cleanup error:", e);
    }
    delete window.__loadoutGameSessionMonitor;
    return "cleaned_up";
  }
  return "nothing_to_clean";
})();
  `.trim();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateGameSessionMonitorOptions extends GameSessionMonitorOptions {
  /** The port the loadout HTTP server listens on (default: 33820) */
  loaderPort?: number;
  /** Session token for authenticating RPC calls back to the server */
  sessionToken?: string;
  /** Logger function */
  log?: (msg: string) => void;
}

/**
 * Create a game session monitor that subscribes to Steam's GameSessions API
 * via CDP and forwards launch/exit events through callbacks.
 *
 * The injected JavaScript also makes RPC calls to the server so the TDP
 * profile engine receives events even without the callback path. The
 * callbacks are fired from a CDP binding (Runtime.addBinding) so the
 * monitor can also be used for local event processing.
 */
export async function createGameSessionMonitor(
  cdp: CDPClient,
  options: CreateGameSessionMonitorOptions,
): Promise<GameSessionMonitor> {
  const {
    onGameLaunch,
    onGameExit,
    loaderPort = 33820,
    sessionToken = "",
    log = () => {},
  } = options;

  const BINDING_NAME = "__loadoutGameSessionCallback";

  // Step 1: Add a Runtime binding so injected JS can call back to us directly
  // This avoids the RPC round-trip for local callbacks.
  try {
    await cdp.send("Runtime.enable");
  } catch {
    // May already be enabled — non-fatal
  }

  try {
    await cdp.send("Runtime.addBinding", { name: BINDING_NAME });
  } catch {
    // Binding may already exist from a previous session — non-fatal
  }

  // Listen for binding calls from the injected JS
  const unsubBinding = cdp.on(
    "Runtime.bindingCalled",
    (params: Record<string, unknown>) => {
      if (params.name !== BINDING_NAME) return;
      try {
        const payload = JSON.parse(params.payload as string) as GameSessionEvent;
        if (payload.type === "launch") {
          onGameLaunch(payload.appId, payload.gameName);
        } else if (payload.type === "exit") {
          onGameExit(payload.appId, payload.gameName);
        }
      } catch (err) {
        log(`[game-session] Failed to parse binding callback: ${err}`);
      }
    },
  );

  // Step 2: Inject the subscription script into SharedJSContext
  // The script uses both: (a) fetch-based RPC for the TDP backend, and
  // (b) the Runtime binding for local callbacks.
  const script = buildGameSessionSubscriptionScript(loaderPort, sessionToken, BINDING_NAME);

  let registrationResult: unknown;
  try {
    registrationResult = await cdp.evaluate(script, { awaitPromise: false });
  } catch (err) {
    log(`[game-session] Failed to inject game session monitor: ${err}`);
    unsubBinding();
    throw err;
  }

  log(`[game-session] Registration result: ${registrationResult}`);

  // Step 3: Return cleanup handle
  return {
    cleanup: async () => {
      unsubBinding();
      try {
        if (cdp.connected) {
          await cdp.evaluate(buildCleanupScript());
        }
      } catch {
        // CDP may already be disconnected — swallow
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Full subscription script (with both RPC fetch and binding callback)
// ---------------------------------------------------------------------------

function buildGameSessionSubscriptionScript(
  _loaderPort: number,
  _sessionToken: string,
  bindingName: string,
): string {
  // Detection strategy: poll \`SteamUIStore.MainRunningApp\` every 2s and
  // emit launch/exit on appid change. This is the same pattern
  // SimpleDeckyTDP uses (against \`Router.MainRunningApp\`). The lifecycle
  // API \`SteamClient.GameSessions.RegisterForAppLifetimeNotifications\` is
  // unreliable for non-Steam shortcuts and never fires for focus switches
  // between two already-running apps; \`MainRunningApp\` is the same
  // observable Steam uses to render its focused-app UI, so it works for
  // every app type Steam knows about (Steam games, non-Steam shortcuts,
  // tools). Cross-CEF dispatch goes through the CDP \`Runtime.addBinding\`
  // callback because Steam's CEF blocks fetch() to localhost.
  return `
(function() {
  if (window.__loadoutGameSessionMonitor) {
    try { window.__loadoutGameSessionMonitor.stop(); } catch (e) {}
    delete window.__loadoutGameSessionMonitor;
  }

  if (typeof SteamUIStore === "undefined") {
    return "no_steam_ui_store";
  }

  var bindingName = ${JSON.stringify(bindingName)};
  var POLL_MS = 2000;

  function notifyBinding(type, appId, gameName) {
    try {
      if (typeof window[bindingName] === "function") {
        window[bindingName](JSON.stringify({
          type: type,
          appId: appId,
          gameName: gameName,
          timestamp: Date.now()
        }));
      }
    } catch (e) {}
  }

  function readCurrent() {
    try {
      var app = SteamUIStore.MainRunningApp;
      if (!app || !app.appid) return null;
      return {
        appId: app.appid,
        gameName: app.display_name || app.app_name || ("AppID " + app.appid)
      };
    } catch (e) {
      return null;
    }
  }

  var lastAppId = 0;
  var lastName = "";

  function tick() {
    var cur = readCurrent();
    var curId = cur ? cur.appId : 0;

    if (curId !== lastAppId) {
      if (lastAppId !== 0) {
        console.log("[loadout:game-session] Game exited: " + lastName + " (appId=" + lastAppId + ")");
        notifyBinding("exit", lastAppId, lastName);
      }
      if (curId !== 0) {
        console.log("[loadout:game-session] Game focused: " + cur.gameName + " (appId=" + curId + ")");
        notifyBinding("launch", curId, cur.gameName);
      }
      lastAppId = curId;
      lastName = cur ? cur.gameName : "";
    }
  }

  // Fire once immediately so the loader sees the currently-focused app
  // even if it's already running at injection time.
  tick();
  var intervalId = setInterval(tick, POLL_MS);

  window.__loadoutGameSessionMonitor = {
    stop: function() { clearInterval(intervalId); },
    getLast: function() { return { appId: lastAppId, name: lastName }; }
  };

  return "registered";
})();
  `.trim();
}

export { buildCleanupScript };
