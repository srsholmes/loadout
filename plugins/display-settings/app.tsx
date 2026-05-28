import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  PluginProvider,
  useBackend,
  Button,
  Slider,
  SegmentedItem,
} from "@loadout/ui";

export { MdDisplaySettings as icon } from "react-icons/md";

// ---------- Types ----------

interface DisplayState {
  saturation: number;
  brightness: number;
  colorTemp: number;
  gamma: { r: number; g: number; b: number };
}

interface DisplayInfo extends DisplayState {
  method: "gamescope" | "wayland" | "xrandr" | "none";
  xrandrOutput: string | null;
  backlightPath: string | null;
  ranges: {
    saturation: [number, number];
    brightness: [number, number];
    colorTemp: [number, number];
    gamma: [number, number];
  };
}

interface Preset {
  name: string;
  label: string;
  saturation: number;
  colorTemp: number;
  gamma: { r: number; g: number; b: number };
}

// ---------- mountComponent factory ----------

/** Collapse the identical createRoot + PluginProvider + unmount boilerplate. */
function mountComponent(Component: React.ComponentType) {
  return function mount(
    container: HTMLElement,
    opts?: { parentFocusKey?: string },
  ): () => void {
    const root = createRoot(container);
    root.render(
      <PluginProvider parentFocusKey={opts?.parentFocusKey}>
        <Component />
      </PluginProvider>,
    );
    return () => root.unmount();
  };
}

// ---------- Main Component ----------

