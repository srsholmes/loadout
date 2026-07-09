import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FaLightbulb } from "react-icons/fa6";
import {
  mountComponent,
  useBackend,
  Button,
  Slider,
  Spinner,
  useFocusable,
} from "@loadout/ui";

/**
 * Plain `<button>` with d-pad / gamepad-Enter focus wired via
 * `useFocusable`. The RGB plugin grid has lots of small custom-styled
 * action buttons (zone tabs, presets, mode tiles, swatches) whose CSS
 * doesn't map cleanly onto the SDK's `Button` component, so we keep
 * the bespoke styling and bolt focus + visual feedback on a raw
 * `<button>`. When focused: scale, accent outline, and the same
 * `focusPulse` animation the shared Button component uses.
 */
function FocusableButton({
  onClick,
  disabled,
  children,
  style,
  className,
  selected,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  onClick?: () => void;
  children?: ReactNode;
  /** When true, sets `aria-pressed` so screen readers announce the
   *  active zone / preset / mode tile. Native `<button>` provides no
   *  built-in selected-state semantics. */
  selected?: boolean;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) onClick?.();
    },
    focusable: !disabled,
  });
  const focusStyle: CSSProperties = focused
    ? {
        ...(style ?? {}),
        animation: "focusPulse 2s ease-in-out infinite",
        outline: "2px solid var(--accent)",
        // outlineOffset:0 keeps the outline flush so it doesn't double-
        // halo with any per-button boxShadow (the preset tiles already
        // glow with `0 0 20px ${css}80` when active).
        outlineOffset: 0,
      }
    : (style ?? {});
  const scaleClass = focused ? "scale-[1.04]" : "";
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected ? true : undefined}
      className={`${className ?? ""} transition-transform duration-100 ${scaleClass}`}
      style={focusStyle}
      {...rest}
    >
      {children}
    </button>
  );
}

export const icon = FaLightbulb;

// ── Types ─────────────────────────────────────────────────────────

interface RgbZone {
  id: string;
  name: string;
  color: { r: number; g: number; b: number };
  brightness: number;
  mode: string;
  supportedModes: string[];
}

interface RgbInfo {
  available: boolean;
  driver: string;
  zones: RgbZone[];
  supportedModes: string[];
}

interface Preset {
  name: string;
  r: number;
  g: number;
  b: number;
}

// ── Constants ─────────────────────────────────────────────────────

const PLUGIN_ID = "rgb-control";

const MODE_LABELS: Record<string, string> = {
  static: "Static",
  breathing: "Breathing",
  rainbow: "Rainbow",
  off: "Off",
  // OXP V2 effect presets
  aurora: "Aurora",
  flowing: "Flowing",
  neon: "Neon",
  dreamy: "Dreamy",
  sun: "Sun",
  cyberpunk: "Cyberpunk",
  sunset: "Sunset",
  colorful: "Colorful",
  monster_woke: "Monster",
};

// ── Main Component ────────────────────────────────────────────────

