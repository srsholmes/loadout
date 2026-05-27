import type { CSSProperties } from "react";
import { colors } from "./styles";

interface SettingsProps {
  scale: number;
  onScaleChange: (scale: number) => void;
}

const VERSION = "0.1.0-alpha";

export function Settings({ scale, onScaleChange }: SettingsProps) {
  return (
    <div style={containerStyle}>
      <h2 style={headingStyle}>Settings</h2>

      <div style={sectionTitleStyle}>Appearance</div>
      <div style={sectionStyle}>
        <div style={rowStyle}>
          <label style={labelStyle}>UI Scale</label>
          <span style={valueStyle}>{scale.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min={0.75}
          max={2}
          step={0.05}
          value={scale}
          onChange={(e) => onScaleChange(parseFloat(e.target.value))}
          style={sliderStyle}
        />
        <div style={rangeLabelsStyle}>
          <span>0.75x</span>
          <span>1.0x</span>
          <span>2.0x</span>
        </div>
      </div>

      <div style={sectionTitleStyle}>About</div>
      <div style={sectionStyle}>
        <div style={rowStyle}>
          <label style={labelStyle}>Version</label>
          <span style={versionBadgeStyle}>{VERSION}</span>
        </div>
      </div>
    </div>
  );
}

// --- Styles ---

const containerStyle: CSSProperties = {
  padding: 24,
  height: "100%",
  overflowY: "auto",
};

const headingStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: "#ffffff",
  margin: "0 0 24px 0",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: colors.textSecondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 4px",
  marginBottom: 8,
  marginTop: 20,
};

const sectionStyle: CSSProperties = {
  background: "rgba(255, 255, 255, 0.04)",
  borderRadius: 10,
  padding: 16,
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};

const labelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: colors.text,
};

const valueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: colors.accent,
};

const sliderStyle: CSSProperties = {
  width: "100%",
  accentColor: colors.accent,
  cursor: "pointer",
};

const rangeLabelsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginTop: 6,
  fontSize: 11,
  color: colors.textSecondary,
};

const versionBadgeStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: colors.accent,
  background: `${colors.accent}18`,
  padding: "4px 10px",
  borderRadius: 12,
};
