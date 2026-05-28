import { useState, useEffect, useCallback } from "react";
import { FaCheck } from "react-icons/fa6";
import {
  Button,
  SegmentedItem,
  Slider,
  Spinner,
  TextInput,
  Toggle,
  mountComponent,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import {
  detectActivePreset,
  alphaToPercent,
  percentToAlpha,
} from "./lib/preset-match";
import type { Preset } from "./lib/config";

export { FaChartLine as icon } from "react-icons/fa6";

/**
 * Metric catalogue: MangoHud config key → human label.
 * The tests look for "FPS Counter", "GPU Stats", "CPU Stats", "RAM Usage",
 * so those labels are preserved verbatim.
 */
const METRICS = [
  { key: "fps", label: "FPS Counter" },
  { key: "frame_timing", label: "Frame Timing" },
  { key: "cpu_stats", label: "CPU Stats" },
  { key: "gpu_stats", label: "GPU Stats" },
  { key: "cpu_temp", label: "CPU Temperature" },
  { key: "gpu_temp", label: "GPU Temperature" },
  { key: "ram", label: "RAM Usage" },
  { key: "vram", label: "VRAM Usage" },
  { key: "battery", label: "Battery" },
  { key: "battery_watt", label: "Battery Power" },
  { key: "gpu_power", label: "GPU Power" },
  { key: "gamemode", label: "GameMode" },
] as const;

const POSITIONS = [
  { value: "top-left", label: "Top Left" },
  { value: "top-center", label: "Top Center" },
  { value: "top-right", label: "Top Right" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-center", label: "Bottom Center" },
  { value: "bottom-right", label: "Bottom Right" },
] as const;

function MangoHudTweaksManager() {
  const { call, useEvent } = useBackend("mangohud-tweaks");

  const [installed, setInstalled] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEvent({
    event: "configChanged",
    handler: (data) => {
      setConfig(data as Record<string, string>);
    },
  });

  const refresh = useCallback(async () => {
    try {
      const [isInst, cfg, pr] = await Promise.all([
        call("isInstalled"),
        call("getConfig"),
        call("getPresets"),
      ]);
      setInstalled(isInst as boolean);
      setConfig(cfg as Record<string, string>);
      setPresets(pr as Preset[]);
    } catch (err) {
      console.error("[mangohud-tweaks] Failed to refresh:", err);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveConfig = useCallback(
    async (newConfig: Record<string, string>) => {
      setSaving(true);
      try {
        await call("setConfig", newConfig);
        setConfig(newConfig);
      } catch (err) {
        console.error("[mangohud-tweaks] Failed to save config:", err);
      } finally {
        setSaving(false);
      }
    },
    [call],
  );

  const handleToggleMetric = useCallback(
    (key: string, checked: boolean) => {
      const newConfig = { ...config };
      if (checked) newConfig[key] = "1";
      else delete newConfig[key];
      saveConfig(newConfig);
    },
    [config, saveConfig],
  );

  const handleApplyPreset = useCallback(
    async (name: string) => {
      setSaving(true);
      try {
        await call("applyPreset", name);
        const cfg = (await call("getConfig")) as Record<string, string>;
        setConfig(cfg);
      } catch (err) {
        console.error("[mangohud-tweaks] Failed to apply preset:", err);
      } finally {
        setSaving(false);
      }
    },
    [call],
  );

  const handlePositionChange = useCallback(
    (position: string) => {
      const newConfig = { ...config, position };
      saveConfig(newConfig);
    },
    [config, saveConfig],
  );

  const handleFpsLimitChange = useCallback(
    (value: string) => {
      const newConfig = { ...config };
      if (value.trim()) newConfig.fps_limit = value.trim();
      else delete newConfig.fps_limit;
      saveConfig(newConfig);
    },
    [config, saveConfig],
  );

  const handleOpacityChange = useCallback(
    (pct: number) => {
      const newConfig = { ...config, background_alpha: percentToAlpha(pct) };
      saveConfig(newConfig);
    },
    [config, saveConfig],
  );

  const handleOverlayToggle = useCallback(
    (enabled: boolean) => {
      const newConfig = { ...config };
      if (enabled) delete newConfig.no_display;
      else newConfig.no_display = "1";
      saveConfig(newConfig);
    },
    [config, saveConfig],
  );

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      await call("resetConfig");
      setConfig({});
    } catch (err) {
      console.error("[mangohud-tweaks] Failed to reset config:", err);
    } finally {
      setSaving(false);
    }
  }, [call]);

  if (loading) {
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

  const activePreset = detectActivePreset(config, presets);
  const position = config.position ?? "top-left";
  const opacity = alphaToPercent(config.background_alpha);
  const overlayEnabled = config.no_display !== "1";
  const enabledMetrics = METRICS.filter((m) => config[m.key] === "1");

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* Header: title + file path + on/off toggle */}
          <div className="subsection">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: "var(--fg-3)",
                    marginBottom: 4,
                  }}
                >
                  MangoHud Tweaks
                </div>
                <div className="subsection-label" style={{ marginBottom: 2 }}>
                  MangoHud Overlay
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  In-game performance HUD · applied to{" "}
                  <span className="mono">~/.config/MangoHud/MangoHud.conf</span>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {installed ? (
                  <span className="chip chip-success">Installed</span>
                ) : (
                  <span className="chip chip-danger">Not Installed</span>
                )}
                <Toggle
                  checked={overlayEnabled}
                  onChange={handleOverlayToggle}
                  disabled={saving || !installed}
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="subsection" style={{ background: "var(--bg-inset)" }}>
            <div className="subsection-label">Preview</div>
            <div
              style={{
                position: "relative",
                height: 180,
                borderRadius: 10,
                background:
                  "linear-gradient(135deg, oklch(0.3 0.08 30), oklch(0.2 0.04 260))",
                overflow: "hidden",
                border: "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: position.startsWith("top") ? 12 : "auto",
                  bottom: position.startsWith("bottom") ? 12 : "auto",
                  left: position.endsWith("left")
                    ? 12
                    : position.endsWith("center")
                      ? "50%"
                      : "auto",
                  right: position.endsWith("right") ? 12 : "auto",
                  transform: position.endsWith("center")
                    ? "translateX(-50%)"
                    : undefined,
                  padding: "8px 10px",
                  background: `oklch(0 0 0 / ${opacity / 100})`,
                  color: "#7fff7f",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1.4,
                  borderRadius: 4,
                  minWidth: 120,
                  opacity: overlayEnabled ? 1 : 0.35,
                }}
              >
                {enabledMetrics.length === 0 && (
                  <div style={{ color: "#fff", opacity: 0.6 }}>
                    no metrics selected
                  </div>
                )}
                {config.fps === "1" && (
                  <div>
                    FPS <span style={{ color: "#fff" }}>74</span>
                  </div>
                )}
                {config.frame_timing === "1" && (
                  <div>
                    FT <span style={{ color: "#fff" }}>13.4ms</span>
                  </div>
                )}
                {config.cpu_stats === "1" && (
                  <div>
                    CPU <span style={{ color: "#fff" }}>42%</span>
                  </div>
                )}
                {config.gpu_stats === "1" && (
                  <div>
                    GPU <span style={{ color: "#fff" }}>68%</span>
                  </div>
                )}
                {config.cpu_temp === "1" && (
                  <div>
                    CPU<span style={{ opacity: 0.6 }}>°</span>{" "}
                    <span style={{ color: "#fff" }}>62°C</span>
                  </div>
                )}
                {config.gpu_temp === "1" && (
                  <div>
                    GPU<span style={{ opacity: 0.6 }}>°</span>{" "}
                    <span style={{ color: "#fff" }}>71°C</span>
                  </div>
                )}
                {config.ram === "1" && (
                  <div>
                    RAM <span style={{ color: "#fff" }}>6.1G</span>
                  </div>
                )}
                {config.vram === "1" && (
                  <div>
                    VRAM <span style={{ color: "#fff" }}>4.2G</span>
                  </div>
                )}
                {config.battery === "1" && (
                  <div>
                    BAT <span style={{ color: "#fff" }}>86%</span>
                  </div>
                )}
                {config.gpu_power === "1" && (
                  <div>
                    PWR <span style={{ color: "#fff" }}>22W</span>
                  </div>
                )}
              </div>
              <div
                style={{
                  position: "absolute",
                  bottom: 8,
                  right: 8,
                  fontSize: 10,
                  color: "#fff",
                  opacity: 0.5,
                  fontFamily: "var(--font-mono)",
                }}
              >
                game preview
              </div>
            </div>
          </div>

          {/* Preset */}
          <div className="subsection">
            <div className="subsection-label">Preset</div>
            <div className="segmented w-full">
              {presets.map((preset) => (
                <SegmentedItem
                  key={preset.name}
                  active={activePreset === preset.name}
                  onSelect={() => handleApplyPreset(preset.name)}
                  disabled={saving}
                  style={{ flex: 1 }}
                >
                  {preset.label}
                </SegmentedItem>
              ))}
            </div>
            <div className="subsection-desc">
              Presets enable common metric combos. Pick individual metrics below
              to customize.
            </div>
          </div>

          {/* Position — 3×3 grid (center row disabled: MangoHud doesn't support it) */}
          <div className="subsection">
            <div className="subsection-label">Position</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                maxWidth: 360,
              }}
            >
              {POSITIONS.slice(0, 3).map((pos) => (
                <PositionCell
                  key={pos.value}
                  pos={pos}
                  active={position === pos.value}
                  disabled={saving}
                  onClick={() => handlePositionChange(pos.value)}
                />
              ))}
              {/* Middle row spacer — mangohud has no middle positions */}
              <div />
              <div />
              <div />
              {POSITIONS.slice(3).map((pos) => (
                <PositionCell
                  key={pos.value}
                  pos={pos}
                  active={position === pos.value}
                  disabled={saving}
                  onClick={() => handlePositionChange(pos.value)}
                />
              ))}
            </div>
          </div>

          {/* Metrics — chip grid */}
          <div className="subsection">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div className="subsection-label" style={{ marginBottom: 0 }}>
                Metrics
              </div>
              <div className="chip">{enabledMetrics.length} enabled</div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
              }}
            >
              {METRICS.map((m) => (
                <MetricChip
                  key={m.key}
                  label={m.label}
                  on={config[m.key] === "1"}
                  disabled={saving}
                  onToggle={() =>
                    handleToggleMetric(m.key, !(config[m.key] === "1"))
                  }
                />
              ))}
            </div>
          </div>

          {/* Background Opacity */}
          <div className="subsection">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div className="subsection-label" style={{ marginBottom: 0 }}>
                Background Opacity
              </div>
              <span
                className="mono"
                style={{
                  color: "var(--accent)",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {opacity}%
              </span>
            </div>
            <Slider
              value={opacity}
              onChange={handleOpacityChange}
              min={0}
              max={100}
              step={5}
              disabled={saving}
            />
            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
              <span>transparent</span>
              <span>opaque</span>
            </div>
          </div>

          {/* FPS Limit + Reset */}
          <div className="subsection">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <div className="subsection-label" style={{ marginBottom: 0 }}>
                FPS Limit
              </div>
              <span
                className="mono"
                style={{ fontSize: 12, color: "var(--fg-3)" }}
              >
                {config.fps_limit ? `${config.fps_limit} fps` : "unlimited"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <TextInput
                inputMode="numeric"
                placeholder="No limit"
                disabled={saving}
                value={config.fps_limit ?? ""}
                onChange={(value) => {
                  const val = value.replace(/[^0-9]/g, "");
                  setConfig((prev) => {
                    const next = { ...prev };
                    if (val) next.fps_limit = val;
                    else delete next.fps_limit;
                    return next;
                  });
                }}
                onBlur={(e) => {
                  handleFpsLimitChange(
                    e.target.value.replace(/[^0-9]/g, ""),
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleFpsLimitChange(
                      (e.target as HTMLInputElement).value.replace(
                        /[^0-9]/g,
                        "",
                      ),
                    );
                  }
                }}
                className="bg-[var(--bg-inset)] border border-[var(--line)] rounded-lg text-[var(--fg-1)] outline-none"
                style={{
                  width: 110,
                  padding: "8px 10px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                }}
              />
              <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
                Leave blank for no limit
              </span>
            </div>
          </div>

          {/* Reset */}
          <div className="subsection">
            <Button
              onClick={handleReset}
              disabled={saving}
              variant="danger"
            >
              Reset to Defaults
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Metric checkbox chip in the 3-column "metrics shown" grid. */
function MetricChip({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) onToggle();
    },
    focusable: !disabled,
  });
  return (
    <button
      ref={ref}
      onClick={onToggle}
      disabled={disabled}
      style={{
        padding: "10px 12px",
        textAlign: "left",
        background: on ? "var(--accent-soft)" : "var(--bg-inset)",
        border: on
          ? "1px solid var(--accent)"
          : focused
            ? "1px solid var(--accent)"
            : "1px solid var(--line)",
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        color: on ? "var(--accent)" : "var(--fg-2)",
        fontSize: 12,
        fontWeight: on ? 600 : 500,
        display: "flex",
        alignItems: "center",
        gap: 8,
        transform: focused ? "scale(1.02)" : "scale(1)",
        transition: "transform 100ms ease",
      }}
    >
      {on && <FaCheck style={{ width: 11, height: 11 }} />}
      {label}
    </button>
  );
}

/** One cell in the 3×3 position picker. */
function PositionCell({
  pos,
  active,
  disabled,
  onClick,
}: {
  pos: { value: string; label: string };
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) onClick();
    },
    focusable: !disabled,
  });
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-label={pos.label}
      style={{
        aspectRatio: "2/1",
        border: active
          ? "1.5px solid var(--accent)"
          : focused
            ? "1.5px solid var(--accent)"
            : "1px solid var(--line)",
        background: active ? "var(--accent-soft)" : "var(--bg-inset)",
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: active ? "var(--accent)" : "var(--fg-3)",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        gap: 2,
        transform: focused ? "scale(1.04)" : "scale(1)",
        transition: "transform 100ms ease",
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1 }}>●</span>
      <span style={{ fontSize: 10 }}>{pos.label}</span>
    </button>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        MangoHud Tweaks
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        MangoHud overlay config
      </span>
    </div>
  );
}

export const mount = mountComponent(MangoHudTweaksManager);
export const mountHeader = mountComponent(Header);
