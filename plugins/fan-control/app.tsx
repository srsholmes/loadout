import { useState, useEffect, useCallback, useRef } from "react";
import {
  FaFan,
  FaTemperatureHalf,
  FaPlus,
  FaTrashCan,
  FaArrowRotateLeft,
  FaChevronLeft,
  FaChevronRight,
} from "react-icons/fa6";
import {
  Alert,
  Badge,
  Button,
  Collapse,
  GameCard,
  GameCardGrid,
  IconButton,
  PluginHeader,
  Slider,
  Spinner,
  Toggle,
  mountComponent,
  mountHeaderStub,
  useBackend,
  useCurrentGame,
  SegmentedItem,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import { FAN_CURVES, type FanCurvePoint } from "./lib/fan-curves";
import {
  CURVE_MAX_POINTS,
  CURVE_MIN_POINTS,
  CURVE_TEMP_MAX,
  CURVE_TEMP_MIN,
  DEFAULT_CUSTOM_CURVE,
} from "./lib/custom-curve";
import { FanCurveGraph } from "./components/FanCurveGraph";

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
  customCurveActive: boolean;
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
      // boundToGame already implies currentGame is non-null; the explicit
      // check just narrows the type without changing the early-return outcome.
      if (!boundToGame || currentGame === null) return;
      call(
        "setGameProfile",
        currentGame.appId,
        currentGame.gameName,
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
  const [customActive, setCustomActive] = useState(false);
  const [customPoints, setCustomPoints] = useState<FanCurvePoint[]>(() =>
    DEFAULT_CUSTOM_CURVE.map((p) => ({ ...p })),
  );
  const [selectedPoint, setSelectedPoint] = useState(0);
  const [loading, setLoading] = useState(true);
  const {
    perGameEnabled,
    setPerGameEnabled,
    gameProfiles,
    setGameProfiles,
    persistGameProfile,
  } = usePerGameProfiles(call, useEvent, currentGame);
  // Subscribe to real-time fan updates from the backend
  useEvent({
    event: "fan-update",
    handler: (data) => {
      const info = data as FanInfo;
      setFanInfo(info);
      // Each tick only asserts a positive selection (preset XOR custom),
      // never clears to "none" — the click handlers own clearing, so a
      // stale 2 s-cadence event can't wipe an optimistic selection.
      if (info.activePreset) {
        setActivePreset(info.activePreset as Preset);
        setCustomActive(false);
      }
      if (info.customCurveActive) {
        setCustomActive(true);
        setActivePreset(null);
      }
      setLoading(false);
    },
  });

  // Fetch initial fan info + the saved custom curve on mount.
  useEffect(() => {
    call("getFanInfo").then((info) => {
      const data = info as FanInfo;
      setFanInfo(data);
      const primary = data.fans[0];
      if (primary) {
        setSliderValue(primary.percent);
      }
      setActivePreset(data.activePreset ? (data.activePreset as Preset) : null);
      setCustomActive(Boolean(data.customCurveActive));
      setLoading(false);
    });
    call("getCustomCurve")
      .then((pts) => {
        const curve = pts as FanCurvePoint[];
        if (Array.isArray(curve) && curve.length >= CURVE_MIN_POINTS) {
          setCustomPoints(curve);
        }
      })
      .catch(() => {});
  }, [call]);

  const handleSetMode = useCallback(
    async (mode: "auto" | "manual") => {
      await call("setFanMode", mode);
      if (mode === "auto") {
        setActivePreset(null);
        setCustomActive(false);
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
      setCustomActive(false);
      await call("setFanSpeed", percent);
      persistGameProfile("manual", percent);
    },
    [call, persistGameProfile],
  );

  const handleApplyPreset = useCallback(
    async (preset: Preset) => {
      setActivePreset(preset);
      setCustomActive(false);
      await call("applyPreset", preset);
      persistGameProfile("manual", sliderValue);
    },
    [call, persistGameProfile, sliderValue],
  );

  const handleSelectCustom = useCallback(async () => {
    setActivePreset(null);
    setCustomActive(true);
    await call("applyCustomCurve").catch(() => {});
    persistGameProfile("manual", sliderValue);
  }, [call, persistGameProfile, sliderValue]);

  // Persist edited points to the backend. setCustomCurve sanitises and
  // returns the canonical curve, which we adopt so the UI never drifts
  // from what's stored / running (e.g. a dropped duplicate point).
  const commitCustomPoints = useCallback(
    async (pts: FanCurvePoint[]) => {
      setCustomPoints(pts);
      const res = (await call("setCustomCurve", pts).catch(() => null)) as
        | { curve?: FanCurvePoint[] }
        | null;
      const curve = res?.curve;
      if (curve && Array.isArray(curve)) {
        setCustomPoints(curve);
        setSelectedPoint((i) => Math.min(i, curve.length - 1));
      }
    },
    [call],
  );

  // Live edit of one point's temp/percent. The curve maths live in pure
  // module helpers; here we just push the result to state and (on commit)
  // persist — no side effects inside the setState updater, so a Strict /
  // concurrent re-render can't double-fire the backend write.
  const updatePoint = useCallback(
    ({
      index,
      next,
      commit,
    }: {
      index: number;
      next: Partial<FanCurvePoint>;
      commit: boolean;
    }) => {
      const pts = editCurvePoint(customPoints, index, next);
      setCustomPoints(pts);
      if (commit) void commitCustomPoints(pts);
    },
    [customPoints, commitCustomPoints],
  );

  const handleAddPoint = useCallback(() => {
    if (customPoints.length >= CURVE_MAX_POINTS) return;
    const { points: pts, index } = insertCurvePoint(customPoints);
    setCustomPoints(pts);
    setSelectedPoint(index);
    void commitCustomPoints(pts);
  }, [customPoints, commitCustomPoints]);

  const handleRemovePoint = useCallback(() => {
    if (customPoints.length <= CURVE_MIN_POINTS) return;
    const pts = customPoints.filter((_, i) => i !== selectedPoint);
    setCustomPoints(pts);
    setSelectedPoint((i) => Math.min(i, pts.length - 1));
    void commitCustomPoints(pts);
  }, [customPoints, selectedPoint, commitCustomPoints]);

  const handleResetCurve = useCallback(() => {
    setSelectedPoint(0);
    void commitCustomPoints(DEFAULT_CUSTOM_CURVE.map((p) => ({ ...p })));
  }, [commitCustomPoints]);

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
        {/* Safety override banner. Non-dismissable: this is the
            thermal-trip safeguard message and the user needs to know
            the floor is engaged + the release temp the whole time the
            override is biting. Sticky through the WARM_C → 55 °C
            release hysteresis so it doesn't flicker as temp wobbles. */}
        {fanInfo.safetyEngaged && (
          <Alert
            variant="warning"
            icon={<FaTemperatureHalf size={18} />}
            title="Safety override active"
          >
            {fanInfo.warning ??
              `Fans pinned by safety floor. Releases when CPU drops below 55°C (currently ${Math.round(fanInfo.cpuTempC)}°C).`}
          </Alert>
        )}

        {/* LIVE STATUS (top) — fan RPM + edge-temp tiles and status rows,
            full width. Temperature sensors live in their own collapsible
            box further down. */}
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
        </div>

        {/* FAN SPEED + PRESETS (Manual only) — the Auto/Manual toggle lives
            in the portaled topbar header. */}
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
                    active={!customActive && activePreset === preset.key}
                    onSelect={() => handleApplyPreset(preset.key)}
                    style={{ flex: 1 }}
                  >
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-[13px] font-semibold">{preset.label}</span>
                      <span className="text-[10.5px] opacity-60 mt-0.5">{preset.description}</span>
                    </span>
                  </SegmentedItem>
                ))}
                <SegmentedItem
                  active={customActive}
                  onSelect={handleSelectCustom}
                  style={{ flex: 1 }}
                >
                  <span className="flex flex-col items-center leading-tight">
                    <span className="text-[13px] font-semibold">Custom</span>
                    <span className="text-[10.5px] opacity-60 mt-0.5">Your own curve</span>
                  </span>
                </SegmentedItem>
              </div>
            </div>

            {/* PRESET CURVE PREVIEW — the same graph, read-only, so the
                user can see the shape of the selected built-in preset
                without being able to edit it. Switching to Custom swaps in
                the editable editor below. */}
            {!customActive && activePreset && (
              <div className="subsection">
                <div className="subsection-label mb-3">
                  {PRESETS.find((p) => p.key === activePreset)?.label ?? "Preset"} Curve
                </div>
                <div className="bg-base-300/40 rounded-xl p-3">
                  <FanCurveGraph
                    points={FAN_CURVES[activePreset]}
                    currentTempC={primaryTemp}
                    editable={false}
                  />
                </div>
                <div className="subsection-desc mt-2.5">
                  Preview of the {PRESETS.find((p) => p.key === activePreset)?.label ?? "preset"} curve
                  (read-only). The dashed line marks the current temperature — pick Custom to draw your own.
                </div>
              </div>
            )}

            {/* CUSTOM CURVE EDITOR — graph + per-point sliders. Pointer
                users drag nodes on the graph; gamepad users select a node
                and edit it with the two sliders below. */}
            {customActive && (
              <div className="subsection">
                {(() => {
                  const sel = customPoints[selectedPoint] ?? customPoints[0];
                  if (!sel) return null;
                  const prev =
                    selectedPoint > 0
                      ? customPoints[selectedPoint - 1]
                      : undefined;
                  const next =
                    selectedPoint < customPoints.length - 1
                      ? customPoints[selectedPoint + 1]
                      : undefined;
                  const minTemp = prev ? prev.tempC + 1 : CURVE_TEMP_MIN;
                  const maxTemp = next ? next.tempC - 1 : CURVE_TEMP_MAX;
                  return (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <div className="subsection-label mb-0">Custom Curve</div>
                        <Button
                          size="sm"
                          variant="neutral"
                          onClick={handleResetCurve}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <FaArrowRotateLeft className="w-3 h-3" /> Reset
                          </span>
                        </Button>
                      </div>

                      <div className="bg-base-300/40 rounded-xl p-3 mb-3.5">
                        <FanCurveGraph
                          points={customPoints}
                          selectedIndex={selectedPoint}
                          currentTempC={primaryTemp}
                          onSelectPoint={setSelectedPoint}
                          onChangePoint={(i, p) =>
                            updatePoint({ index: i, next: p, commit: false })
                          }
                          onCommit={() => commitCustomPoints(customPoints)}
                        />
                      </div>

                      {/* Point selector */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <IconButton
                            ariaLabel="Previous point"
                            title="Previous point"
                            onClick={() =>
                              setSelectedPoint((i) => Math.max(0, i - 1))
                            }
                            disabled={selectedPoint <= 0}
                          >
                            <FaChevronLeft className="w-3 h-3" />
                          </IconButton>
                          <span className="mono text-[12px] text-base-content/70 min-w-[64px] text-center">
                            Point {selectedPoint + 1} / {customPoints.length}
                          </span>
                          <IconButton
                            ariaLabel="Next point"
                            title="Next point"
                            onClick={() =>
                              setSelectedPoint((i) =>
                                Math.min(customPoints.length - 1, i + 1),
                              )
                            }
                            disabled={selectedPoint >= customPoints.length - 1}
                          >
                            <FaChevronRight className="w-3 h-3" />
                          </IconButton>
                        </div>
                        <div className="flex items-center gap-2">
                          <IconButton
                            ariaLabel="Add point"
                            title="Add point"
                            variant="accent"
                            onClick={handleAddPoint}
                            disabled={customPoints.length >= CURVE_MAX_POINTS}
                          >
                            <FaPlus className="w-3 h-3" />
                          </IconButton>
                          <IconButton
                            ariaLabel="Remove point"
                            title="Remove point"
                            variant="danger"
                            onClick={handleRemovePoint}
                            disabled={customPoints.length <= CURVE_MIN_POINTS}
                          >
                            <FaTrashCan className="w-3 h-3" />
                          </IconButton>
                        </div>
                      </div>

                      {/* Selected-point editing */}
                      <div className="mb-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[12px] text-base-content/70">
                            Temperature
                          </span>
                          <span className="mono text-[12px] font-semibold">
                            {sel.tempC}°C
                          </span>
                        </div>
                        <Slider
                          value={sel.tempC}
                          min={minTemp}
                          max={maxTemp}
                          step={1}
                          onChange={(val) =>
                            updatePoint({ index: selectedPoint, next: { tempC: val }, commit: false })
                          }
                          onCommit={(val) =>
                            updatePoint({ index: selectedPoint, next: { tempC: val }, commit: true })
                          }
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[12px] text-base-content/70">
                            Fan speed
                          </span>
                          <span
                            className="mono text-[12px] font-semibold"
                            style={{ color: "var(--accent)" }}
                          >
                            {sel.percent}%
                          </span>
                        </div>
                        <Slider
                          value={sel.percent}
                          min={0}
                          max={100}
                          step={1}
                          onChange={(val) =>
                            updatePoint({ index: selectedPoint, next: { percent: val }, commit: false })
                          }
                          onCommit={(val) =>
                            updatePoint({ index: selectedPoint, next: { percent: val }, commit: true })
                          }
                        />
                      </div>

                      <div className="subsection-desc mt-2.5">
                        Drag points on the graph, or pick a point and use the
                        sliders. The dashed line marks the current temperature.
                        The safety floor still overrides the curve above 75°C.
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
        </div>
        )}

        {/* TEMPERATURE SENSORS — collapsible box, closed by default so the
            page stays compact; expand to see per-zone readings. */}
        {fanInfo.temps.length > 0 && (
          <Collapse
            ariaLabel="Toggle temperature sensors"
            title={
              // Matches the .subsection-label look (10.5px uppercase) but
              // without its margin-bottom, which would break the header's
              // vertical centering.
              <span
                className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]"
                style={{ color: "var(--fg-3)" }}
              >
                <FaTemperatureHalf className="w-3 h-3" /> Temperature Sensors
              </span>
            }
          >
            {fanInfo.temps.map((t, i) => (
              <div className="row" key={i}>
                <span className="row-label mono text-xs">{t.label}</span>
                <span className="flex items-center gap-2.5">
                  <span className="text-[10.5px] text-base-content/50 uppercase tracking-[0.06em]">{t.zone}</span>
                  <span className="row-value" style={{ color: getTempColor(t.tempC) }}>{t.tempC}°C</span>
                </span>
              </div>
            ))}
          </Collapse>
        )}

        {/* PER-GAME PROFILES — at the end, full width. */}
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
            {perGameEnabled && gameProfiles.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="subsection-desc" style={{ marginBottom: 4 }}>
                  Saved profiles ({gameProfiles.length})
                </div>
                {/* Cover grid — mirrors the TDP Control per-game grid
                    (game capsule art, a RUNNING chip for the active game,
                    the saved fan setting as an overlay badge, and a Remove
                    action). Wired to BOTH the card's onPick (controller A /
                    Enter) and the Remove button's onClick so it's fully
                    usable with a gamepad. */}
                <GameCardGrid>
                  {gameProfiles.map((p) => {
                    const isCurrent =
                      currentGame !== null && currentGame.appId === p.appId;
                    const removeProfile = () => handleRemoveProfile(p.appId);
                    return (
                      <GameCard
                        key={p.appId}
                        imageUrl={steamArtworkUrls(p.appId).capsule}
                        fallbackImageUrl={steamArtworkUrls(p.appId).header}
                        title={p.gameName || `App ${p.appId}`}
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
                            <span className="mono">{fanProfileBadge(p)}</span>
                          </Badge>
                        }
                        action={
                          <Button
                            size="sm"
                            fullWidth
                            variant="danger"
                            onClick={removeProfile}
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
        </div>
      </div>
      </div>
    </>
  );
}

/** Compact saved-profile label for a per-game fan card's overlay badge,
 *  e.g. "55%" for a manual speed or "AUTO" for auto mode. */
export function fanProfileBadge(p: FanGameProfile): string {
  return p.mode === "manual" && typeof p.speed === "number"
    ? `${p.speed}%`
    : "AUTO";
}

/** Return a new curve with one point's temp/percent edited. Percent is
 *  clamped to [0,100]; temp is clamped between its neighbours (1 °C gap)
 *  so the curve can never reorder. Pure — out-of-range index is a no-op. */
export function editCurvePoint(
  points: FanCurvePoint[],
  index: number,
  next: Partial<FanCurvePoint>,
): FanCurvePoint[] {
  if (index < 0 || index >= points.length) return points;
  const pts = points.map((p) => ({ ...p }));
  const point = pts[index]; // in-bounds: index checked above
  if (!point) return points;
  if (typeof next.percent === "number") {
    point.percent = Math.max(0, Math.min(100, Math.round(next.percent)));
  }
  if (typeof next.tempC === "number") {
    const prev = index > 0 ? pts[index - 1] : undefined;
    const nextPt = index < pts.length - 1 ? pts[index + 1] : undefined;
    const minT = prev ? prev.tempC + 1 : CURVE_TEMP_MIN;
    const maxT = nextPt ? nextPt.tempC - 1 : CURVE_TEMP_MAX;
    point.tempC = Math.max(minT, Math.min(maxT, Math.round(next.tempC)));
  }
  return pts;
}

/** Insert a node into the widest temperature gap (midpoint of temp +
 *  percent), returning the new array and the inserted index. Pure. */
export function insertCurvePoint(points: FanCurvePoint[]): {
  points: FanCurvePoint[];
  index: number;
} {
  let gapIdx = 0;
  let gapSize = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i]; // both in-bounds: i < length - 1
    const hi = points[i + 1];
    if (!lo || !hi) continue;
    const size = hi.tempC - lo.tempC;
    if (size > gapSize) {
      gapSize = size;
      gapIdx = i;
    }
  }
  const lo = points[gapIdx];
  const hi = points[gapIdx + 1];
  if (!lo || !hi) return { points, index: gapIdx };
  const mid: FanCurvePoint = {
    tempC: Math.round((lo.tempC + hi.tempC) / 2),
    percent: Math.round((lo.percent + hi.percent) / 2),
  };
  return {
    points: [...points.slice(0, gapIdx + 1), mid, ...points.slice(gapIdx + 1)],
    index: gapIdx + 1,
  };
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
 */
export const mount = mountComponent(FanControl);

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
    const first = info.fans?.[0];
    if (!first) return 0;
    return Math.max(0, Math.min(100, first.percent));
  }, []);

  useEffect(() => {
    call("getFanInfo").then((result) => {
      const info = result as FanInfo;
      const primary = info.fans[0];
      if (primary) {
        setRpm(primary.rpm);
        // Seed manualSpeed from the live percent only if the backend
        // can actually report it (direct hwmon). On ectool we leave the
        // 50 default so the slider doesn't snap to 0 when the user
        // flips to Manual.
        const reported = primary.percent;
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
      const primary = info.fans?.[0];
      if (primary) {
        setRpm(primary.rpm);
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
  // boundToGame already implies currentGame is non-null; the extra check
  // narrows the type without changing which branch runs.
  const savedProfile =
    boundToGame && currentGame
      ? gameProfiles.find((p) => p.appId === currentGame.appId)
      : undefined;
  const profileLabel =
    boundToGame && currentGame
    ? savedProfile
      ? `Saved · ${currentGame.gameName || `App ${currentGame.appId}`}`
      : `Set for ${currentGame.gameName || `App ${currentGame.appId}`}`
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
export const mountHomeWidget = mountComponent(FanHomeWidget);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * the Auto/Manual segmented and the live driver subtitle share the
 * body's React tree without any cross-root pub/sub.
 */
export const mountHeader = mountHeaderStub;
