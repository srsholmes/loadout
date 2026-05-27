import { Component, type ReactNode, type CSSProperties } from "react";
import { useState, useCallback } from "react";
import { colors } from "./styles";
import {
  createErrorReport,
  formatErrorReport,
  copyErrorToClipboard,
  saveErrorToDownloads,
  type ErrorReport,
} from "./utils/error-reporter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  pluginId: string;
  pluginName: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Error Boundary (class component — required by React)
// ---------------------------------------------------------------------------

/**
 * Catches rendering errors in plugin UIs and shows a dark-themed error panel
 * with reporting options. Each plugin is wrapped in its own boundary so a
 * single plugin crash does not kill the whole overlay.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[loadout] ErrorBoundary caught error in plugin "${this.props.pluginId}":`,
      error,
      errorInfo,
    );
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      const report = createErrorReport(
        this.props.pluginId,
        this.props.pluginName,
        this.state.error,
      );

      return (
        <ErrorPanel
          report={report}
          onReload={this.handleReload}
        />
      );
    }

    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Error Panel (functional component for the UI)
// ---------------------------------------------------------------------------

function ErrorPanel({
  report,
  onReload,
}: {
  report: ErrorReport;
  onReload: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy Error");
  const [saveLabel, setSaveLabel] = useState("Save to ~/Downloads");

  const formattedReport = formatErrorReport(report);

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
    <div style={panelContainerStyle}>
      <div style={panelStyle}>
        {/* Error icon */}
        <div style={errorIconStyle}>!</div>

        <h3 style={errorTitleStyle}>
          {report.pluginName} encountered an error
        </h3>

        <p style={errorMessageStyle}>{report.errorMessage}</p>

        <p style={errorTimestampStyle}>
          {new Date(report.timestamp).toLocaleString()}
        </p>

        {/* Show details toggle */}
        <button
          style={linkButtonStyle}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide Details" : "Show Details"}
        </button>

        {showDetails && (
          <div style={detailsContainerStyle}>
            <div style={detailRowStyle}>
              <span style={detailLabelStyle}>Plugin:</span>
              <span style={detailValueStyle}>
                {report.pluginName} ({report.pluginId})
              </span>
            </div>
            <div style={detailRowStyle}>
              <span style={detailLabelStyle}>Version:</span>
              <span style={detailValueStyle}>{report.steamLoaderVersion}</span>
            </div>
            <div style={detailRowStyle}>
              <span style={detailLabelStyle}>Platform:</span>
              <span style={detailValueStyle}>{report.platform}</span>
            </div>
            <pre style={stackTraceStyle}>{report.stackTrace}</pre>
          </div>
        )}

        {/* Action buttons */}
        <div style={buttonRowStyle}>
          <button style={actionButtonStyle} onClick={handleCopy}>
            {copyLabel}
          </button>
          <button style={actionButtonStyle} onClick={handleSave}>
            {saveLabel}
          </button>
          <button style={reloadButtonStyle} onClick={onReload}>
            Reload Plugin
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelContainerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: 32,
};

const panelStyle: CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  padding: 28,
  maxWidth: 520,
  width: "100%",
  textAlign: "center",
};

const errorIconStyle: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  background: `${colors.error}22`,
  color: colors.error,
  fontSize: 22,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 14,
};

const errorTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#ffffff",
  margin: "0 0 8px 0",
};

const errorMessageStyle: CSSProperties = {
  fontSize: 13,
  color: colors.text,
  margin: "0 0 6px 0",
  wordBreak: "break-word",
  lineHeight: 1.5,
};

const errorTimestampStyle: CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
  margin: "0 0 14px 0",
};

const linkButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: colors.accent,
  fontSize: 12,
  cursor: "pointer",
  padding: "4px 0",
  marginBottom: 10,
  textDecoration: "underline",
};

const detailsContainerStyle: CSSProperties = {
  textAlign: "left",
  marginBottom: 16,
};

const detailRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "3px 0",
  fontSize: 12,
};

const detailLabelStyle: CSSProperties = {
  color: colors.textSecondary,
  fontWeight: 500,
  flexShrink: 0,
};

const detailValueStyle: CSSProperties = {
  color: colors.text,
  wordBreak: "break-word",
};

const stackTraceStyle: CSSProperties = {
  background: colors.background,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  padding: 14,
  fontSize: 11,
  fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
  color: colors.textSecondary,
  textAlign: "left",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 200,
  overflowY: "auto",
  marginTop: 10,
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "center",
  flexWrap: "wrap",
};

const actionButtonStyle: CSSProperties = {
  background: colors.border,
  border: "none",
  borderRadius: 6,
  color: colors.text,
  fontSize: 12,
  fontWeight: 500,
  padding: "8px 14px",
  cursor: "pointer",
  transition: "background 0.12s",
};

const reloadButtonStyle: CSSProperties = {
  background: colors.accent,
  border: "none",
  borderRadius: 6,
  color: "#ffffff",
  fontSize: 12,
  fontWeight: 600,
  padding: "8px 14px",
  cursor: "pointer",
  transition: "background 0.12s",
};
