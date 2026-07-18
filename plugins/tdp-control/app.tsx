import { useState, useEffect, useCallback, useRef } from "react";
import { FaBolt, FaMicrochip, FaGear } from "react-icons/fa6";
import {
  mountComponent,
  mountHeaderStub,
  useBackend,
  useCurrentGame,
  Button,
  Badge,
  GameCard,
  GameCardGrid,
  Spinner,
  Slider,
  SegmentedItem,
  Toggle,
  TextInput,
  PluginHeader,
  HeaderBackButton,
  IconButton,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import type { CustomDevice } from "./lib/custom-device";

export const icon = FaBolt;

interface TdpInfo {
  currentTdp: number | null;
  tdpReadSource: "read" | "tracked" | "estimated";
  minWatts: number;
  maxWatts: number;
  /** Full ceiling when plugged into AC (>= maxWatts). */
  pluggedMaxWatts: number;
  /** Ceiling when on battery (<= pluggedMaxWatts). */
  batteryMaxWatts: number;
  platform: string;
  deviceName: string;
  method: string;
  profiles: Record<string, number>;
  activeProfile: string | null;
  cpuVendor: string;
  cpuModel: string;
  scalingDriver: string;
  platformProfile: string | null;
  platformProfileChoices: string[];
  eppOptions: string[];
  currentEpp: string | null;
  governorOptions: string[];
  currentGovernor: string | null;
  supportsSmt: boolean;
  supportsCpuBoost: boolean;
  usingCustomDevice: boolean;
}

/** Human-friendly labels for TDP control methods. */
const METHOD_LABELS: Record<string, string> = {
  ryzenadj: "RyzenAdj",
  "intel-rapl": "Intel RAPL",
  platform_profile: "Platform Profile",
  none: "Not available",
};

/** Human-friendly labels for TDP read source. */
const SOURCE_LABELS: Record<string, string> = {
  read: "Read from hardware",
  tracked: "Last set value",
  estimated: "Estimated from profile",
};

/**
 * TDP Control plugin frontend.
 *
 * Provides a slider, preset buttons, and system info for adjusting CPU/APU TDP
 * on Linux handhelds. Supports multiple hardware platforms and control methods.
 */
interface SavedGameProfile {
  appId: number;
  gameName: string;
  tdpWatts: number;
  mode?: "fixed" | "targetFps";
  targetFps?: number;
  minWatts?: number;
  maxWatts?: number;
}

/** Live snapshot of the closed-loop FPS controller (getControllerState). */
interface ControllerState {
  running: boolean;
  appId: number | null;
  currentFps: number | null;
  targetFps: number | null;
  currentWatts: number | null;
  minWatts: number | null;
  maxWatts: number | null;
  settled: boolean;
  reason: string;
  mangoHudActive: boolean;
}

interface MangoHudStatus {
  installed: boolean;
  configured: boolean;
  logging: boolean;
}

const TARGET_FPS_MIN = 30;
const TARGET_FPS_MAX = 120;
const TARGET_FPS_STEP = 5;
const DEFAULT_TARGET_FPS = 60;

/** Human labels for controller reasons (badge text). */
const CONTROLLER_REASON_LABELS: Record<string, string> = {
  "warming-up": "Starting…",
  settling: "Adjusting…",
  holding: "Holding",
  climbing: "Adding power",
  reducing: "Saving power",
  floor: "At min watts",
  unreachable: "Target unreachable",
  stopped: "Stopped",
  "no-fps-source": "No FPS source",
};

function TdpControl() {
  const { call, useEvent } = useBackend("tdp-control");
  const currentGame = useCurrentGame();

  const [info, setInfo] = useState<TdpInfo | null>(null);
  const [sliderValue, setSliderValue] = useState<number>(15);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [perGameEnabled, setPerGameEnabled] = useState<boolean>(false);
  const [gameProfiles, setGameProfiles] = useState<SavedGameProfile[]>([]);
  const [controller, setController] = useState<ControllerState | null>(null);
  const [mangoHud, setMangoHud] = useState<MangoHudStatus | null>(null);
  // Landing (TDP controls) vs the settings sub-view (custom-device form),
  // reached via the header gear — mirrors the convention other plugins use.
  const [view, setView] = useState<"main" | "settings">("main");
  const debounceTimer = useRef<Timer | null>(null);
  const slidingRef = useRef(false);

  // Subscribe to TDP change events from backend
  useEvent({
    event: "tdpChanged",
    handler: (data) => {
      const { currentTdp, activeProfile, tdpReadSource } = data as {
        currentTdp: number;
        activeProfile: string | null;
        tdpReadSource: string;
      };
      setInfo((prev) =>
        prev
          ? { ...prev, currentTdp, activeProfile, tdpReadSource: tdpReadSource as TdpInfo["tdpReadSource"] }
          : prev,
      );
      // Don't reset slider while user is actively dragging
      if (!slidingRef.current) {
        setSliderValue(currentTdp);
      }
    },
  });

  // Subscribe to platform profile changes
  useEvent({
    event: "platformProfileChanged",
    handler: (data) => {
      const { platformProfile } = data as { platformProfile: string | null };
      setInfo((prev) =>
        prev ? { ...prev, platformProfile } : prev,
      );
    },
  });

  // AC power changes shift the TDP ceiling (lower on battery). Update the
  // slider's max bound; the accompanying tdpChanged event (emitted when the
  // backend re-applies the clamped/restored value) keeps the value in sync.
  useEvent({
    event: "acPowerChanged",
    handler: (data) => {
      const { maxWatts } = data as { online: boolean; maxWatts: number };
      if (typeof maxWatts === "number") {
        setInfo((prev) => (prev ? { ...prev, maxWatts } : prev));
      }
    },
  });

  // The active device changed (custom device saved/cleared) — refresh the
  // range, presets, device name, and clamp the slider into the new bounds.
  useEvent({
    event: "deviceChanged",
    handler: (data) => {
      const d = data as {
        deviceName: string;
        minWatts: number;
        maxWatts: number;
        profiles: Record<string, number>;
        usingCustomDevice: boolean;
      };
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              deviceName: d.deviceName,
              minWatts: d.minWatts,
              maxWatts: d.maxWatts,
              profiles: d.profiles,
              usingCustomDevice: d.usingCustomDevice,
            }
          : prev,
      );
      if (!slidingRef.current) {
        setSliderValue((v) => Math.max(d.minWatts, Math.min(d.maxWatts, v)));
      }
    },
  });

  // Fetch TDP info on mount
  useEffect(() => {
    call("getTdpInfo").then((result) => {
      const tdpInfo = result as TdpInfo;
      setInfo(tdpInfo);
      if (tdpInfo.currentTdp !== null) {
        setSliderValue(tdpInfo.currentTdp);
      }
    });
  }, [call]);

  // Fetch per-game profile state on mount
  useEffect(() => {
    let alive = true;
    Promise.all([call("getPerGameEnabled"), call("getGameProfiles")])
      .then(([enabled, profiles]) => {
        if (!alive) return;
        setPerGameEnabled(Boolean(enabled));
        setGameProfiles((profiles as SavedGameProfile[]) ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "perGameEnabledChanged",
    handler: (data) => {
      const { enabled } = data as { enabled: boolean };
      setPerGameEnabled(enabled);
    },
  });

  useEvent({
    event: "gameProfileChanged",
    handler: () => {
      // Re-fetch the profile list so the saved-profiles UI stays in sync.
      call("getGameProfiles")
        .then((profiles) => setGameProfiles((profiles as SavedGameProfile[]) ?? []))
        .catch(() => {});
    },
  });

  // Live FPS controller telemetry (target-FPS mode).
  useEvent({
    event: "fpsUpdate",
    handler: (data) => {
      const d = data as {
        appId: number;
        fps: number | null;
        targetFps: number | null;
        watts: number;
        settled: boolean;
        reason: string;
      };
      setController((prev) => ({
        running: true,
        appId: d.appId,
        currentFps: d.fps,
        targetFps: d.targetFps,
        currentWatts: d.watts,
        minWatts: prev?.minWatts ?? null,
        maxWatts: prev?.maxWatts ?? null,
        settled: d.settled,
        reason: d.reason,
        mangoHudActive: d.fps !== null || (prev?.mangoHudActive ?? false),
      }));
    },
  });

  useEvent({
    event: "controllerStateChanged",
    handler: (data) => {
      const d = data as { running: boolean; appId: number; reason: string };
      // Re-sync the authoritative snapshot; running=false clears the readout.
      call("getControllerState")
        .then((s) => setController(s as ControllerState))
        .catch(() => {});
      if (!d.running) {
        setController((prev) =>
          prev ? { ...prev, running: false, reason: d.reason } : prev,
        );
      }
    },
  });

  // Refresh MangoHud + controller status when the active game changes.
  const currentAppId = currentGame?.appId ?? null;
  useEffect(() => {
    let alive = true;
    if (currentAppId == null) {
      setMangoHud(null);
      return;
    }
    Promise.all([
      call("getMangoHudStatus", currentAppId),
      call("getControllerState"),
    ])
      .then(([mh, ctrl]) => {
        if (!alive) return;
        setMangoHud(mh as MangoHudStatus);
        setController(ctrl as ControllerState);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call, currentAppId]);

  const handleSetTdp = useCallback(
    async (watts: number) => {
      setApplying(true);
      setError(null);
      try {
        const result = (await call("setTdp", watts)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Failed to set TDP");
        } else {
          setInfo((prev) =>
            prev
              ? {
                  ...prev,
                  currentTdp: watts,
                  activeProfile: null,
                  tdpReadSource: "tracked" as const,
                }
              : prev,
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to set TDP");
      } finally {
        setApplying(false);
      }
    },
    [call],
  );

  const handleSliderChange = useCallback(
    (watts: number) => {
      setSliderValue(watts);
      slidingRef.current = true;

      // Debounce — only fire when user stops adjusting. When per-game is
      // on, the same release also persists the value: against the
      // running game's profile if there is one, otherwise against the
      // engine's default TDP.
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        slidingRef.current = false;
        handleSetTdp(watts);
        if (perGameEnabled) {
          if (currentGame) {
            call(
              "setGameProfile",
              currentGame.appId,
              currentGame.gameName,
              watts,
            ).catch(() => {});
          } else {
            call("setGameDefaultTdp", watts).catch(() => {});
          }
        }
      }, 500);
    },
    [handleSetTdp, perGameEnabled, currentGame, call],
  );

  const handleTogglePerGame = useCallback(
    async (next: boolean) => {
      // Optimistic — backend confirms via perGameEnabledChanged event.
      setPerGameEnabled(next);
      const result = (await call("setPerGameEnabled", next)) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        setPerGameEnabled(!next);
        setError(result.error ?? "Failed to toggle per-game profiles");
      }
    },
    [call],
  );

  // Switch the running game between fixed-TDP and target-FPS mode.
  const handleSetMode = useCallback(
    async (mode: "fixed" | "targetFps") => {
      if (!currentGame) return;
      setError(null);
      try {
        if (mode === "targetFps") {
          const existing = gameProfiles.find(
            (p) => p.appId === currentGame.appId,
          );
          const target = existing?.targetFps ?? DEFAULT_TARGET_FPS;
          // Enabling target mode needs a live FPS source — turn MangoHud on.
          if (!mangoHud?.configured) {
            await call("enableMangoHudForGame", currentGame.appId).catch(
              () => {},
            );
            await call("getMangoHudStatus", currentGame.appId)
              .then((s) => setMangoHud(s as MangoHudStatus))
              .catch(() => {});
          }
          await call(
            "setGameTargetFps",
            currentGame.appId,
            currentGame.gameName,
            target,
          );
        } else {
          await call("clearGameTargetFps", currentGame.appId);
        }
        const profiles = (await call("getGameProfiles").catch(
          () => [],
        )) as SavedGameProfile[];
        setGameProfiles(profiles);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to switch mode");
      }
    },
    [call, currentGame, gameProfiles, mangoHud],
  );

  const handleSetTargetFps = useCallback(
    async (fps: number) => {
      if (!currentGame) return;
      // Optimistic local update so the stepper feels responsive.
      setGameProfiles((prev) =>
        prev.map((p) =>
          p.appId === currentGame.appId ? { ...p, targetFps: fps } : p,
        ),
      );
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        call(
          "setGameTargetFps",
          currentGame.appId,
          currentGame.gameName,
          fps,
        ).catch(() => {});
      }, 400);
    },
    [call, currentGame],
  );

  const handleToggleMangoHud = useCallback(
    async (next: boolean) => {
      if (!currentGame) return;
      try {
        await call(
          next ? "enableMangoHudForGame" : "disableMangoHudForGame",
          currentGame.appId,
        );
        const s = (await call(
          "getMangoHudStatus",
          currentGame.appId,
        )) as MangoHudStatus;
        setMangoHud(s);
      } catch {
        /* best-effort */
      }
    },
    [call, currentGame],
  );

  const handleApplyProfile = useCallback(
    async (name: string) => {
      setApplying(true);
      setError(null);
      try {
        const result = (await call("applyProfile", name)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Failed to apply profile");
        } else if (info?.profiles[name] !== undefined) {
          const watts = info.profiles[name];
          setSliderValue(watts);
          setInfo((prev) =>
            prev
              ? {
                  ...prev,
                  currentTdp: watts,
                  activeProfile: name,
                  tdpReadSource: "tracked" as const,
                }
              : prev,
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to apply profile");
      } finally {
        setApplying(false);
      }
    },
    [call, info],
  );

  const handleSetEpp = useCallback(
    async (epp: string) => {
      setError(null);
      try {
        const result = (await call("setEpp", epp)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Failed to set EPP");
        } else {
          setInfo((prev) => (prev ? { ...prev, currentEpp: epp } : prev));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to set EPP");
      }
    },
    [call],
  );

  const handleSetGovernor = useCallback(
    async (governor: string) => {
      setError(null);
      try {
        const result = (await call("setGovernor", governor)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Failed to set governor");
        } else {
          setInfo((prev) =>
            prev ? { ...prev, currentGovernor: governor } : prev,
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to set governor");
      }
    },
    [call],
  );

  const handleSetPlatformProfile = useCallback(
    async (profile: string) => {
      setError(null);
      try {
        const result = (await call("setPlatformProfile", profile)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Failed to set platform profile");
        } else {
          setInfo((prev) =>
            prev ? { ...prev, platformProfile: profile } : prev,
          );
        }
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to set platform profile",
        );
      }
    },
    [call],
  );

  // Shared header portaled into the shell topbar: title + device subtitle,
  // with a cog on the landing view and a back button on the settings view.
  const header = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            TDP Control
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {info?.deviceName ? `${info.deviceName} · ` : ""}CPU/GPU power limits
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {view === "settings" ? (
            <HeaderBackButton
              onBack={() => setView("main")}
              title="Back to TDP Control"
            />
          ) : (
            <IconButton
              onClick={() => setView("settings")}
              title="Custom device settings"
              ariaLabel="Custom device settings"
            >
              <FaGear size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </PluginHeader>
  );

  if (!info) {
    return (
      <>
        {header}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="flex items-center justify-center h-64">
              <Spinner size={32} />
            </div>
          </div>
        </div>
      </>
    );
  }

  const isUnavailable = info.method === "none";

  // Settings sub-view: the custom-device form on its own page.
  if (view === "settings") {
    return (
      <>
        {header}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <CustomDeviceForm info={info} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {/* CURRENT TDP — main card with big centered number + slider */}
        <div className="card">
          <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaMicrochip className="w-3 h-3" /> CURRENT TDP
            </div>
            {info.activeProfile && <span className="chip chip-accent">{info.activeProfile}</span>}
          </div>
          <div className="px-6 py-7">
            <div className="flex items-baseline justify-center gap-2.5 mb-5">
              <span
                className="metric-value mono"
                style={{ fontSize: 64, color: wattColor(sliderValue, info.maxWatts) }}
              >
                {sliderValue}
              </span>
              <span className="metric-unit" style={{ fontSize: 18 }}>W</span>
            </div>
            {info.tdpReadSource !== "read" && (
              <div className="text-center subsection-desc mt-0 mb-4">
                ({SOURCE_LABELS[info.tdpReadSource] ?? info.tdpReadSource})
              </div>
            )}
            {!isUnavailable && (
              <div>
                <Slider
                  value={sliderValue}
                  onChange={handleSliderChange}
                  min={info.minWatts}
                  max={info.maxWatts}
                  step={1}
                  disabled={applying}
                />
                <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
                  <span>{info.minWatts}W</span>
                  <span>{Math.round(info.maxWatts / 2)}W</span>
                  <span>{info.maxWatts}W</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* PROFILES + GOVERNORS — single card, subsection-stacked */}
        <div className="card">
          {/* Per-Game Profiles — toggle + active-game status. The engine
              persists this entire section into ~/.config/loadout/
              plugins/tdp-control.json. When on, sliding the TDP above
              auto-saves to the running game's profile (or the engine's
              default when no game is active). */}
          {!isUnavailable && (
            <div className="subsection">
              <div className="subsection-label flex justify-between items-center">
                <span>Per-Game Profiles</span>
                <Toggle
                  checked={perGameEnabled}
                  onChange={handleTogglePerGame}
                  disabled={applying}
                />
              </div>
              <div className="subsection-desc">
                Apply a saved TDP automatically when a game launches. With this on,
                moving the slider while a game is running saves that game's profile.
              </div>

              {/* AUTO-FPS — per-game Fixed TDP vs Target FPS, shown for the
                  running game. In Target mode the controller adjusts wattage to
                  hold the chosen frame rate (MangoHud supplies live FPS). */}
              {perGameEnabled && currentGame && (
                <div style={{ marginTop: 10 }}>
                  {(() => {
                    const profile = gameProfiles.find(
                      (p) => p.appId === currentGame.appId,
                    );
                    const isTarget = profile?.mode === "targetFps";
                    const targetFps = profile?.targetFps ?? DEFAULT_TARGET_FPS;
                    const live =
                      controller &&
                      controller.appId === currentGame.appId &&
                      controller.running
                        ? controller
                        : null;
                    return (
                      <>
                        <div
                          className="segmented w-full"
                          style={{ marginBottom: 8 }}
                        >
                          <SegmentedItem
                            active={!isTarget}
                            onSelect={() => handleSetMode("fixed")}
                            disabled={applying}
                            style={{ flex: 1 }}
                          >
                            <span className="text-[13px] font-semibold">
                              Fixed TDP
                            </span>
                          </SegmentedItem>
                          <SegmentedItem
                            active={isTarget}
                            onSelect={() => handleSetMode("targetFps")}
                            disabled={applying}
                            style={{ flex: 1 }}
                          >
                            <span className="text-[13px] font-semibold">
                              Target FPS
                            </span>
                          </SegmentedItem>
                        </div>

                        {isTarget && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-baseline gap-1.5">
                                <span
                                  className="metric-value mono"
                                  style={{ fontSize: 30 }}
                                >
                                  {live?.currentFps != null
                                    ? Math.round(live.currentFps)
                                    : "--"}
                                </span>
                                <span className="metric-unit">
                                  / {targetFps} fps
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                {live?.currentWatts != null && (
                                  <span className="chip mono">
                                    {live.currentWatts}W
                                  </span>
                                )}
                                <span
                                  className={`chip ${live?.settled ? "chip-accent" : ""}`}
                                >
                                  {CONTROLLER_REASON_LABELS[
                                    live?.reason ?? "warming-up"
                                  ] ?? "…"}
                                </span>
                              </div>
                            </div>

                            <Slider
                              value={targetFps}
                              onChange={handleSetTargetFps}
                              min={TARGET_FPS_MIN}
                              max={TARGET_FPS_MAX}
                              step={TARGET_FPS_STEP}
                              disabled={applying}
                            />
                            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
                              <span>{TARGET_FPS_MIN}</span>
                              <span>{targetFps} fps target</span>
                              <span>{TARGET_FPS_MAX}</span>
                            </div>

                            <div
                              className="flex items-center justify-between"
                              style={{ marginTop: 10 }}
                            >
                              <div className="flex flex-col pr-3">
                                <span className="text-[12px] font-semibold">
                                  MangoHud logging
                                </span>
                                <span
                                  className="subsection-desc"
                                  style={{ marginTop: 0 }}
                                >
                                  {mangoHud?.installed === false
                                    ? "MangoHud not installed — install it to enable auto-FPS."
                                    : mangoHud?.logging
                                      ? "Logging FPS for this game."
                                      : mangoHud?.configured
                                        ? "Enabled — launch the game to start logging."
                                        : "Required as the live FPS source."}
                                </span>
                              </div>
                              <Toggle
                                checked={Boolean(mangoHud?.configured)}
                                onChange={handleToggleMangoHud}
                                disabled={
                                  applying || mangoHud?.installed === false
                                }
                              />
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {perGameEnabled && gameProfiles.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="subsection-desc" style={{ marginBottom: 4 }}>
                    Saved profiles ({gameProfiles.length})
                  </div>
                  {/* Cover grid — mirrors the HLTB / ProtonDB game grids
                      (issue #105). Each tile shows the game's capsule art,
                      its saved TDP as an overlay badge, and a Remove
                      action. */}
                  <GameCardGrid>
                    {gameProfiles.map((p) => {
                      const isCurrent =
                        currentGame !== null && currentGame.appId === p.appId;
                      // Wired to BOTH the card's onPick (controller A /
                      // Enter — GameCard registers the whole tile as the
                      // spatial-nav focusable) and the Remove button's
                      // onClick (mouse/touch), so the card is fully usable
                      // with a controller. See GameCard's interaction docs.
                      const removeProfile = async () => {
                        if (applying) return;
                        await call("removeGameProfile", p.appId).catch(() => {});
                        const profiles = (await call("getGameProfiles").catch(
                          () => [],
                        )) as SavedGameProfile[];
                        setGameProfiles(profiles);
                      };
                      return (
                        <GameCard
                          key={p.appId}
                          imageUrl={steamArtworkUrls(p.appId).capsule}
                          fallbackImageUrl={steamArtworkUrls(p.appId).header}
                          title={p.gameName}
                          highlighted={isCurrent}
                          onPick={removeProfile}
                          topLeftBadge={
                            isCurrent ? (
                              <span className="chip chip-accent">RUNNING</span>
                            ) : undefined
                          }
                          overlayBadges={
                            <Badge
                              variant="accent"
                              size="xs"
                              className="font-semibold"
                            >
                              <span className="mono">
                                {p.mode === "targetFps" && p.targetFps
                                  ? `${p.targetFps} FPS`
                                  : `${p.tdpWatts}W`}
                              </span>
                            </Badge>
                          }
                          action={
                            <Button
                              size="sm"
                              fullWidth
                              variant="danger"
                              onClick={removeProfile}
                              disabled={applying}
                            >
                              Remove
                            </Button>
                          }
                        />
                      );
                    })}
                  </GameCardGrid>
                </div>
              )}
            </div>
          )}

          {!isUnavailable && Object.keys(info.profiles).length > 0 && (
            <div className="subsection">
              <div className="subsection-label">Power Profile</div>
              <div className="segmented w-full">
                {Object.entries(info.profiles).map(([name, watts]) => (
                  <SegmentedItem
                    key={name}
                    active={info.activeProfile === name}
                    onSelect={() => handleApplyProfile(name)}
                    disabled={applying}
                    style={{ flex: 1 }}
                  >
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-[13px] font-semibold">{name}</span>
                      <span className="mono text-[10.5px] opacity-60 mt-0.5">{watts}W</span>
                    </span>
                  </SegmentedItem>
                ))}
              </div>
            </div>
          )}

          {info.eppOptions.length > 0 && (
            <div className="subsection">
              <div className="subsection-label">Energy Preference</div>
              <div className="segmented w-full">
                {info.eppOptions.map((epp) => (
                  <SegmentedItem
                    key={epp}
                    active={info.currentEpp === epp}
                    onSelect={() => handleSetEpp(epp)}
                    style={{ flex: 1, textTransform: "capitalize" }}
                  >
                    {epp.replace(/_/g, " ")}
                  </SegmentedItem>
                ))}
              </div>
            </div>
          )}

          {info.governorOptions.length > 0 && (
            <div className="subsection">
              <div className="subsection-label">Scaling Governor</div>
              <div className="segmented w-full">
                {info.governorOptions.map((gov) => (
                  <SegmentedItem
                    key={gov}
                    active={info.currentGovernor === gov}
                    onSelect={() => handleSetGovernor(gov)}
                    style={{ flex: 1 }}
                  >
                    {gov}
                  </SegmentedItem>
                ))}
              </div>
            </div>
          )}

          {info.platformProfileChoices.length > 0 && (
            <div className="subsection">
              <div className="subsection-label">Platform Profile (ACPI)</div>
              <div className="segmented w-full">
                {info.platformProfileChoices.map((profile) => (
                  <SegmentedItem
                    key={profile}
                    active={info.platformProfile === profile}
                    onSelect={() => handleSetPlatformProfile(profile)}
                    style={{ flex: 1, textTransform: "capitalize" }}
                  >
                    {profile}
                  </SegmentedItem>
                ))}
              </div>
            </div>
          )}

          <div className="subsection">
            <div className="subsection-label">System</div>
            <div className="row">
              <span className="row-label">Device</span>
              <span className="row-value flex items-center gap-1.5">
                {info.deviceName}
                {info.usingCustomDevice && <span className="chip chip-accent">Custom</span>}
              </span>
            </div>
            <div className="row"><span className="row-label">CPU</span>            <span className="row-value">{info.cpuModel}</span></div>
            <div className="row"><span className="row-label">Vendor</span>         <span className="row-value">{info.cpuVendor}</span></div>
            {info.scalingDriver && (
              <div className="row"><span className="row-label">Scaling driver</span><span className="row-value">{info.scalingDriver}</span></div>
            )}
            <div className="row"><span className="row-label">TDP method</span>     <span className="row-value">{METHOD_LABELS[info.method] ?? info.method}</span></div>
            <div className="row"><span className="row-label">TDP range</span>      <span className="row-value">{info.minWatts} – {info.maxWatts} W</span></div>
            {info.platformProfile && (
              <div className="row"><span className="row-label">Platform profile</span><span className="row-value">{info.platformProfile}</span></div>
            )}
          </div>
        </div>

        {error && (
          <div className="card">
            <div className="card-body p-4.5">
              <div className="subsection-label mb-1.5" style={{ color: "var(--color-error)" }}>Error</div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
        )}
        {isUnavailable && (
          <div className="card">
            <div className="card-body p-4.5">
              <div className="subsection-label mb-1.5" style={{ color: "var(--color-warning)" }}>TDP control unavailable</div>
              <div className="text-sm text-base-content/80">
                No TDP control method detected. Install ryzenadj or ensure sysfs power_cap is available.
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
}


/** Map wattage to a color: green at low, yellow at mid, red at high. */
function wattColor(watts: number, max: number): string {
  const ratio = watts / max;
  if (ratio <= 0.33) return "oklch(var(--su))";
  if (ratio <= 0.66) return "oklch(var(--wa))";
  return "oklch(var(--er))";
}

/**
 * Custom-device form. Lets users on newer/unlisted handhelds enter their own
 * TDP range + power presets (the `@loadout/devices` schema, minus the DMI
 * match). Saving persists a single custom device that becomes the default the
 * TDP control uses; "Clear" removes it and reverts to auto-detection. The
 * backend validates and, on success, emits `deviceChanged` which refreshes the
 * rest of the page.
 */
function CustomDeviceForm({ info }: { info: TdpInfo }) {
  const { call } = useBackend("tdp-control");
  // Latest detected info without making it an effect dependency — used to seed
  // the form with sensible starting values when there's no custom device.
  const infoRef = useRef(info);
  infoRef.current = info;

  const [name, setName] = useState("");
  const [minTdp, setMinTdp] = useState("");
  const [maxTdp, setMaxTdp] = useState("");
  const [batteryMaxTdp, setBatteryMaxTdp] = useState("");
  const [silent, setSilent] = useState("");
  const [balanced, setBalanced] = useState("");
  const [performance, setPerformance] = useState("");
  const [hasCustom, setHasCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fillFrom = useCallback((d: CustomDevice) => {
    setName(d.name);
    setMinTdp(String(d.minTdp));
    setMaxTdp(String(d.maxTdp));
    setBatteryMaxTdp(String(d.batteryMaxTdp));
    setSilent(String(d.profiles.Silent));
    setBalanced(String(d.profiles.Balanced));
    setPerformance(String(d.profiles.Performance));
  }, []);

  const fillFromDetected = useCallback(() => {
    const i = infoRef.current;
    // `maxWatts` is the power-state-aware *effective* cap (== battery cap when
    // on battery), so seed the true device ceiling from `pluggedMaxWatts` and
    // the battery cap from `batteryMaxWatts`. Fall back to `maxWatts` for
    // older backends that don't report the split ceilings.
    const trueMax = i.pluggedMaxWatts ?? i.maxWatts;
    const batteryMax = i.batteryMaxWatts ?? i.maxWatts;
    setName(i.deviceName && i.deviceName !== "Unknown" ? i.deviceName : "");
    setMinTdp(String(i.minWatts));
    setMaxTdp(String(trueMax));
    setBatteryMaxTdp(String(batteryMax));
    setSilent(String(i.profiles.Silent ?? i.minWatts));
    setBalanced(
      String(i.profiles.Balanced ?? Math.round((i.minWatts + trueMax) / 2)),
    );
    setPerformance(String(i.profiles.Performance ?? trueMax));
  }, []);

  // Seed the form on mount: from the saved custom device if one exists,
  // otherwise from the auto-detected device as a starting point.
  useEffect(() => {
    let alive = true;
    call("getCustomDevice")
      .then((d) => {
        if (!alive) return;
        if (d) {
          fillFrom(d as CustomDevice);
          setHasCustom(true);
        } else {
          fillFromDetected();
          setHasCustom(false);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call, fillFrom, fillFromDetected]);

  const parse = (v: string): number => (v.trim() === "" ? NaN : Number(v));

  const handleSave = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    setSaved(false);
    const device = {
      name: name.trim(),
      minTdp: parse(minTdp),
      maxTdp: parse(maxTdp),
      batteryMaxTdp: parse(batteryMaxTdp),
      profiles: {
        Silent: parse(silent),
        Balanced: parse(balanced),
        Performance: parse(performance),
      },
    };
    try {
      const res = (await call("setCustomDevice", device)) as {
        success: boolean;
        error?: string;
      };
      if (!res.success) {
        setFormError(res.error ?? "Failed to save device");
      } else {
        setHasCustom(true);
        setSaved(true);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save device");
    } finally {
      setBusy(false);
    }
  }, [call, name, minTdp, maxTdp, batteryMaxTdp, silent, balanced, performance]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    setSaved(false);
    try {
      const res = (await call("clearCustomDevice")) as {
        success: boolean;
        error?: string;
      };
      if (!res.success) {
        setFormError(res.error ?? "Failed to clear device");
      } else {
        setHasCustom(false);
        // Re-seed from the now auto-detected device.
        const detected = (await call("getTdpInfo").catch(() => null)) as
          | TdpInfo
          | null;
        if (detected) {
          infoRef.current = detected;
          fillFromDetected();
        }
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to clear device");
    } finally {
      setBusy(false);
    }
  }, [call, fillFromDetected]);

  const numberFields: Array<[string, string, (v: string) => void]> = [
    ["Min TDP (W)", minTdp, setMinTdp],
    ["Max TDP (W)", maxTdp, setMaxTdp],
    ["Battery max TDP (W)", batteryMaxTdp, setBatteryMaxTdp],
    ["Silent preset (W)", silent, setSilent],
    ["Balanced preset (W)", balanced, setBalanced],
    ["Performance preset (W)", performance, setPerformance],
  ];

  return (
    <div className="card">
      <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
        <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
          <FaMicrochip className="w-3 h-3" /> CUSTOM DEVICE
        </div>
        {hasCustom && <span className="chip chip-accent">Active</span>}
      </div>
      <div className="subsection">
        <div className="subsection-desc" style={{ marginBottom: 10 }}>
          On a newer or unlisted handheld? Enter your device's TDP range and
          power presets. Once saved it becomes the default device used by TDP
          control, overriding auto-detection. Clear it to return to
          auto-detection.
        </div>

        <div style={{ marginBottom: 10 }}>
          <div className="subsection-label" style={{ marginBottom: 4 }}>
            Device name
          </div>
          <TextInput
            value={name}
            onChange={setName}
            placeholder="My Handheld"
            disabled={busy}
          />
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          {numberFields.map(([label, value, setter]) => (
            <div key={label}>
              <div className="subsection-label" style={{ marginBottom: 4 }}>
                {label}
              </div>
              <TextInput
                value={value}
                onChange={setter}
                inputMode="numeric"
                placeholder="W"
                disabled={busy}
              />
            </div>
          ))}
        </div>

        {formError && (
          <div className="text-sm mt-3" style={{ color: "var(--color-error)" }}>
            {formError}
          </div>
        )}
        {saved && !formError && (
          <div className="text-sm mt-3" style={{ color: "oklch(var(--su))" }}>
            Custom device saved.
          </div>
        )}

        <div className="flex gap-2 mt-3.5">
          <Button variant="primary" onClick={handleSave} disabled={busy}>
            {hasCustom ? "Update device" : "Save device"}
          </Button>
          {hasCustom && (
            <Button variant="danger" onClick={handleClear} disabled={busy}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Homepage widget — TDP slider with current wattage display and preset buttons.
 */
function TdpHomeWidget() {
  const { call, useEvent } = useBackend("tdp-control");
  const currentGame = useCurrentGame();
  const [tdp, setTdp] = useState<number | null>(null);
  const [minW, setMinW] = useState(5);
  const [maxW, setMaxW] = useState(30);
  const [profiles, setProfiles] = useState<Record<string, number>>({});
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [userCustom, setUserCustom] = useState(false);
  const [error, setError] = useState(false);
  const [perGameEnabled, setPerGameEnabled] = useState(false);
  const [gameProfiles, setGameProfiles] = useState<SavedGameProfile[]>([]);
  const debounceRef = useRef<Timer | null>(null);
  const slidingRef = useRef(false);

  useEffect(() => {
    call("getTdpInfo").then((result) => {
      const info = result as TdpInfo;
      if (info.currentTdp !== null) setTdp(info.currentTdp);
      setMinW(info.minWatts);
      setMaxW(info.maxWatts);
      setProfiles(info.profiles);
      setActiveProfile(info.activeProfile);
      setDeviceName(info.deviceName);
    }).catch(() => setError(true));
  }, [call]);

  useEffect(() => {
    let alive = true;
    Promise.all([call("getPerGameEnabled"), call("getGameProfiles")])
      .then(([enabled, list]) => {
        if (!alive) return;
        setPerGameEnabled(Boolean(enabled));
        setGameProfiles((list as SavedGameProfile[]) ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "tdpChanged",
    handler: useCallback((data: unknown) => {
      const d = data as { currentTdp: number; activeProfile: string | null };
      if (!slidingRef.current) {
        setTdp(d.currentTdp);
      }
      setActiveProfile(d.activeProfile);
      if (d.activeProfile) setUserCustom(false);
    }, []),
  });

  useEvent({
    event: "acPowerChanged",
    handler: useCallback((data: unknown) => {
      const { maxWatts } = data as { online: boolean; maxWatts: number };
      if (typeof maxWatts === "number") setMaxW(maxWatts);
    }, []),
  });

  // The active device changed (custom device saved/cleared) — refresh the
  // range, presets, and device name, and clamp the shown TDP into the new
  // bounds so the widget doesn't stay stale until it remounts.
  useEvent({
    event: "deviceChanged",
    handler: useCallback((data: unknown) => {
      const d = data as {
        deviceName: string;
        minWatts: number;
        maxWatts: number;
        profiles: Record<string, number>;
      };
      setMinW(d.minWatts);
      setMaxW(d.maxWatts);
      setProfiles(d.profiles);
      setDeviceName(d.deviceName);
      if (!slidingRef.current) {
        setTdp((v) =>
          v === null ? v : Math.max(d.minWatts, Math.min(d.maxWatts, v)),
        );
      }
    }, []),
  });

  useEvent({
    event: "perGameEnabledChanged",
    handler: (data) => {
      const { enabled } = data as { enabled: boolean };
      setPerGameEnabled(enabled);
    },
  });

  useEvent({
    event: "gameProfileChanged",
    handler: () => {
      call("getGameProfiles")
        .then((list) => setGameProfiles((list as SavedGameProfile[]) ?? []))
        .catch(() => {});
    },
  });

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  if (error) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">TDP unavailable</span>
        </div>
      </div>
    );
  }

  const boundToGame = perGameEnabled && currentGame !== null;
  const savedProfile = boundToGame
    ? gameProfiles.find((p) => p.appId === currentGame!.appId)
    : undefined;
  const profileLabel = boundToGame
    ? savedProfile
      ? `Saved · ${currentGame!.gameName || `App ${currentGame!.appId}`}`
      : `Set for ${currentGame!.gameName || `App ${currentGame!.appId}`}`
    : userCustom
    ? "Custom"
    : activeProfile ?? (tdp !== null ? "Custom" : "—");

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">TDP CONTROL</div>
        <div className="chip chip-accent truncate max-w-[60%]">{profileLabel}</div>
      </div>

      <div className="flex items-baseline gap-2 mb-4.5">
        <div className="metric-value mono">{tdp !== null ? tdp : "--"}</div>
        <div className="metric-unit">W</div>
        {deviceName && (
          <div className="ml-auto mono text-[11px] text-base-content/50">{deviceName}</div>
        )}
      </div>

      {tdp !== null && (
        <Slider
          value={tdp}
          min={minW}
          max={maxW}
          step={1}
          onChange={(val) => {
            setTdp(val);
            setActiveProfile(null);
            setUserCustom(true);
            slidingRef.current = true;
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
              slidingRef.current = false;
              call("setTdp", val).catch(() => {});
              if (boundToGame) {
                call(
                  "setGameProfile",
                  currentGame!.appId,
                  currentGame!.gameName,
                  val,
                ).catch(() => {});
              }
            }, 500);
          }}
        />
      )}

      {Object.keys(profiles).length > 0 && (
        <div className="segmented w-full mt-4.5">
          {Object.entries(profiles).map(([name, watts]) => (
            <SegmentedItem
              key={name}
              active={!userCustom && activeProfile === name}
              onSelect={() => {
                call("applyProfile", name).catch(() => {});
                setTdp(watts);
                setActiveProfile(name);
                setUserCustom(false);
                if (boundToGame) {
                  call(
                    "setGameProfile",
                    currentGame!.appId,
                    currentGame!.gameName,
                    watts,
                  ).catch(() => {});
                }
              }}
              style={{ flex: 1 }}
            >
              {name}
            </SegmentedItem>
          ))}
        </div>
      )}
    </div>
  );
}

/** Full settings page — mounted by the overlay shell when the plugin opens. */
export const mount = mountComponent(TdpControl);

/** Homepage widget — TDP slider + preset buttons. */
export const mountHomeWidget = mountComponent(TdpHomeWidget);

// The header (title + device subtitle + settings cog) is portaled into the
// shell topbar from inside `mount()` via `<PluginHeader>`, so the header mount
// is just a stub whose presence tells the shell this plugin owns its topbar.
export const mountHeader = mountHeaderStub;
