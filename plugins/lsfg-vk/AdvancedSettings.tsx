// Advanced frame-generation tunables card.
//
// Owns the FG multiplier segmented control, flow-scale slider,
// performance-mode + HDR toggles, and the experimental present-mode
// select. Stateless: the parent owns `settings` and the persist
// callback, and decides whether the card is disabled (when the layer
// isn't installed yet).
//
// Extracted from app.tsx as part of the D-010 decomposition.

import { SegmentedItem, Select, Slider, Toggle } from "@loadout/ui";

import { MULTIPLIER_OPTIONS, PRESENT_MODE_OPTIONS } from "./lib/constants";
import type { LsfgSettings } from "./lib/types";

interface AdvancedSettingsProps {
  settings: LsfgSettings;
  disabled: boolean;
  onUpdateSetting: <K extends keyof LsfgSettings>(
    key: K,
    value: LsfgSettings[K],
  ) => void;
}

export function AdvancedSettings({
  settings,
  disabled,
  onUpdateSetting,
}: AdvancedSettingsProps) {
  return (
    <div className="card">
      <div className="subsection">
        <div className="subsection-label">Multiplier</div>
        <div className="segmented">
          {MULTIPLIER_OPTIONS.map(([value, label]) => (
            <SegmentedItem
              key={value}
              active={settings.multiplier === value}
              onSelect={() => onUpdateSetting("multiplier", value)}
              disabled={disabled}
            >
              {label}
            </SegmentedItem>
          ))}
        </div>
        <div className="subsection-desc">
          Off disables frame generation while keeping the wrapper in place.
          Higher multipliers squeeze more perceived FPS but require a stable
          input frame rate.
        </div>
      </div>

      <div className="subsection">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <div className="subsection-label" style={{ marginBottom: 0 }}>
            Flow Scale
          </div>
          <span className="mono" style={{ fontSize: 12 }}>
            {settings.flow_scale.toFixed(2)}
          </span>
        </div>
        <Slider
          value={Math.round(settings.flow_scale * 100)}
          min={25}
          max={100}
          step={5}
          onChange={(v) =>
            onUpdateSetting("flow_scale", Number((v / 100).toFixed(2)))
          }
          disabled={disabled}
        />
        <div className="subsection-desc">
          Motion-estimation quality. Lower = faster, higher = cleaner.
        </div>
      </div>

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
            <div className="subsection-label" style={{ marginBottom: 2 }}>
              Performance Mode
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              Lighter model — recommended for most games.
            </div>
          </div>
          <Toggle
            checked={settings.performance_mode}
            onChange={(v) => onUpdateSetting("performance_mode", v)}
            disabled={disabled}
          />
        </div>
      </div>

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
            <div className="subsection-label" style={{ marginBottom: 2 }}>
              HDR Mode
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              Only enable for games that already support HDR.
            </div>
          </div>
          <Toggle
            checked={settings.hdr_mode}
            onChange={(v) => onUpdateSetting("hdr_mode", v)}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="subsection">
        <div className="subsection-label">Present Mode (experimental)</div>
        <Select
          value={settings.experimental_present_mode}
          options={PRESENT_MODE_OPTIONS}
          onChange={(v) =>
            onUpdateSetting(
              "experimental_present_mode",
              v as LsfgSettings["experimental_present_mode"],
            )
          }
        />
        <div className="subsection-desc">
          Override Vulkan present mode. May cause crashes on some drivers.
        </div>
      </div>
    </div>
  );
}
