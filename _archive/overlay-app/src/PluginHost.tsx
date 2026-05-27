import { useState, useEffect, useRef, useCallback } from "react";
import { useFocusable, FocusContext } from "./GamepadNav";
import type { PluginInfo } from "./hooks/usePlugins";
import { colors } from "./styles";
import {
  createErrorReport,
  copyErrorToClipboard,
  saveErrorToDownloads,
} from "./utils/error-reporter";

/**
 * Dynamically loads and renders a plugin's app.
 *
 * Each plugin bundles its own React instance and exports a `mount(container)`
 * function. PluginHost creates a div, loads the plugin bundle, and calls mount.
 * The plugin manages its own React root inside that div.
 *
 * A `parentFocusKey` is passed to mount() so the plugin can connect its
 * focusable elements into the shell's spatial-navigation tree.
 */
export function PluginHost({ plugin }: { plugin: PluginInfo }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    async function loadPlugin() {
      try {
        // Cache-bust for hot reload during development
        const url = `/plugins/${plugin.id}/app-bundle.js?t=${Date.now()}`;
        const mod = await import(/* @vite-ignore */ url);

        if (cancelled) return;

        const mount = mod.mount ?? mod.default;
        if (typeof mount !== "function") {
          throw new Error(
            `Plugin "${plugin.id}" does not export a mount function.`,
          );
        }

        // Plugin mounts its own React root into this container.
        // Pass parentFocusKey so the plugin can connect its focusable
        // elements to the shell's spatial-navigation tree.
        const unmount = mount(container, { parentFocusKey: "content" });
        unmountRef.current = typeof unmount === "function" ? unmount : null;
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error(`[loadout] Failed to load plugin "${plugin.id}":`, err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    loadPlugin();

    return () => {
      cancelled = true;
      // Unmount the plugin's React root
      if (unmountRef.current) {
        unmountRef.current();
        unmountRef.current = null;
      }
      // Clear the container
      if (container) container.innerHTML = "";
    };
  }, [plugin.id]);

  if (error) {
    return (
      <LoadErrorPanel pluginId={plugin.id} pluginName={plugin.name} errorMessage={error} />
    );
  }

  return (
    <div style={{ height: "100%", animation: "fadeIn 150ms ease-out" }}>
      {loading && (
        <div style={centeredStyle}>
          <div style={spinnerStyle} />
          <p style={loadingTextStyle}>Loading {plugin.name}...</p>
        </div>
      )}
      <div ref={containerRef} style={{ height: loading ? 0 : "100%", overflow: loading ? "hidden" : "auto" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Load Error Panel — shown when a plugin fails to load (import / mount error)
// ---------------------------------------------------------------------------

function LoadErrorPanel({
  pluginId,
  pluginName,
  errorMessage,
}: {
  pluginId: string;
  pluginName: string;
  errorMessage: string;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy Error");
  const [saveLabel, setSaveLabel] = useState("Save to ~/Downloads");

  const report = createErrorReport(
    pluginId,
    pluginName,
    new Error(errorMessage),
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyErrorToClipboard(report);
    setCopyLabel(ok ? "Copied!" : "Copy failed");
    setTimeout(() => setCopyLabel("Copy Error"), 2000);
  }, [report]);

  const handleSave = useCallback(async () => {
    const filename = await saveErrorToDownloads(report);
    if (filename) {
      setSaveLabel(`Saved ${filename}`);
    } else {
      setSaveLabel("Save failed");
    }
    setTimeout(() => setSaveLabel("Save to ~/Downloads"), 3000);
  }, [report]);

  return (
    <div style={centeredStyle}>
      <div style={errorBoxStyle}>
        <h3 style={errorTitleStyle}>Plugin failed to load</h3>
        <p style={errorMsgStyle}>{errorMessage}</p>
        <div style={errorButtonRowStyle}>
          <button style={errorActionBtnStyle} onClick={handleCopy}>
            {copyLabel}
          </button>
          <button style={errorActionBtnStyle} onClick={handleSave}>
            {saveLabel}
          </button>
        </div>
        <p style={errorHintStyle}>Check the console for details.</p>
      </div>
    </div>
  );
}

// --- Styles ---

const centeredStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  gap: 12,
  padding: 32,
};

const loadingTextStyle: React.CSSProperties = {
  fontSize: 14,
  color: colors.textSecondary,
};

const spinnerStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  border: "3px solid #3d4450",
  borderTopColor: colors.accent,
  borderRadius: "50%",
  animation: "spin 0.8s linear infinite",
};

const errorBoxStyle: React.CSSProperties = {
  background: "#2a1a1a",
  border: "1px solid #6b2020",
  borderRadius: 8,
  padding: 24,
  maxWidth: 400,
  textAlign: "center",
};

const errorTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#ff6b6b",
  margin: "0 0 8px 0",
};

const errorMsgStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.text,
  margin: "0 0 12px 0",
  wordBreak: "break-word",
};

const errorHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: colors.textSecondary,
  margin: "8px 0 0 0",
};

const errorButtonRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "center",
  flexWrap: "wrap",
  marginTop: 4,
};

const errorActionBtnStyle: React.CSSProperties = {
  background: colors.border,
  border: "none",
  borderRadius: 6,
  color: colors.text,
  fontSize: 12,
  fontWeight: 500,
  padding: "6px 12px",
  cursor: "pointer",
  transition: "background 0.12s",
};
