import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { FaBolt, FaMicrochip } from "react-icons/fa6";
import {
  PluginProvider,
  useBackend,
  useCurrentGame,
  Button,
  Spinner,
  Slider,
  SegmentedItem,
  Toggle,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";

export const icon = FaBolt;

interface TdpInfo {
  currentTdp: number | null;
  tdpReadSource: "read" | "tracked" | "estimated";
  minWatts: number;
  maxWatts: number;
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
}

function TdpControl() {
  const { call, useEvent } = useBackend("tdp-control");
  const currentGame = useCurrentGame();

  const [info, setInfo] = useState<TdpInfo | null>(null);
  const [sliderValue, setSliderValue] = useState<number>(15);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [perGameEnabled, setPerGameEnabled] = useState<boolean>(false);
  const [gameProfiles, setGameProfiles] = useState<SavedGameProfile[]>([]);
  const [defaultGameTdp, setDefaultGameTdp] = useState<number>(15);
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
    Promise.all([
      call("getPerGameEnabled"),
      call("getGameProfiles"),
      call("getGameDefaultTdp"),
    ])
      .then(([enabled, profiles, defaultTdp]) => {
        if (!alive) return;
        setPerGameEnabled(Boolean(enabled));
        setGameProfiles((profiles as SavedGameProfile[]) ?? []);
        setDefaultGameTdp(typeof defaultTdp === "number" ? defaultTdp : 15);
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
            call("setGameDefaultTdp", watts)
              .then(() => setDefaultGameTdp(watts))
              .catch(() => {});
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

  const handleRemoveActiveProfile = useCallback(async () => {
    if (!currentGame) return;
    await call("removeGameProfile", currentGame.appId).catch(() => {});
    const profiles = (await call("getGameProfiles").catch(
      () => [],
    )) as SavedGameProfile[];
    setGameProfiles(profiles);
  }, [call, currentGame]);

  const activeSavedProfile = currentGame
    ? gameProfiles.find((p) => p.appId === currentGame.appId)
    : undefined;

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

  if (!info) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  const isUnavailable = info.method === "none";

  return (
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

              {perGameEnabled && currentGame && (
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <img
                    src={steamArtworkUrls(currentGame.appId).header}
                    alt={currentGame.gameName}
                    style={{
                      width: 160,
                      height: 75,
                      objectFit: "cover",
                      borderRadius: 8,
                      background: "var(--bg-inset)",
                      flexShrink: 0,
                    }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = "hidden";
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {currentGame.gameName}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}
                    >
                      AppID {currentGame.appId}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 6,
                      }}
                    >
                      <span className="row-value mono">
                        {activeSavedProfile
                          ? `${activeSavedProfile.tdpWatts}W saved`
                          : `${defaultGameTdp}W (default)`}
                      </span>
                      {activeSavedProfile && (
                        <Button onClick={handleRemoveActiveProfile} disabled={applying}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {perGameEnabled && !currentGame && (
                <div className="subsection-desc">
                  No game running. Slider changes save to the default TDP
                  ({defaultGameTdp}W).
                </div>
              )}

              {perGameEnabled && gameProfiles.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="subsection-desc" style={{ marginBottom: 4 }}>
                    Saved profiles ({gameProfiles.length})
                  </div>
                  {gameProfiles.map((p) => (
                    <div
                      key={p.appId}
                      className="row"
                      style={{ alignItems: "center", justifyContent: "space-between" }}
                    >
                      <span className="row-label">{p.gameName}</span>
                      <span className="flex items-center gap-2.5">
                        <span className="row-value mono">{p.tdpWatts}W</span>
                        <Button
                          onClick={async () => {
                            await call("removeGameProfile", p.appId).catch(() => {});
                            const profiles = (await call("getGameProfiles").catch(
                              () => [],
                            )) as SavedGameProfile[];
                            setGameProfiles(profiles);
                          }}
                          disabled={applying}
                        >
                          Remove
                        </Button>
                      </span>
                    </div>
                  ))}
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
            <div className="row"><span className="row-label">Device</span>         <span className="row-value">{info.deviceName}</span></div>
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

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <TdpControl />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Mount the homepage widget.
 * Shows TDP slider with current wattage and preset buttons.
 */
export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <TdpHomeWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        TDP Control
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        OneXPlayer APEX · CPU/GPU power limits
      </span>
    </div>
  );
}

export function mountHeader(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <Header />
    </PluginProvider>,
  );
  return () => root.unmount();
}