function DisplaySettings() {
  const { call, useEvent } = useBackend("display-settings");

  const [info, setInfo] = useState<DisplayInfo | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [saturation, setSaturation] = useState(100);
  const [brightness, setBrightness] = useState(100);
  const [colorTemp, setColorTemp] = useState(6500);
  const [gamma, setGamma] = useState({ r: 1.0, g: 1.0, b: 1.0 });
  const [activePreset, setActivePreset] = useState<string | null>("default");

  useEvent({
    event: "stateChanged",
    handler: (data) => {
      const state = data as DisplayState;
      setSaturation(state.saturation);
      setBrightness(state.brightness);
      setColorTemp(state.colorTemp);
      setGamma(state.gamma);
    },
  });

  useEffect(() => {
    call("getDisplayInfo").then((result) => {
      const data = result as DisplayInfo;
      setInfo(data);
      setSaturation(data.saturation);
      setBrightness(data.brightness);
      setColorTemp(data.colorTemp);
      setGamma(data.gamma);
    });
    call("getPresets").then((result) => setPresets(result as Preset[]));
  }, [call]);

  const handleSaturation = useCallback(
    (v: number) => {
      setSaturation(v);
      setActivePreset(null);
      call("setSaturation", v);
    },
    [call],
  );
  const handleBrightness = useCallback(
    (v: number) => {
      setBrightness(v);
      setActivePreset(null);
      call("setBrightness", v);
    },
    [call],
  );
  const handleColorTemp = useCallback(
    (v: number) => {
      setColorTemp(v);
      setActivePreset(null);
      call("setColorTemp", v);
    },
    [call],
  );
  const handlePreset = useCallback(
    (name: string) => {
      setActivePreset(name);
      call("applyPreset", name);
    },
    [call],
  );
  const handleReset = useCallback(() => {
    setActivePreset("default");
    call("resetDefaults");
  }, [call]);

  const methodLabel =
    info?.method === "gamescope"
      ? "Gamescope"
      : info?.method === "xrandr"
        ? `xrandr (${info.xrandrOutput})`
        : "No display control detected";

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* Presets */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Color Profile</div>
              <span className="chip">{methodLabel}</span>
            </div>
            <div className="segmented w-full">
              {presets.map((p) => (
                <SegmentedItem
                  key={p.name}
                  active={activePreset === p.name}
                  onSelect={() => handlePreset(p.name)}
                  style={{ flex: 1 }}
                >
                  {p.label}
                </SegmentedItem>
              ))}
            </div>
          </div>

          {/* Brightness */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Brightness</div>
              <span
                className="mono text-[13px] font-semibold"
                style={{ color: "var(--accent)" }}
              >
                {Math.round(brightness)}%
              </span>
            </div>
            <Slider
              value={brightness}
              min={0}
              max={100}
              step={1}
              onChange={handleBrightness}
            />
            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>

          {/* Saturation */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Saturation</div>
              <span
                className="mono text-[13px] font-semibold"
                style={{ color: "var(--accent)" }}
              >
                {Math.round(saturation)}%
              </span>
            </div>
            <Slider
              value={saturation}
              min={0}
              max={200}
              step={1}
              onChange={handleSaturation}
            />
            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
              <span>Grayscale</span>
              <span>Normal</span>
              <span>Vivid</span>
            </div>
          </div>

          {/* Color Temperature */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Color Temperature</div>
              <span
                className="mono text-[13px] font-semibold"
                style={{ color: "var(--accent)" }}
              >
                {Math.round(colorTemp)}K
              </span>
            </div>
            <Slider
              value={colorTemp}
              min={3000}
              max={6500}
              step={100}
              onChange={handleColorTemp}
            />
            <div className="flex justify-between mono text-[11px] text-base-content/50 mt-1.5">
              <span>Warm · 3000K</span>
              <span>Neutral</span>
              <span>Cool · 6500K</span>
            </div>
            {/* Warm quick-picks */}
            <div className="flex gap-1.5 mt-3">
              {[3400, 4000, 5000, 6500].map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={colorTemp === k ? "primary" : "default"}
                  onClick={() => handleColorTemp(k)}
                  style={{ flex: 1 }}
                >
                  {k}K
                </Button>
              ))}
            </div>
          </div>

          {/* Gamma */}
          <div className="subsection">
            <div className="subsection-label">Gamma</div>
            <div className="row">
              <span className="row-label">Red</span>
              <span className="row-value">{gamma.r.toFixed(2)}</span>
            </div>
            <div className="row">
              <span className="row-label">Green</span>
              <span className="row-value">{gamma.g.toFixed(2)}</span>
            </div>
            <div className="row">
              <span className="row-label">Blue</span>
              <span className="row-value">{gamma.b.toFixed(2)}</span>
            </div>
          </div>

          {/* Info + Reset */}
          <div className="subsection">
            <div className="subsection-label">Display</div>
            <div className="row">
              <span className="row-label">Control method</span>
              <span className="row-value">{methodLabel}</span>
            </div>
            {info?.backlightPath && (
              <div className="row">
                <span className="row-label">Backlight</span>
                <span className="row-value">{info.backlightPath}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-3.5 mt-3.5 border-t border-base-300">
              <div className="subsection-desc m-0">
                Changes apply live. Adjustments vary with display hardware +
                compositor.
              </div>
              <Button onClick={handleReset}>Reset to defaults</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Homepage widget — brightness slider + presets ----------

function DisplayHomeWidget() {
  const { call } = useBackend("display-settings");
  const [brightness, setBrightness] = useState<number>(100);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>("default");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    call("getDisplayInfo")
      .then((result) => {
        const state = result as DisplayState;
        setBrightness(state.brightness);
      })
      .catch(() => {});
    call("getPresets")
      .then((result) => setPresets(result as Preset[]))
      .catch(() => {});
  }, [call]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return (
    <div className="p-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="metric-value mono" style={{ fontSize: 36 }}>
          {brightness}
        </span>
        <span className="metric-unit">%</span>
        <span className="ml-auto metric-label">BRIGHTNESS</span>
      </div>
      <Slider
        value={brightness}
        min={0}
        max={100}
        step={1}
        onChange={(val) => {
          setBrightness(val);
          setActivePreset(null);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            call("setBrightness", val).catch(() => {});
          }, 500);
        }}
      />
      {presets.length > 0 && (
        <div className="segmented w-full mt-3">
          {presets.slice(0, 4).map((p) => (
            <SegmentedItem
              key={p.name}
              active={activePreset === p.name}
              onSelect={() => {
                setActivePreset(p.name);
                call("applyPreset", p.name).catch(() => {});
              }}
              style={{ flex: 1 }}
            >
              {p.label}
            </SegmentedItem>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Header ----------

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Display
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Saturation, brightness, color temperature
      </span>
    </div>
  );
}

// ---------- Exports ----------

export const mount = mountComponent(DisplaySettings);
export const mountHomeWidget = mountComponent(DisplayHomeWidget);
export const mountHeader = mountComponent(Header);
