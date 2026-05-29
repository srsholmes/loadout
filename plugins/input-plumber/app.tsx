import { useCallback, useEffect, useRef, useState } from "react";
import {
  FaArrowsRotate,
  FaCheck,
  FaCircle,
  FaCircleExclamation,
  FaDownload,
  FaPlug,
} from "react-icons/fa6";
import {
  mountComponent,
  mountHeaderStub,
  Spinner,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import type {
  InstallLogEvent,
  InstallRunResult,
  InstallStateEvent,
  InstallStatus,
} from "./shared";

export const icon = FaPlug;

// Hard cap on retained install-log lines. Chatty installs (pacman/dnf
// with verbose output, a tarball fallback streaming hundreds of lines)
// would otherwise blow the React state heap. When we hit the cap we
// drop the oldest lines in a single `slice` instead of allocating a
// fresh array per chunk — one allocation on overflow vs one per push.
const LOG_CAP = 500;

// ---------------------------------------------------------------------------
// Tiny gamepad-friendly button
// ---------------------------------------------------------------------------

function FocusButton({
  onClick,
  disabled,
  children,
  variant = "default",
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "default" | "primary" | "ghost";
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onClick });
  const base =
    "btn btn-sm " +
    (variant === "primary" ? "btn-primary" : variant === "ghost" ? "btn-ghost" : "");
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${focused ? "ring-2 ring-primary/40" : ""}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function InputPlumberPanel() {
  const { call, useEvent } = useBackend("input-plumber");
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<InstallRunResult | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    const s = (await call("getStatus")) as InstallStatus;
    setStatus(s);
    const r = (await call("isInstallRunning")) as { running: boolean };
    setRunning(r.running);
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEvent({
    event: "input-plumber-status",
    handler: (data) => setStatus(data as InstallStatus),
  });

  useEvent({
    event: "install-log",
    handler: (data) => {
      const ev = data as InstallLogEvent;
      setLogs((prev) => {
        // Below the cap: still a fresh array (React state has to be
        // referentially new to re-render), but no re-slice.
        if (prev.length < LOG_CAP) return [...prev, ev.text];
        // At/over the cap: drop the oldest line, keep the new one.
        // One slice + one push, regardless of how chatty the install
        // gets — bounded GC pressure per log chunk.
        const next = prev.slice(prev.length - LOG_CAP + 1);
        next.push(ev.text);
        return next;
      });
      requestAnimationFrame(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  });

  useEvent({
    event: "install-state",
    handler: (data) => {
      const ev = data as InstallStateEvent;
      setRunning(ev.running);
      if (!ev.running && ev.result) {
        setLastResult(ev.result);
        // Re-probe once systemd settles after the run.
        setTimeout(() => void refresh(), 500);
      }
    },
  });

  const start = useCallback(async () => {
    setLogs([]);
    setLastResult(null);
    setRunning(true);
    const r = (await call("startInstall")) as {
      started: boolean;
      error?: string;
    };
    if (!r.started) {
      setRunning(false);
      setLogs((prev) => [
        ...prev,
        `[error] could not start: ${r.error ?? "unknown"}\n`,
      ]);
    }
  }, [call]);

  if (!status) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-4.5">
              <div className="flex items-center justify-center h-16">
                <Spinner size={20} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const chipText = status.installed
    ? status.serviceActive
      ? "Active"
      : "Installed"
    : "Not installed";
  const chipTone = status.installed
    ? status.serviceActive
      ? "success"
      : "accent"
    : "muted";
  const buttonLabel = running
    ? status.installed
      ? "Reinstalling…"
      : "Installing…"
    : status.installed
      ? "Reinstall"
      : "Install InputPlumber";
  const disabled = running || !status.scriptPresent;
  const logText = logs.join("");

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-4.5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <FaDownload className="w-4 h-4 shrink-0 text-base-content/60" />
            <div className="subsection-label mb-0 truncate">
              InputPlumber
            </div>
          </div>
          <span
            className={
              "chip " +
              (chipTone === "success"
                ? "chip-success"
                : chipTone === "accent"
                  ? "chip-accent"
                  : "")
            }
          >
            {status.installed && status.serviceActive ? (
              <FaCheck className="w-3 h-3 mr-1 inline" />
            ) : status.installed ? (
              <FaCircle className="w-2 h-2 mr-1 inline" />
            ) : (
              <FaCircleExclamation className="w-3 h-3 mr-1 inline" />
            )}
            {chipText}
          </span>
        </div>

        <div className="subsection-desc">
          Installs the InputPlumber input-routing daemon for distros that
          don't ship it. Tries the system package manager first
          (pacman on Arch/CachyOS, dnf on mutable Fedora). Falls back to
          the latest upstream release tarball, installed under
          /var/lib/inputplumber so it survives ostree deployment switches.
          Idempotent — re-run to update or repair an existing install.
        </div>
        <div className="subsection-desc mt-1.5 text-base-content/50">
          {status.summary}
        </div>

        <div className="subsection-desc mono text-[11px] mt-2 text-base-content/40">
          {status.binaryPath ?? "no binary"}
          {status.version ? ` · v${status.version}` : ""}
          {" · service "}
          {status.serviceActive ? "active" : "inactive"}
          {" · "}
          {status.serviceEnabled ? "enabled" : "not enabled"}
        </div>

        {!status.scriptPresent && (
          <div
            className="subsection-desc mt-2"
            style={{ color: "var(--color-error)" }}
          >
            Install script missing from plugin directory — reinstall the
            plugin.
          </div>
        )}

        {lastResult && (
          <div
            className="subsection-desc mt-2"
            style={{
              color: lastResult.success ? undefined : "var(--color-error)",
            }}
          >
            {lastResult.success
              ? `Last run succeeded in ${lastResult.durationSeconds}s.`
              : `Last run failed: ${lastResult.error ?? "exit " + lastResult.exitCode}`}
          </div>
        )}

        <div className="flex gap-2 mt-3.5 flex-wrap">
          <FocusButton onClick={() => void start()} disabled={disabled} variant="primary">
            {buttonLabel}
          </FocusButton>
          <FocusButton onClick={() => void refresh()} disabled={running} variant="ghost">
            <FaArrowsRotate className="w-3 h-3 mr-1" /> Refresh
          </FocusButton>
        </div>

        {(logs.length > 0 || running) && (
          <pre
            ref={logRef}
            className="mono text-[11px] mt-3"
            style={{
              background: "var(--bg-2, rgba(255,255,255,0.04))",
              borderRadius: 8,
              padding: "8px 10px",
              maxHeight: 260,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              margin: 0,
              color: "var(--fg-1, rgba(255,255,255,0.8))",
            }}
          >
            {logText || "waiting for output…"}
          </pre>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

export const mount = mountComponent(InputPlumberPanel);
export const mountHeader = mountHeaderStub;
