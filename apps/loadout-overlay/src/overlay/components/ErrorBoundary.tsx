import { Component, type ReactNode } from "react";
import { useState, useCallback } from "react";
import {
  createErrorReport,
  copyErrorToClipboard,
  saveErrorToDownloads,
  type ErrorReport,
} from "../utils/error-reporter";

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

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[loadout] ErrorBoundary caught error in plugin "${this.props.pluginId}":`,
      error,
      errorInfo,
    );
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
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
    <div className="flex items-center justify-center h-full p-8">
      <div className="bg-surface border border-base-300 rounded-xl p-7 max-w-[520px] w-full text-center">
        {/* Error icon */}
        <div className="w-11 h-11 rounded-full bg-error/[0.13] text-error text-[22px] font-bold inline-flex items-center justify-center mb-3.5">
          !
        </div>

        <h3 className="text-base font-semibold text-base-content mb-2">
          {report.pluginName} encountered an error
        </h3>

        <p className="text-[13px] text-base-content mb-1.5 break-words leading-relaxed">
          {report.errorMessage}
        </p>

        <p className="text-[11px] text-base-content/60 mb-3.5">
          {new Date(report.timestamp).toLocaleString()}
        </p>

        {/* Show details toggle */}
        <button
          className="bg-transparent border-none text-accent text-xs cursor-pointer py-1 px-0 mb-2.5 underline"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide Details" : "Show Details"}
        </button>

        {showDetails && (
          <div className="text-left mb-4">
            <div className="flex gap-2 py-[3px] text-xs">
              <span className="text-base-content/60 font-medium shrink-0">Plugin:</span>
              <span className="text-base-content break-words">
                {report.pluginName} ({report.pluginId})
              </span>
            </div>
            <div className="flex gap-2 py-[3px] text-xs">
              <span className="text-base-content/60 font-medium shrink-0">Version:</span>
              <span className="text-base-content break-words">{report.loadoutVersion}</span>
            </div>
            <div className="flex gap-2 py-[3px] text-xs">
              <span className="text-base-content/60 font-medium shrink-0">Platform:</span>
              <span className="text-base-content break-words">{report.platform}</span>
            </div>
            <pre className="bg-base-100 border border-base-300 rounded-md p-3.5 text-[11px] font-mono text-base-content/60 text-left whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto mt-2.5">
              {report.stackTrace}
            </pre>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 justify-center flex-wrap">
          <button
            className="bg-base-300 border-none rounded-md text-base-content text-xs font-medium py-2 px-3.5 cursor-pointer transition-colors duration-[120ms]"
            onClick={handleCopy}
          >
            {copyLabel}
          </button>
          <button
            className="bg-base-300 border-none rounded-md text-base-content text-xs font-medium py-2 px-3.5 cursor-pointer transition-colors duration-[120ms]"
            onClick={handleSave}
          >
            {saveLabel}
          </button>
          <button
            className="bg-accent border-none rounded-md text-base-content text-xs font-semibold py-2 px-3.5 cursor-pointer transition-colors duration-[120ms]"
            onClick={onReload}
          >
            Reload Plugin
          </button>
        </div>
      </div>
    </div>
  );
}
