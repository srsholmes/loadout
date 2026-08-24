import { useState, useEffect, useCallback } from "react";
import { FaGamepad, FaTriangleExclamation } from "react-icons/fa6";
import {
  Alert,
  Button,
  SegmentedItem,
  Spinner,
  notify,
  useBackend,
  mountComponent,
} from "@loadout/ui";
import { FALLBACK_RANGE, intensityLabel } from "./lib/rumble";

export const icon = FaGamepad;

interface VibrationInfo {
  available: boolean;
  devicePath: string | null;
  min: number;
  max: number;
  intensity: number | null;
  source: "stored" | "driver" | null;
}

function levels(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function Vibration() {
  const { call, useEvent } = useBackend("vibration");
  const [info, setInfo] = useState<VibrationInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    call("getInfo")
      .then((d) => setInfo(d as VibrationInfo))
      .finally(() => setLoading(false));
  }, [call]);

  useEvent({
    event: "hardwareChanged",
    handler: useCallback((data: unknown) => setInfo(data as VibrationInfo), []),
  });

  const handleSet = useCallback(
    async (level: number) => {
      setBusy(true);
      // Optimistic: the write is a single sysfs poke and the segmented
      // control should not lag the user's thumb.
      setInfo((prev) => (prev ? { ...prev, intensity: level, source: "stored" } : prev));
      try {
        // Defensive: an RPC that resolves null (method missing, transport
        // hiccup) must read as a failure, not throw out of an onSelect
        // handler where nothing would catch it.
        const res = (await call("setIntensity", level)) as
          | { success: boolean; error?: string; info?: VibrationInfo }
          | null;
        if (!res?.success) {
          notify(res?.error ?? "Couldn't change the rumble intensity.", { kind: "error" });
          setInfo((await call("getInfo")) as VibrationInfo);
        } else if (res.info) {
          setInfo(res.info);
        }
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const handleRescan = useCallback(async () => {
    setBusy(true);
    try {
      setInfo((await call("rescan")) as VibrationInfo);
    } finally {
      setBusy(false);
    }
  }, [call]);

  if (loading) {
    return (
      <div className="p-7 h-full flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const min = info?.min ?? FALLBACK_RANGE.min;
  const max = info?.max ?? FALLBACK_RANGE.max;

  if (!info?.available) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <Alert
          variant="warning"
          icon={<FaTriangleExclamation size={14} />}
          title="No rumble control found"
        >
          <div className="flex flex-col gap-3">
            <div className="leading-relaxed">
              Nothing on this device exposes{" "}
              <span className="mono">rumble_intensity</span>. That usually means one of:
            </div>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li>
                the <span className="mono">hid-oxp</span> driver isn&apos;t loaded — it needs a
                kernel carrying it, and it can be blacklisted (the Apex plugin offers to remove
                that blacklist)
              </li>
              <li>this is a first-generation OneXPlayer, where the driver exposes RGB only</li>
              <li>this isn&apos;t a OneXPlayer-family handheld</li>
            </ul>
            <div>
              <Button onClick={handleRescan} disabled={busy}>
                {busy ? "Checking…" : "Check again"}
              </Button>
            </div>
          </div>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-7 h-full overflow-y-auto flex flex-col gap-5">
      <div className="card">
        <div className="card-body p-6 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <div className="metric-label">Rumble intensity</div>
            <div className="mono text-sm">
              {info.intensity === null ? "—" : intensityLabel(info.intensity, { min, max })}
            </div>
          </div>

          <div className="segmented flex">
            {levels(min, max).map((level) => (
              <SegmentedItem
                key={level}
                active={info.intensity === level}
                onSelect={() => handleSet(level)}
              >
                {level === min ? "Off" : String(level)}
              </SegmentedItem>
            ))}
          </div>

          <div className="text-xs text-base-content/55 leading-relaxed">
            A master level for the built-in gamepad&apos;s motors, applied by the firmware. Games
            and Steam Input still decide what rumbles and how strongly — this scales all of it,
            including in titles that ignore Steam&apos;s own rumble setting.
          </div>

          {info.source === "driver" && (
            <div className="text-xs text-base-content/45 leading-relaxed">
              Showing the driver&apos;s current value. It resets to maximum whenever the driver
              reloads, so it may not match what you last felt — pick a level to pin it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Homepage widget — the level, and one tap to silence or restore it. */
function VibrationWidget() {
  const { call, useEvent } = useBackend("vibration");
  const [info, setInfo] = useState<VibrationInfo | null>(null);

  useEffect(() => {
    call("getInfo").then((d) => setInfo(d as VibrationInfo));
  }, [call]);

  useEvent({
    event: "hardwareChanged",
    handler: useCallback((data: unknown) => setInfo(data as VibrationInfo), []),
  });

  if (!info?.available) return null;

  const min = info.min;
  const max = info.max;
  const current = info.intensity ?? max;

  return (
    <div className="card-body">
      <div className="flex items-center gap-2">
        <FaGamepad className="w-3.5 h-3.5 opacity-60" />
        <div className="metric-value mono">{intensityLabel(current, { min, max })}</div>
        <div className="metric-unit">RUMBLE</div>
      </div>
      <div className="segmented flex mt-3">
        {levels(min, max).map((level) => (
          <SegmentedItem
            key={level}
            active={current === level}
            onSelect={() => {
              setInfo((prev) => (prev ? { ...prev, intensity: level } : prev));
              void call("setIntensity", level);
            }}
          >
            {level === min ? "Off" : String(level)}
          </SegmentedItem>
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">Vibration</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Gamepad rumble intensity
      </span>
    </div>
  );
}

export const mount = mountComponent(Vibration);
export const mountHomeWidget = mountComponent(VibrationWidget);
export const mountHeader = mountComponent(Header);
