import { useCallback, useEffect, useRef, useState } from "react";
import {
  FaArrowsRotate,
  FaCheck,
  FaCircle,
  FaCircleExclamation,
  FaDownload,
  FaGamepad,
  FaPlug,
  FaPowerOff,
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
  WakeStatus,
  WakeButtonOption,
  WakeOpResult,
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

        <WakeButtonSection />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay wake button picker
// ---------------------------------------------------------------------------

/** One selectable button row — gamepad-focusable, shows a check when active. */
function WakeOptionRow({
  label,
  sublabel,
  active,
  disabled,
  onSelect,
  icon,
}: {
  label: string;
  sublabel?: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      onClick={onSelect}
      disabled={disabled}
      className={`btn btn-sm justify-start w-full ${
        active ? "btn-primary" : "btn-ghost"
      } ${focused ? "ring-2 ring-primary/40" : ""}`}
    >
      {active ? (
        <FaCheck className="w-3 h-3 mr-2 shrink-0" />
      ) : (
        <span className="w-3 mr-2 shrink-0 inline-flex justify-center">
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
      {sublabel && (
        <span className="ml-auto text-[11px] opacity-60 pl-2">{sublabel}</span>
      )}
    </button>
  );
}

function WakeButtonSection() {
  const { call, useEvent } = useBackend("input-plumber");
  const [wake, setWake] = useState<WakeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setWake((await call("getWakeStatus")) as WakeStatus);
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEvent({
    event: "wake-status",
    handler: (data) => setWake(data as WakeStatus),
  });

  const runOp = useCallback(
    async (method: string, arg?: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = (await call(method, arg)) as WakeOpResult | WakeStatus;
        if ("ok" in r && !r.ok) setError(r.error ?? "Operation failed.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [call, refresh],
  );

  const cardWrap = (body: React.ReactNode) => (
    <div className="card mt-3.5">
      <div className="card-body p-4.5">
        <div className="flex items-center gap-2 mb-2">
          <FaGamepad className="w-4 h-4 shrink-0 text-base-content/60" />
          <div className="subsection-label mb-0">Overlay wake button</div>
        </div>
        <div className="subsection-desc">
          Pick the physical button that opens the Loadout overlay in-game. Any
          handheld InputPlumber supports works — paddles, the Quick Access /
          keyboard button, or any extra button. The choice is bound to the
          overlay&apos;s wake key (F16) and takes effect immediately.
        </div>
        {body}
        {error && (
          <div
            className="subsection-desc mt-2"
            style={{ color: "var(--color-error)" }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );

  if (!wake) {
    return cardWrap(
      <div className="flex items-center justify-center h-10 mt-2">
        <Spinner size={18} />
      </div>,
    );
  }

  // InputPlumber not running yet.
  if (!wake.ipActive) {
    if (wake.isDeck) {
      return cardWrap(
        <div className="mt-3">
          <div className="subsection-desc mb-2">
            InputPlumber ships disabled on Steam Deck. Enable it to detect your
            controller&apos;s buttons (your gamepad keeps working — Loadout just
            adds a keyboard target for the wake key).
          </div>
          <FocusButton
            onClick={() => void runOp("prepareWake")}
            disabled={busy}
            variant="primary"
          >
            {busy ? "Enabling…" : "Enable & detect buttons"}
          </FocusButton>
        </div>,
      );
    }
    return cardWrap(
      <div className="subsection-desc mt-3 text-base-content/60">
        InputPlumber isn&apos;t running. Install or start it above, then a
        button picker will appear here.
      </div>,
    );
  }

  if (wake.devices.length === 0) {
    return cardWrap(
      <div className="subsection-desc mt-3 text-base-content/60">
        No controller detected by InputPlumber. Connect your handheld&apos;s
        controller and refresh.
      </div>,
    );
  }

  return cardWrap(
    <div className="mt-3 flex flex-col gap-3">
      {wake.devices.map((device) => {
        const recommended = device.buttons.filter((b) => b.recommended);
        const other = device.buttons.filter((b) => !b.recommended);
        const renderRow = (b: WakeButtonOption) => (
          <WakeOptionRow
            key={b.raw}
            label={b.label}
            sublabel={b.category === "keyboard" ? "keyboard" : undefined}
            active={wake.selectedRaw === b.raw}
            disabled={busy}
            onSelect={() => void runOp("setWakeButton", b.raw)}
          />
        );
        return (
          <div key={device.name} className="flex flex-col gap-1.5">
            {wake.devices.length > 1 && (
              <div className="subsection-desc text-[11px] uppercase tracking-wide opacity-50">
                {device.name}
              </div>
            )}
            {recommended.map(renderRow)}
            {other.length > 0 && (
              <>
                <div className="subsection-desc text-[11px] uppercase tracking-wide opacity-40 mt-1">
                  Other buttons (may interfere with gameplay)
                </div>
                {other.map(renderRow)}
              </>
            )}
          </div>
        );
      })}
      <WakeOptionRow
        label="Off — no wake button"
        active={wake.selectedRaw === null}
        disabled={busy}
        onSelect={() => void runOp("clearWakeButton")}
        icon={<FaPowerOff className="w-3 h-3 opacity-60" />}
      />
    </div>,
  );
}

export const mount = mountComponent(InputPlumberPanel);
export const mountHeader = mountHeaderStub;
