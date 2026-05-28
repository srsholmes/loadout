import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { FaFan, FaTemperatureHalf, FaXmark } from "react-icons/fa6";
import {
  Button,
  IconButton,
  PluginHeader,
  PluginProvider,
  Slider,
  Spinner,
  Toggle,
  useBackend,
  useCurrentGame,
  SegmentedItem,
} from "@loadout/ui";

export const icon = FaFan;

// ---------------------------------------------------------------------------
// Types (mirroring backend output)
// ---------------------------------------------------------------------------

interface FanReading {
  index: number;
  rpm: number;
  pwm: number;
  percent: number;
}

interface TempReading {
  label: string;
  zone: string;
  tempC: number;
}

interface FanInfo {
  fans: FanReading[];
  mode: "auto" | "manual" | "full" | "unknown";
  temps: TempReading[];
  cpuTempC: number;
  chipName: string;
  fanCount: number;
  available: boolean;
  activePreset: string | null;
  usingEctool: boolean;
  warning: string | null;
  safetyEngaged: boolean;
}

type Preset = "silent" | "balanced" | "performance";

const PRESETS: { key: Preset; label: string; description: string }[] = [
  { key: "silent", label: "Silent", description: "Quiet, ramps up gently" },
  { key: "balanced", label: "Balanced", description: "Good mix of noise and cooling" },
  { key: "performance", label: "Performance", description: "Aggressive cooling" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FanGameProfile {
  appId: number;
  gameName: string;
  mode: "auto" | "manual";
  speed?: number;
}

/**
 * Shared per-game-profile plumbing for the settings page and the home
 * widget. Both surfaces load the same state, subscribe to the same two
 * backend events, and persist to the running game identically — this hook
 * is the single copy of that wiring so the two components can't drift.
 */
function usePerGameProfiles(
  call: ReturnType<typeof useBackend>["call"],
  useEvent: ReturnType<typeof useBackend>["useEvent"],
  currentGame: ReturnType<typeof useCurrentGame>,
) {
  const [perGameEnabled, setPerGameEnabled] = useState(false);
  const [gameProfiles, setGameProfiles] = useState<FanGameProfile[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([call("getPerGameEnabled"), call("getGameProfiles")])
      .then(([enabled, list]) => {
        if (!alive) return;
        setPerGameEnabled(Boolean(enabled));
        setGameProfiles((list as FanGameProfile[]) ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "perGameEnabledChanged",
    handler: (data: unknown) => {
      const { enabled } = data as { enabled: boolean };
      setPerGameEnabled(enabled);
    },
  });

  useEvent({
    event: "gameProfileChanged",
    handler: () => {
      call("getGameProfiles")
        .then((list) => setGameProfiles((list as FanGameProfile[]) ?? []))
        .catch(() => {});
    },
  });

  const boundToGame = perGameEnabled && currentGame !== null;
  const persistGameProfile = useCallback(
    (mode: "auto" | "manual", speed?: number) => {
      if (!boundToGame) return;
      call(
        "setGameProfile",
        currentGame!.appId,
        currentGame!.gameName,
        { mode, speed },
      ).catch(() => {});
    },
    [boundToGame, call, currentGame],
  );

  return {
    perGameEnabled,
    setPerGameEnabled,
    gameProfiles,
    setGameProfiles,
    boundToGame,
    persistGameProfile,
  };
}

function FanControl() {
  const { call, useEvent } = useBackend("fan-control");
  const currentGame = useCurrentGame();

  const [fanInfo, setFanInfo] = useState<FanInfo | null>(null);
  const [sliderValue, setSliderValue] = useState(50);
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [loading, setLoading] = useState(true);
  const {
    perGameEnabled,
    setPerGameEnabled,
    gameProfiles,
    setGameProfiles,
    persistGameProfile,
  } = usePerGameProfiles(call, useEvent, currentGame);
  // Banner dismissal is per-engagement: dismissing during one thermal
  // event must not silence the next one. Reset when safetyEngaged goes
  // false → true (handled in the effect below).
  const [safetyDismissed, setSafetyDismissed] = useState(false);
  const wasSafetyEngagedRef = useRef(false);

  // Subscribe to real-time fan updates from the backend
  useEvent({
    event: "fan-update",
    handler: (data) => {
      const info = data as FanInfo;
      setFanInfo(info);
      if (info.activePreset) {
        setActivePreset(info.activePreset as Preset);
      }
      setLoading(false);
    },
  });

  // Fetch initial fan info on mount
  useEffect(() => {
    call("getFanInfo").then((info) => {
      const data = info as FanInfo;
      setFanInfo(data);
      if (data.fans.length > 0) {
        setSliderValue(data.fans[0].percent);
      }
      setLoading(false);
    });
  }, [call]);

  // Reset banner dismissal on each fresh engagement (false → true edge),
  // so the alert returns next time the user gets too hot.
  useEffect(() => {
    const engaged = fanInfo?.safetyEngaged ?? false;
    if (engaged && !wasSafetyEngagedRef.current) {
      setSafetyDismissed(false);
    }
    wasSafetyEngagedRef.current = engaged;
  }, [fanInfo?.safetyEngaged]);

  const handleSetMode = useCallback(
    async (mode: "auto" | "manual") => {
      await call("setFanMode", mode);
      if (mode === "auto") {
        setActivePreset(null);
        persistGameProfile("auto");
      } else {
        persistGameProfile("manual", sliderValue);
      }
    },
    [call, persistGameProfile, sliderValue],
  );

  const handleSetSpeed = useCallback(
    async (percent: number) => {
      setSliderValue(percent);
      setActivePreset(null);
      await call("setFanSpeed", percent);
      persistGameProfile("manual", percent);
    },
    [call, persistGameProfile],
  );

  const handleApplyPreset = useCallback(
    async (preset: Preset) => {
      setActivePreset(preset);
      await call("applyPreset", preset);
      persistGameProfile("manual", sliderValue);
    },
    [call, persistGameProfile, sliderValue],
  );

  const handleTogglePerGame = useCallback(
    async (next: boolean) => {
      setPerGameEnabled(next);
      await call("setPerGameEnabled", next).catch(() => setPerGameEnabled(!next));
    },
    [call, setPerGameEnabled],
  );

  const handleRemoveProfile = useCallback(
    async (appId: number) => {
      await call("removeGameProfile", appId).catch(() => {});
      const list = (await call("getGameProfiles").catch(() => [])) as FanGameProfile[];
      setGameProfiles(list);
    },
    [call, setGameProfiles],
  );

  // Subtitle text + chip-style hint summarising hardware path —
  // computed up here so the header (rendered before the loading
  // gate) and the unavailable-state branch can both reference it.
  const headerSubtitle = (() => {
    if (!fanInfo) return "Detecting hardware…";
    if (!fanInfo.available) return "No fan hardware detected";
    if (fanInfo.chipName !== "none" && fanInfo.chipName !== "ec") {
      return `Detected: ${fanInfo.chipName}`;
    }
    if (fanInfo.usingEctool) return "Driver: ectool";
    return `Mode: ${fanInfo.mode}`;
  })();

  const isManual = fanInfo?.mode === "manual";

  // Dynamic topbar header. Auto/Manual segmented + driver subtitle
  // share state with the body via closure — same React tree, no
  // cross-root pub/sub. Hidden when the hardware probe hasn't
  // completed (`fanInfo` is null) so we don't render a segmented
  // toggle that can't yet drive anything.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Fan Control
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {headerSubtitle}
          </span>
        </div>

        {fanInfo?.available && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="segmented flex">
              <SegmentedItem
                active={!isManual}
                onSelect={() => handleSetMode("auto")}
              >
                Auto
              </SegmentedItem>
              <SegmentedItem
                active={!!isManual}
                onSelect={() => handleSetMode("manual")}
              >
                Manual
              </SegmentedItem>
            </div>
          </div>
        )}
      </div>
    </PluginHeader>
  );

  if (loading) {
    return (
      <>
        {headerNode}
        <div className="flex items-center justify-center h-64">
          <Spinner size={32} />
        </div>
      </>
    );
  }

  if (!fanInfo?.available) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="card">
              <div className="card-body p-6">
                <div className="subsection-label mb-2">No fan hardware detected</div>
                <div className="subsection-desc">
                  This plugin requires a device with accessible fan control via
                  /sys/class/hwmon or ectool.
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  const primaryFan = fanInfo.fans[0];
  const primaryTemp = fanInfo.temps.find((t) => ["cpu", "gpu", "soc"].includes(t.zone))?.tempC ?? fanInfo.cpuTempC;

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {/* Safety override banner — daisyUI alert. Shown while the
            watchdog is engaged (sticky through the WARM_C → 55 °C
            release band so it doesn't flicker as temp wobbles).
            Dismissable per-engagement: closing it silences this
            thermal event but the next one re-shows. */}
        {fanInfo.safetyEngaged && !safetyDismissed && (
          <div role="alert" className="alert alert-warning mb-4">
            <FaTemperatureHalf size={18} />
            <div className="flex-1">
              <div className="font-semibold">Safety override active</div>
              <div className="text-xs opacity-90">
                {fanInfo.warning ??
                  `Fans pinned by safety floor. Releases when CPU drops below 55°C (currently ${Math.round(fanInfo.cpuTempC)}°C).`}
              </div>
            </div>
            {/* IconButton wraps useFocusable so the dpad reaches the
                dismiss control — the previous warning card had no
                interactive element at all. */}
            <IconButton
              onClick={() => setSafetyDismissed(true)}
              ariaLabel="Dismiss safety banner"
              title="Dismiss"
              size={26}
            >
              <FaXmark size={12} />
            </IconButton>
          </div>
        )}

        {/* FAN SPEED + PRESETS — Auto/Manual toggle and driver chip
            live in the portaled topbar header. The card collapses
            entirely in Auto mode so the body shows only the live
            status / per-game cards beneath. */}
        {isManual && (
        <div className="card">
            <div className="subsection">
              <div className="flex items-center justify-between mb-3.5">
                <div className="subsection-label mb-0">Fan Speed</div>
                <span className="mono text-[13px] font-semibold" style={{ color: "var(--accent)" }}>
                  {sliderValue}%
                </span>
              </div>
              <Slider
                value={sliderValue}
                onChange={(val) => {
                  setSliderValue(val);
                  handleSetSpeed(val);
                }}
                min={15}
                max={100}
                step={5}
              />
              <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
                <span>15%</span><span>50%</span><span>100%</span>
              </div>
              <div className="subsection-desc">
                Safety: floor raises to 60% above 80°C and MAX above 85°C. Stays engaged until CPU drops below 55°C.
              </div>
            </div>

            <div className="subsection">
              <div className="subsection-label">Fan Curve Presets</div>
              <div className="segmented w-full">
                {PRESETS.map((preset) => (
                  <SegmentedItem
                    key={preset.key}
                    active={activePreset === preset.key}
                    onSelect={() => handleApplyPreset(preset.key)}
                    style={{ flex: 1 }}
                  >
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-[13px] font-semibold">{preset.label}</span>
                      <span className="text-[10.5px] opacity-60 mt-0.5">{preset.description}</span>
                    </span>
                  </SegmentedItem>
                ))}
              </div>
            </div>
        </div>
        )}

        {/* PER-GAME PROFILES */}
        <div className="card">
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div>
                <div className="subsection-label mb-0">Per-Game Profiles</div>
                <div className="subsection-desc mt-1">
                  Save fan mode and speed for the running game; auto-apply on
                  next launch.
                </div>
              </div>
              <Toggle
                checked={perGameEnabled}
                onChange={(next) => handleTogglePerGame(Boolean(next))}
              />
            </div>
            {perGameEnabled && currentGame && (
              <div className="row">
                <span className="row-label truncate">
                  Currently bound to {currentGame.gameName || `App ${currentGame.appId}`}
                </span>
                <span className="row-value capitalize">
                  {(() => {
                    const p = gameProfiles.find((x) => x.appId === currentGame.appId);
                    if (!p) return "Unsaved";
                    return p.mode === "manual" && typeof p.speed === "number"
                      ? `Manual ${p.speed}%`
                      : p.mode;
                  })()}
                </span>
              </div>
            )}
            {perGameEnabled && gameProfiles.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {gameProfiles.map((p) => (
                  <div key={p.appId} className="row">
                    <span className="row-label truncate">
                      {p.gameName || `App ${p.appId}`}
                    </span>
                    <span className="row-value capitalize">
                      {p.mode === "manual" && typeof p.speed === "number"
                        ? `Manual ${p.speed}%`
                        : p.mode}
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRemoveProfile(p.appId)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* LIVE STATUS — big tiles + rows */}
        <div className="card">
          <div className="subsection">
            <div className="subsection-label">Live Status</div>
            <div className="grid grid-cols-2 gap-2.5 mb-3.5">
              <div className="bg-base-300/50 rounded-xl px-3.5 py-4 text-center">
                <div className="metric-value mono" style={{ fontSize: 30, color: "var(--accent)" }}>
                  {primaryFan?.rpm.toLocaleString() ?? "—"}
                </div>
                <div className="metric-label mt-1">RPM</div>
              </div>
              <div className="bg-base-300/50 rounded-xl px-3.5 py-4 text-center">
                <div className="metric-value mono" style={{ fontSize: 30, color: getTempColor(primaryTemp) }}>
                  {primaryTemp}°
                </div>
                <div className="metric-label mt-1">EDGE TEMP</div>
              </div>
            </div>
            {primaryFan && !fanInfo.usingEctool && (
              <>
                <div className="row"><span className="row-label">PWM value</span><span className="row-value">{primaryFan.pwm} / 255</span></div>
                <div className="row"><span className="row-label">Fan speed</span><span className="row-value">{primaryFan.percent}%</span></div>
              </>
            )}
            <div className="row"><span className="row-label">Mode</span><span className="row-value capitalize">{fanInfo.mode}</span></div>
            {activePreset && (
              <div className="row"><span className="row-label">Active preset</span><span className="row-value capitalize">{activePreset}</span></div>
            )}
          </div>

          {fanInfo.temps.length > 0 && (
            <div className="subsection">
              <div className="subsection-label flex items-center gap-1.5">
                <FaTemperatureHalf className="w-3 h-3" /> Temperature Sensors
              </div>
              {fanInfo.temps.map((t, i) => (
                <div className="row" key={i}>
                  <span className="row-label mono text-xs">{t.label}</span>
                  <span className="flex items-center gap-2.5">
                    <span className="text-[10.5px] text-base-content/50 uppercase tracking-[0.06em]">{t.zone}</span>
                    <span className="row-value" style={{ color: getTempColor(t.tempC) }}>{t.tempC}°C</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

/** Returns a color based on temperature thresholds. Uses theme tokens
 *  so a cold CPU reads green in every theme (including light/paper). */
function getTempColor(tempC: number): string {
  if (tempC < 50) return "var(--color-success)";
  if (tempC < 70) return "var(--color-warning)";
  return "var(--color-error)";
}

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider
      parentFocusKey={opts?.parentFocusKey}
      headerSlot={opts?.headerSlot ?? null}
    >
      <FanControl />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/** Homepage widget — Loadout-styled: RPM metric, mode segmented, heat bar. */
function FanHomeWidget() {
  const { call, useEvent } = useBackend("fan-control");
  const currentGame = useCurrentGame();
  const [rpm, setRpm] = useState<number | null>(null);
  const [tempC, setTempC] = useState<number | null>(null);
  const [mode, setMode] = useState<"auto" | "manual" | "full" | "unknown">("auto");
  // Two distinct slider values:
  //   manualSpeed = the duty % the user set in Manual mode (authoritative
  //     while in Manual; preserved across mode switches so toggling
  //     auto→manual returns to the user's last setting).
  //   autoDuty = a live estimate of what the EC is actually driving in
  //     Auto mode, derived below from rpm/peakRpm (or the backend's
  //     percent field on direct hwmon paths).
  const [manualSpeed, setManualSpeed] = useState(50);
  const [autoDuty, setAutoDuty] = useState(0);
  const [, setActivePreset] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const { gameProfiles, boundToGame, persistGameProfile } = usePerGameProfiles(
    call,
    useEvent,
    currentGame,
  );
  const slidingRef = useRef(false);
  // Note on auto-mode duty: the backend can only report a live duty %
  // when it has direct hwmon PWM-register access. On ectool-only paths
  // (e.g. OXP Apex), `info.fans[0].percent` is hardcoded 0 because
  // ectool exposes RPM but not the EC's internal duty. There's no
  // device-agnostic max-RPM constant we could use to derive duty from
  // RPM (max varies per blower — Apex ~6360, Ally ~5500, Deck ~6800,
  // etc.), and tracking a peak across the session ratchets up with
  // every new high, pinning the slider at ~100 %. We accept this as a
  // platform limitation: in auto mode the **RPM number** is the live
  // indicator; the slider thumb only moves when the kernel can give
  // us a real duty %. In manual mode the slider reflects the user's
  // setting either way.

  // Compute the live auto-duty estimate from a fresh FanInfo payload.
  // Returns the backend's PWM-derived `percent` directly. Will be 0 on
  // ectool-only hardware where the EC's duty isn't readable.
  const deriveAutoDuty = useCallback((info: FanInfo): number => {
    if (!info.fans || info.fans.length === 0) return 0;
    return Math.max(0, Math.min(100, info.fans[0].percent));
  }, []);

  useEffect(() => {
    call("getFanInfo").then((result) => {
      const info = result as FanInfo;
      if (info.fans.length > 0) {
        setRpm(info.fans[0].rpm);
        // Seed manualSpeed from the live percent only if the backend
        // can actually report it (direct hwmon). On ectool we leave the
        // 50 default so the slider doesn't snap to 0 when the user
        // flips to Manual.
        const reported = info.fans[0].percent;
        if (reported > 0) setManualSpeed(reported);
        setAutoDuty(deriveAutoDuty(info));
      }
      setTempC(info.cpuTempC > 0 ? info.cpuTempC : null);
      setMode(info.mode);
      setActivePreset(info.activePreset);
    }).catch(() => setError(true));
  }, [call, deriveAutoDuty]);

  useEvent({
    event: "fan-update",
    handler: useCallback((data: unknown) => {
      const info = data as FanInfo;
      if (info.fans?.length > 0) {
        setRpm(info.fans[0].rpm);
        // Always refresh the auto-duty estimate. The render-time selector
        // below picks whether to display it (mode === "auto") or the
        // user's manualSpeed (mode === "manual"). This keeps the slider
        // ticking in auto without ever clobbering the user's manual
        // value with a derived guess that won't match their PWM%.
        setAutoDuty(deriveAutoDuty(info));
      }
      if (info.cpuTempC > 0) setTempC(info.cpuTempC);
      if (info.mode) setMode(info.mode);
      setActivePreset(info.activePreset ?? null);
    }, [deriveAutoDuty]),
  });

  if (error) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">Fan control unavailable</span>
        </div>
      </div>
    );
  }

  const displayRpm = rpm ?? 0;
  const sliderDisabled = mode !== "manual";
  // Match TDP's chip semantics so per-game state reads identically across
  // the two performance widgets.
  const savedProfile = boundToGame
    ? gameProfiles.find((p) => p.appId === currentGame!.appId)
    : undefined;
  const profileLabel = boundToGame
    ? savedProfile
      ? `Saved · ${currentGame!.gameName || `App ${currentGame!.appId}`}`
      : `Set for ${currentGame!.gameName || `App ${currentGame!.appId}`}`
    : mode === "manual"
    ? "Manual"
    : mode === "full"
    ? "Full"
    : "Auto";

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">FAN CONTROL</div>
        <div className="chip chip-accent truncate max-w-[60%]">{profileLabel}</div>
      </div>

      <div className="flex items-baseline gap-2 mb-4.5">
        <div className="metric-value mono">{displayRpm.toLocaleString()}</div>
        <div className="metric-unit">RPM</div>
        <div
          className="ml-auto mono text-[11px] text-base-content/50 inline-flex items-center gap-1"
          aria-label="CPU temperature"
        >
          <FaTemperatureHalf style={{ width: 11, height: 11 }} />
          {tempC !== null ? `${tempC}°C` : "—"}
        </div>
      </div>

      <Slider
        value={mode === "manual" ? manualSpeed : autoDuty}
        min={0}
        max={100}
        step={1}
        disabled={sliderDisabled}
        onChange={(val) => {
          slidingRef.current = true;
          setManualSpeed(val);
        }}
        onCommit={(val) => {
          slidingRef.current = false;
          setManualSpeed(val);
          call("setFanSpeed", val).catch(() => {});
          persistGameProfile("manual", val);
        }}
      />

      <div className="segmented w-full mt-4.5">
        <SegmentedItem
          active={mode === "auto"}
          onSelect={() => {
            // Optimistic — flip the local mode immediately so the slider
            // re-binds to autoDuty on the next render. The fan-update
            // event lands up to 2 s later and would otherwise leave the
            // slider stuck on the user's manual value during that gap.
            setMode("auto");
            call("setFanMode", "auto").catch(() => {});
            persistGameProfile("auto");
          }}
          style={{ flex: 1 }}
        >
          Auto
        </SegmentedItem>
        <SegmentedItem
          active={mode === "manual"}
          onSelect={() => {
            setMode("manual");
            call("setFanMode", "manual").catch(() => {});
            persistGameProfile("manual", manualSpeed);
          }}
          style={{ flex: 1 }}
        >
          Manual
        </SegmentedItem>
      </div>
    </div>
  );
}

/**
 * Mount the homepage widget.
 * Shows fan mode, speed slider, temperature, and preset buttons.
 */
export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <FanHomeWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * the Auto/Manual segmented and the live driver subtitle share the
 * body's React tree without any cross-root pub/sub.
 */
export function mountHeader(): () => void {
  return () => {};
}
