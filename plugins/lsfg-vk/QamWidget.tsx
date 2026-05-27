// Quick-access overlay (QAM) widget — the compact, four-cell
// multiplier picker shown on the overlay home screen / QAM. Lives in
// its own module so the main `app.tsx` doesn't carry the home-widget
// surface area alongside the full settings UI.
//
// Extracted from app.tsx as part of the D-010 decomposition. No
// behaviour change: same RPC method names, same event names, same
// useFocusable wiring as before.

import { useCallback, useEffect, useState } from "react";
import { Spinner, useBackend, useFocusable } from "@loadout/ui";

import { MULTIPLIER_OPTIONS } from "./lib/constants";
import type { FullStatus, LsfgSettings } from "./lib/types";

export function QamWidget() {
  const { call, useEvent } = useBackend("lsfg-vk");

  const [installed, setInstalled] = useState(false);
  const [multiplier, setMultiplier] = useState<number>(2);
  const [loading, setLoading] = useState(true);

  useEvent({
    event: "installChanged",
    handler: (data) => {
      const d = data as { installed?: boolean };
      if (typeof d?.installed === "boolean") setInstalled(d.installed);
    },
  });
  useEvent({
    event: "settingsChanged",
    handler: (data) => {
      const d = data as Partial<LsfgSettings>;
      if (typeof d?.multiplier === "number") setMultiplier(d.multiplier);
    },
  });

  useEffect(() => {
    call("getStatus")
      .then((s) => {
        const status = s as FullStatus | null | undefined;
        setInstalled(!!status?.install?.installed);
        if (typeof status?.settings?.multiplier === "number") {
          setMultiplier(status.settings.multiplier);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [call]);

  const handlePick = useCallback(
    (value: number) => {
      setMultiplier(value);
      call("updateSettings", { multiplier: value }).catch(() => {});
    },
    [call],
  );

  if (loading) {
    return (
      <div className="px-3.5 py-2.5">
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
            LSFG-VK
          </span>
          <Spinner size={14} />
        </div>
      </div>
    );
  }

  return (
    <div className="px-3.5 py-2.5 flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
          LSFG-VK
        </span>
        {installed ? (
          <span className="text-xs text-success">Installed</span>
        ) : (
          <span className="text-xs text-error">Not installed</span>
        )}
      </div>
      {installed && (
        <div
          role="radiogroup"
          aria-label="Frame generation multiplier"
          className="grid grid-cols-4 gap-1 rounded-md bg-base-300/50 p-1"
        >
          {MULTIPLIER_OPTIONS.map(([value, label]) => (
            <QamMultiplierRadio
              key={value}
              label={label}
              active={multiplier === value}
              onSelect={() => handlePick(value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QamMultiplierRadio({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={
        "h-7 rounded text-xs font-semibold transition-all " +
        (active
          ? "bg-primary text-primary-content"
          : "text-base-content/70 hover:bg-base-100/40") +
        (focused ? " ring-2 ring-[var(--accent)]" : "")
      }
    >
      {label}
    </button>
  );
}