function RgbControl() {
  const { call, useEvent } = useBackend(PLUGIN_ID);

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<RgbInfo | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [sliderR, setSliderR] = useState(0);
  const [sliderG, setSliderG] = useState(0);
  const [sliderB, setSliderB] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [activeMode, setActiveMode] = useState("static");
  const [applying, setApplying] = useState(false);

  // Listen for real-time hardware change events
  useEvent({
    event: "hardwareChanged",
    handler: (data) => {
      setInfo(data as RgbInfo);
      setLoading(false);
    },
  });

  useEvent({
    event: "colorChanged",
    handler: (data) => {
      const { zone, r, g, b } = data as { zone: string; r: number; g: number; b: number };
      setInfo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          zones: prev.zones.map((z) =>
            z.id === zone ? { ...z, color: { r, g, b } } : z
          ),
        };
      });
    },
  });

  useEvent({
    event: "modeChanged",
    handler: (data) => {
      const { zone, mode } = data as { zone: string; mode: string };
      setInfo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          zones: prev.zones.map((z) =>
            z.id === zone ? { ...z, mode } : z
          ),
        };
      });
      setActiveMode(mode);
    },
  });

  useEvent({
    event: "brightnessChanged",
    handler: (data) => {
      const { zone, percent } = data as { zone: string; percent: number };
      setInfo((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          zones: prev.zones.map((z) =>
            z.id === zone ? { ...z, brightness: percent } : z
          ),
        };
      });
    },
  });

  // Fetch initial state
  useEffect(() => {
    Promise.all([
      call("getRgbInfo") as Promise<RgbInfo>,
      call("getPresets") as Promise<Preset[]>,
    ]).then(([rgbInfo, presetList]) => {
      setInfo(rgbInfo);
      setPresets(presetList);
      const first = rgbInfo.zones[0];
      if (first) {
        setSelectedZone(first.id);
        setSliderR(first.color.r);
        setSliderG(first.color.g);
        setSliderB(first.color.b);
        setBrightness(first.brightness);
        setActiveMode(first.mode);
      }
      setLoading(false);
    });
  }, [call]);

  // When zone selection changes, sync sliders
  useEffect(() => {
    if (!info || !selectedZone) return;
    const zone = info.zones.find((z) => z.id === selectedZone);
    if (zone) {
      setSliderR(zone.color.r);
      setSliderG(zone.color.g);
      setSliderB(zone.color.b);
      setBrightness(zone.brightness);
      setActiveMode(zone.mode);
    }
  }, [selectedZone, info]);

  // Debounce slider color writes so dragging doesn't hammer hidraw:
  // we only fire after the user pauses for ~150ms. Per-zone TDP-style
  // serialization in the backend (memory `feedback_tdp_apply_queue`)
  // covers the rest.
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear any pending debounced apply on unmount so a fire-and-forget
  // setTimeout doesn't call setApplying on an unmounted component (or
  // leak an RPC into a no-longer-mounted plugin).
  useEffect(() => {
    return () => {
      if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    };
  }, []);
  const applyColor = useCallback(
    (r: number, g: number, b: number) => {
      if (!selectedZone) return;
      if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
      applyTimerRef.current = setTimeout(async () => {
        try {
          setApplying(true);
          await call("setColor", selectedZone, r, g, b);
        } finally {
          // Always clear — without this a thrown call would leave the
          // UI permanently disabled / unfocusable.
          setApplying(false);
        }
      }, 150);
    },
    [call, selectedZone]
  );

  // Slider-onChange wrappers: update local UI state immediately, then
  // schedule a debounced apply with the *next* RGB values (don't read
  // from sliderR/G/B state — those are stale in the callback closure).
  const handleR = useCallback(
    (v: number) => {
      setSliderR(v);
      applyColor(v, sliderG, sliderB);
    },
    [applyColor, sliderG, sliderB]
  );
  const handleG = useCallback(
    (v: number) => {
      setSliderG(v);
      applyColor(sliderR, v, sliderB);
    },
    [applyColor, sliderR, sliderB]
  );
  const handleB = useCallback(
    (v: number) => {
      setSliderB(v);
      applyColor(sliderR, sliderG, v);
    },
    [applyColor, sliderR, sliderG]
  );

  const handleSetMode = useCallback(
    async (mode: string) => {
      if (!selectedZone) return;
      // Optimistic update — surface the new mode immediately so the
      // tile selection visibly tracks the click. Revert on failure
      // so the highlight follows the hardware truth. Mirrors the
      // setBrightness pattern.
      const prevMode = activeMode;
      setActiveMode(mode);
      try {
        setApplying(true);
        const ok = await call("setMode", selectedZone, mode);
        if (ok === false) setActiveMode(prevMode);
      } catch (err) {
        console.warn("[rgb-control] setMode failed:", err);
        setActiveMode(prevMode);
      } finally {
        setApplying(false);
      }
    },
    [call, selectedZone, activeMode]
  );

  const handleSetBrightness = useCallback(
    async (value: number) => {
      setBrightness(value);
      if (!selectedZone) return;
      try {
        await call("setBrightness", selectedZone, value);
      } catch (err) {
        console.warn("[rgb-control] setBrightness failed:", err);
      }
    },
    [call, selectedZone]
  );

  const handleApplyPreset = useCallback(
    async (name: string) => {
      try {
        setApplying(true);
        await call("applyPreset", name);
        const preset = presets.find((p) => p.name === name);
        if (preset) {
          setSliderR(preset.r);
          setSliderG(preset.g);
          setSliderB(preset.b);
        }
      } catch (err) {
        // Swallow — the onClick wrapper discards the returned promise,
        // so a rethrow would surface as an unhandled rejection. The
        // try/finally lockout-clear is preserved via catch + finally.
        console.warn("[rgb-control] applyPreset failed:", err);
      } finally {
        setApplying(false);
      }
    },
    [call, presets]
  );

  const handleRescan = useCallback(async () => {
    setLoading(true);
    const newInfo = (await call("rescan")) as RgbInfo;
    setInfo(newInfo);
    const first = newInfo.zones[0];
    if (first && !selectedZone) {
      setSelectedZone(first.id);
    }
    setLoading(false);
  }, [call, selectedZone]);

  // ── Render ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={32} />
      </div>
    );
  }

  if (!info?.available) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="subsection">
              <div className="subsection-label">No RGB hardware detected</div>
              <div className="subsection-desc">
                No supported RGB LED hardware was found on this device.
              </div>
            </div>
            <div className="subsection">
              <div className="subsection-label">Supported interfaces</div>
              <div className="row"><span className="row-label">OpenRGB</span><span className="row-value">Install via package manager</span></div>
              <div className="row"><span className="row-label">Kernel sysfs</span><span className="row-value mono">/sys/class/leds/</span></div>
              <div className="row"><span className="row-label">Platform LEDs</span><span className="row-value">OneXPlayer · ROG · Ayaneo</span></div>
            </div>
            <div className="subsection">
              <div className="flex items-center justify-between">
                <div className="subsection-desc m-0">
                  Install OpenRGB + ensure the server is running, then rescan.
                </div>
                <Button onClick={handleRescan}>Rescan hardware</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const currentZone = info.zones.find((z) => z.id === selectedZone) || info.zones[0];
  const modes = currentZone?.supportedModes || info.supportedModes;

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* ZONE SELECTOR — only if multiple zones */}
          {info.zones.length > 1 && (
            <div className="subsection">
              <div className="subsection-label">LED Zones</div>
              <div className="flex flex-wrap gap-1.5">
                {info.zones.map((zone) => (
                  <FocusableButton
                    key={zone.id}
                    onClick={() => setSelectedZone(zone.id)}
                    selected={zone.id === selectedZone}
                    className={`btn btn-sm ${zone.id === selectedZone ? "btn-primary" : "btn-soft"}`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full border border-white/20"
                      style={{ background: `rgb(${zone.color.r}, ${zone.color.g}, ${zone.color.b})` }}
                    />
                    {zone.name}
                  </FocusableButton>
                ))}
              </div>
            </div>
          )}

          {/* COLOR PRESETS — 4-column grid */}
          {presets.length > 0 && (
            <div className="subsection">
              <div className="flex items-center justify-between mb-3.5">
                <div className="subsection-label mb-0">Color Presets</div>
                <span className="chip">{info.driver} — {info.zones.length} zone{info.zones.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {presets.map((preset) => {
                  const isActive =
                    currentZone &&
                    currentZone.color.r === preset.r &&
                    currentZone.color.g === preset.g &&
                    currentZone.color.b === preset.b;
                  const isOff = preset.name === "Off";
                  const css = `rgb(${preset.r}, ${preset.g}, ${preset.b})`;
                  return (
                    <FocusableButton
                      key={preset.name}
                      onClick={() => handleApplyPreset(preset.name)}
                      disabled={applying}
                      selected={!!isActive}
                      className="rounded-xl font-semibold text-[12px] transition-all duration-100"
                      style={{
                        height: 52,
                        background: isOff ? "var(--bg-inset)" : css,
                        color: isOff ? "var(--fg-1)" : preset.r + preset.g + preset.b > 520 ? "#000" : "#fff",
                        border: isActive ? "2px solid var(--fg-1)" : "1px solid var(--line)",
                        boxShadow: isActive ? `0 0 20px ${css}80` : "none",
                      }}
                    >
                      {preset.name}
                    </FocusableButton>
                  );
                })}
              </div>
            </div>
          )}

          {/* CUSTOM COLOR — swatch + hex + R/G/B sliders */}
          <div className="subsection">
            <div className="subsection-label">Custom Color</div>
            <div className="flex items-center gap-3 mb-3.5">
              <div
                className="rounded-xl border border-base-300 shrink-0"
                style={{
                  width: 46,
                  height: 46,
                  background: `rgb(${sliderR}, ${sliderG}, ${sliderB})`,
                  boxShadow: `0 0 24px rgb(${sliderR}, ${sliderG}, ${sliderB} / 40%)`,
                }}
              />
              <div className="flex-1">
                <div className="mono text-sm font-semibold">
                  {`#${sliderR.toString(16).padStart(2, "0")}${sliderG.toString(16).padStart(2, "0")}${sliderB.toString(16).padStart(2, "0")}`.toUpperCase()}
                </div>
                <div className="mono text-[11px] text-base-content/50">
                  rgb({sliderR}, {sliderG}, {sliderB})
                </div>
              </div>
            </div>
            {/* Sliders push to hardware on every change with a 150ms
                debounce in `applyColor` — no Apply button needed. */}
            <ChannelSlider label="R" value={sliderR} onChange={handleR} />
            <ChannelSlider label="G" value={sliderG} onChange={handleG} />
            <ChannelSlider label="B" value={sliderB} onChange={handleB} />
          </div>

          {/* BRIGHTNESS */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Brightness</div>
              <span className="mono text-[13px] font-semibold" style={{ color: "var(--accent)" }}>
                {brightness}%
              </span>
            </div>
            <Slider min={0} max={100} value={brightness} onChange={handleSetBrightness} />
            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
          </div>

          {/* LED EFFECT — 4-column button grid */}
          {modes.length > 0 && (
            <div className="subsection">
              <div className="subsection-label">LED Effect</div>
              <div className="grid grid-cols-4 gap-1.5">
                {modes.map((mode) => (
                  <FocusableButton
                    key={mode}
                    selected={activeMode === mode}
                    className={`btn btn-sm ${activeMode === mode ? "btn-primary" : "btn-soft"}`}
                    onClick={() => handleSetMode(mode)}
                    disabled={applying}
                  >
                    {MODE_LABELS[mode] || mode}
                  </FocusableButton>
                ))}
              </div>
            </div>
          )}

          {/* DEVICE INFO */}
          <div className="subsection">
            <div className="subsection-label">Device</div>
            <div className="row"><span className="row-label">Driver</span>       <span className="row-value">{info.driver}</span></div>
            <div className="row"><span className="row-label">Zones</span>        <span className="row-value">{info.zones.length}</span></div>
            <div className="row"><span className="row-label">Current zone</span> <span className="row-value">{currentZone?.name || "—"}</span></div>
            <div className="row"><span className="row-label">Current mode</span> <span className="row-value">{MODE_LABELS[currentZone?.mode || ""] || currentZone?.mode || "—"}</span></div>
            <div className="flex justify-end pt-3.5 mt-3.5 border-t border-base-300">
              <Button onClick={handleRescan}>Rescan hardware</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-channel (R/G/B) slider row — big label, 0–255 slider, numeric value. */
function ChannelSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3 mb-2 min-h-[36px]">
      <span className="mono text-xs w-4 shrink-0 text-base-content/60">{label}</span>
      <div className="flex-1"><Slider min={0} max={255} value={value} onChange={onChange} /></div>
      <span className="mono text-xs w-9 text-right tabular-nums">{value}</span>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────

/** Full settings page — mounted by the overlay shell when the plugin opens. */
export const mount = mountComponent(RgbControl);

function Header() {
  const { call } = useBackend(PLUGIN_ID);
  const [info, setInfo] = useState<RgbInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    call("getRgbInfo")
      .then((d) => {
        if (!cancelled) setInfo(d as RgbInfo);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [call]);

  const subtitle = (() => {
    if (!info) return "Detecting hardware…";
    if (!info.available) return "No RGB hardware detected";
    const zoneCount = info.zones.length;
    const zoneLabel = zoneCount === 1 ? "1 zone" : `${zoneCount} zones`;
    return `Driver: ${info.driver} · ${zoneLabel}`;
  })();

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        RGB Zones
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        {subtitle}
      </span>
    </div>
  );
}

/** Compact header strip (title + driver subtitle). Separate tree from
 *  the body — the header re-uses the same React tree shape as the body
 *  but doesn't share state. */
export const mountHeader = mountComponent(Header);

// ── Home Widget ──────────────────────────────────────────────────

const FALLBACK_SWATCHES: Preset[] = [
  { name: "Red", r: 0xff, g: 0x4f, b: 0x4f },
  { name: "Green", r: 0x57, g: 0xe3, b: 0x89 },
  { name: "Blue", r: 0x6c, g: 0x8f, b: 0xff },
  { name: "Magenta", r: 0xc0, g: 0x61, b: 0xcb },
  { name: "Cyan", r: 0x33, g: 0xd6, b: 0xff },
  { name: "Orange", r: 0xff, g: 0x9b, b: 0x40 },
  { name: "White", r: 0xff, g: 0xff, b: 0xff },
];

/** Homepage widget — quick color swatches + brightness slider for the primary zone. */
function RgbHomeWidget() {
  const { call, useEvent } = useBackend(PLUGIN_ID);
  const [info, setInfo] = useState<RgbInfo | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [brightness, setBrightness] = useState(100);
  const [error, setError] = useState(false);

  useEffect(() => {
    Promise.all([
      call("getRgbInfo") as Promise<RgbInfo>,
      call("getPresets") as Promise<Preset[]>,
    ])
      .then(([rgbInfo, presetList]) => {
        setInfo(rgbInfo);
        setPresets(presetList ?? []);
        const first = rgbInfo.zones[0];
        if (first) {
          setBrightness(first.brightness);
        }
      })
      .catch(() => setError(true));
  }, [call]);

  useEvent({
    event: "hardwareChanged",
    handler: useCallback((data: unknown) => {
      setInfo(data as RgbInfo);
    }, []),
  });

  useEvent({
    event: "colorChanged",
    handler: useCallback((data: unknown) => {
      const { zone, r, g, b } = data as {
        zone: string;
        r: number;
        g: number;
        b: number;
      };
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              zones: prev.zones.map((z) =>
                z.id === zone ? { ...z, color: { r, g, b } } : z,
              ),
            }
          : prev,
      );
    }, []),
  });

  useEvent({
    event: "brightnessChanged",
    handler: useCallback((data: unknown) => {
      const { zone, percent } = data as { zone: string; percent: number };
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              zones: prev.zones.map((z) =>
                z.id === zone ? { ...z, brightness: percent } : z,
              ),
            }
          : prev,
      );
      if (info?.zones[0]?.id === zone) setBrightness(percent);
    }, [info]),
  });

  if (error || (info && !info.available)) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">
            RGB unavailable
          </span>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  const zone = info.zones[0];
  const swatches: Preset[] = presets.length > 0
    ? presets.filter((p) => p.name !== "Off").slice(0, 7)
    : FALLBACK_SWATCHES;

  const handleSwatch = (p: Preset) => {
    if (!zone) return;
    setInfo((prev) =>
      prev
        ? {
            ...prev,
            zones: prev.zones.map((z, i) =>
              i === 0 ? { ...z, color: { r: p.r, g: p.g, b: p.b } } : z,
            ),
          }
        : prev,
    );
    call("setColor", zone.id, p.r, p.g, p.b).catch(() => {});
  };

  const handleBrightness = (value: number) => {
    setBrightness(value);
    if (!zone) return;
    call("setBrightness", zone.id, value).catch(() => {});
  };

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">RGB ZONES</div>
        <div className="chip">
          {info.zones.length} zone{info.zones.length !== 1 ? "s" : ""}
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {swatches.map((p) => {
          const css = `rgb(${p.r}, ${p.g}, ${p.b})`;
          const isActive =
            zone &&
            zone.color.r === p.r &&
            zone.color.g === p.g &&
            zone.color.b === p.b;
          return (
            <FocusableButton
              key={p.name}
              onClick={() => handleSwatch(p)}
              aria-label={p.name}
              selected={!!isActive}
              style={{
                flex: 1,
                height: 36,
                borderRadius: 8,
                background: css,
                border: isActive
                  ? "2px solid var(--fg-1)"
                  : "1px solid var(--line)",
                boxShadow: isActive ? `0 0 16px ${css}80` : "none",
                transition: "all var(--dur-fast)",
                cursor: "pointer",
              }}
            />
          );
        })}
      </div>

      <div className="metric-label mb-2">BRIGHTNESS {brightness}%</div>
      <Slider min={0} max={100} value={brightness} onChange={handleBrightness} />
    </div>
  );
}

/**
 * Mount the homepage widget.
 * Shows quick color swatches + brightness slider for the primary RGB zone.
 */
export const mountHomeWidget = mountComponent(RgbHomeWidget);
