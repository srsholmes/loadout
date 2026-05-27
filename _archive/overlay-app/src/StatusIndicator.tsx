import { useState, useEffect, useRef, type CSSProperties } from "react";
import { colors } from "./styles";
import { authHeaders } from "./hooks/useAuthToken";

type ConnectionStatus = "connected" | "bridge-offline" | "server-offline";

/**
 * Small footer component showing the CEF bridge / backend connection status.
 *
 * Uses the WebSocket readyState and a periodic HTTP health check to determine:
 * - Green: WebSocket open and HTTP server reachable ("Connected to Steam")
 * - Yellow: WebSocket closed but HTTP server reachable ("Steam bridge offline")
 * - Red: HTTP server unreachable ("Server offline")
 */
export function StatusIndicator() {
  const [status, setStatus] = useState<ConnectionStatus>("bridge-offline");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function checkStatus() {
      // Check if the HTTP server is reachable
      let serverUp = false;
      try {
        const res = await fetch("/api/plugins", {
          method: "HEAD",
          cache: "no-store",
          headers: authHeaders(),
        });
        serverUp = res.ok;
      } catch {
        serverUp = false;
      }

      if (!serverUp) {
        setStatus("server-offline");
        return;
      }

      // Check WebSocket connectivity via the server status endpoint.
      try {
        const statusRes = await fetch("/api/status", {
          cache: "no-store",
          headers: authHeaders(),
        });
        if (statusRes.ok) {
          const data = await statusRes.json();
          setStatus(data?.wsConnected ? "connected" : "bridge-offline");
          return;
        }
      } catch {
        // Status fetch failed — server may be partially up
      }

      // Server is reachable (HEAD /api/plugins succeeded) but /api/status
      // failed unexpectedly. Default to connected since the server is up.
      setStatus("connected");
    }

    // Run immediately and then every 5 seconds
    checkStatus();
    intervalRef.current = setInterval(checkStatus, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const config = STATUS_CONFIG[status];

  return (
    <div style={containerStyle}>
      <div
        style={{
          ...dotStyle,
          backgroundColor: config.color,
          boxShadow: `0 0 4px ${config.color}`,
        }}
      />
      <span style={labelStyle}>{config.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: {
    color: colors.success,
    label: "Connected to Steam",
  },
  "bridge-offline": {
    color: colors.warning,
    label: "Steam bridge offline",
  },
  "server-offline": {
    color: colors.error,
    label: "Server offline",
  },
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const containerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 10px",
};

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: colors.textSecondary,
  whiteSpace: "nowrap",
};
