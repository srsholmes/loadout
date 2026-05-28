import { useState, useEffect, useCallback, useRef } from "react";
import {
  Alert,
  Button,
  Slider,
  mountComponent,
  useBackend,
} from "@loadout/ui";
import { FaTriangleExclamation } from "react-icons/fa6";

export { MdDisplaySettings as icon } from "react-icons/md";

// ---------- Types ----------

interface DisplayState {
  saturation: number;
  brightness: number;
}

interface DisplayInfo extends DisplayState {
  method: "gamescope" | "none";
  backlightPath: string | null;
  ranges: {
    saturation: [number, number];
    brightness: [number, number];
  };
}

// ---------- Main Component ----------

function DisplaySettings() {
  const { call, useEvent } = useBackend("display-settings");

  const [info, setInfo] = useState<DisplayInfo | null>(null);
  const [saturation, setSaturation] = useState(100);
  const [brightness, setBrightness] = useState(100);

  useEvent({
    event: "stateChanged",
    handler: (data) => {
      const state = data as DisplayState;
      setSaturation(state.saturation);
      setBrightness(state.brightness);
    },
  });

  useEffect(() => {
    call("getDisplayInfo")
      .then((result) => {
        const data = result as DisplayInfo;
        setInfo(data);
        setSaturation(data.saturation);
        setBrightness(data.brightness);
      })
      .catch(() => {});
  }, [call]);

  // Debounce slider writes so we don't fire one RPC per drag-tick.
  const debounce = useRef<{ saturation?: ReturnType<typeof setTimeout>; brightness?: ReturnType<typeof setTimeout> }>({});

  const handleSaturation = useCallback(
    (value: number) => {
      setSaturation(value);
      if (debounce.current.saturation) clearTimeout(debounce.current.saturation);
      debounce.current.saturation = setTimeout(() => {
        call("setSaturation", value).catch(() => {});
      }, 50);
    },
    [call],
  );

  const handleBrightness = useCallback(
    (value: number) => {
      setBrightness(value);
      if (debounce.current.brightness) clearTimeout(debounce.current.brightness);
      debounce.current.brightness = setTimeout(() => {
        call("setBrightness", value).catch(() => {});
      }, 50);
    },
    [call],
  );

  const handleReset = useCallback(() => {
    call("resetDefaults");
  }, [call]);

  useEffect(
    () => () => {
      if (debounce.current.saturation) clearTimeout(debounce.current.saturation);
      if (debounce.current.brightness) clearTimeout(debounce.current.brightness);
    },
    [],
  );

  const methodLabel =
    info?.method === "gamescope" ? "Gamescope" : "No display control detected";
  const m = info?.method;
  const saturationSupported = m === "gamescope";
  const brightnessUnsupported = info !== null && !info.backlightPath;

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Display</div>
              <span className="chip">{methodLabel}</span>
            </div>
          </div>

          {/* Brightness */}
          <div className="subsection">
            {brightnessUnsupported && (
              <Alert
                variant="warning"
                icon={<FaTriangleExclamation size={16} />}
                title="No backlight detected"
              >
                Couldn't find a /sys/class/backlight/* device. Brightness
                slider has no hardware to drive — common on external
                monitors or VMs.
              </Alert>
            )}
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
            {!saturationSupported && (
              <Alert
                variant="warning"
                icon={<FaTriangleExclamation size={16} />}
                title="Saturation requires gamescope"
              >
                Saturation only applies under gamescope (Steam Deck
                Gaming Mode, Bazzite-Deck Gaming Mode, ChimeraOS console
                mode). The slider value is stored but won't affect your
                display on this session.
              </Alert>
            )}
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
              <span>sRGB</span>
              <span>Vivid</span>
            </div>
          </div>

          {/* Info + Reset */}
          <div className="subsection">
            {info?.backlightPath && (
              <div className="row">
                <span className="row-label">Backlight</span>
                <span className="row-value">{info.backlightPath}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-3.5 mt-3.5 border-t border-base-300">
              <div className="subsection-desc m-0">
                Changes apply live. Brightness works on any backlight
                device; saturation requires gamescope.
              </div>
              <Button onClick={handleReset}>Reset to defaults</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Homepage widget — brightness slider only ----------

function DisplayHomeWidget() {
  const { call } = useBackend("display-settings");
  const [brightness, setBrightness] = useState<number>(100);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    call("getDisplayInfo")
      .then((result) => {
        const state = result as DisplayState;
        setBrightness(state.brightness);
      })
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
        <div className="metric-value mono">{Math.round(brightness)}</div>
        <div className="metric-unit">% brightness</div>
      </div>
      <Slider
        value={brightness}
        min={0}
        max={100}
        step={1}
        onChange={(val) => {
          setBrightness(val);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            call("setBrightness", val).catch(() => {});
          }, 500);
        }}
      />
    </div>
  );
}

// ---------- Header ----------

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Display Settings
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Brightness + saturation
      </span>
    </div>
  );
}

// ---------- Mount entry points ----------

export const mount = mountComponent(DisplaySettings);
export const mountHomeWidget = mountComponent(DisplayHomeWidget);
export const mountHeader = mountComponent(Header);
