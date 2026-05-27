import { useState, useEffect, useRef, useCallback } from "react";
import { useBackend } from "@loadout/ui";
import { QuickMenuWidget } from "./QuickMenuWidget";
import { colors } from "./styles";

/**
 * Demo TDP control widget for the quick menu.
 * Shows a slider to set TDP (3W-30W), debounced at 100ms.
 * Displays per-game profile status when available.
 */
export function TDPWidget() {
  const { call, useEvent, ready } = useBackend("tdp-control");
  const [tdp, setTdp] = useState(15);
  const [error, setError] = useState(false);
  const [profileInfo, setProfileInfo] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch initial TDP on mount
  useEffect(() => {
    if (!ready) return;
    call("getTdp")
      .then((value) => {
        if (typeof value === "number") setTdp(value);
        setError(false);
      })
      .catch(() => setError(true));
  }, [ready, call]);

  // Subscribe to profile updates
  useEvent({
    event: "profile-update",
    handler: useCallback((data: unknown) => {
      const d = data as { game?: string; tdp?: number; mode?: string } | null;
      if (d && d.mode === "auto" && d.game) {
        setProfileInfo(`Auto: ${d.game} (${d.tdp ?? tdp}W)`);
        if (typeof d.tdp === "number") setTdp(d.tdp);
      } else {
        setProfileInfo("Manual");
      }
    }, [tdp]),
  });

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      setTdp(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        call("setTdp", value).catch(() => setError(true));
      }, 100);
    },
    [call],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (error) {
    return (
      <QuickMenuWidget title="TDP Control">
        <p style={errorStyle}>TDP unavailable</p>
      </QuickMenuWidget>
    );
  }

  return (
    <QuickMenuWidget title="TDP Control">
      <div style={valueRowStyle}>
        <span style={labelStyle}>TDP: {tdp}W</span>
        <span style={rangeStyle}>3W - 30W</span>
      </div>
      <input
        type="range"
        min={3}
        max={30}
        step={1}
        value={tdp}
        onChange={handleChange}
        style={sliderStyle}
      />
      {profileInfo && <div style={profileStyle}>{profileInfo}</div>}
    </QuickMenuWidget>
  );
}

// --- Styles ---

const valueRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: colors.text,
};

const rangeStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
};

const sliderStyle: React.CSSProperties = {
  width: "100%",
  accentColor: colors.accent,
  cursor: "pointer",
  margin: "4px 0",
};

const profileStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.accent,
  marginTop: 4,
};

const errorStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.textSecondary,
  margin: 0,
  fontStyle: "italic",
};
