import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FaScrewdriverWrench,
  FaMemory,
  FaMoon,
  FaBed,
  FaUsb,
  FaCheck,
  FaCircleExclamation,
  FaArrowsRotate,
  FaShuffle,
} from "react-icons/fa6";
import {
  PluginProvider,
  Spinner,
  useBackend,
  useFocusable,
} from "@loadout/ui";

export const icon = FaScrewdriverWrench;

// ---------------------------------------------------------------------------
// Types — mirror backend.ts
// ---------------------------------------------------------------------------

type FixKey = "oxpec" | "lightSleep" | "sleepEnable" | "xhciRecovery";
type FixState = "applied" | "not_applied" | "partial" | "n_a";

interface FixSummary {
  key: FixKey;
  state: FixState;
  rebootRequired: boolean;
  details: string;
}

interface ApexStatus {
  deviceModel: string;
  isApex: boolean;
  fixes: Record<FixKey, FixSummary>;
}

interface ApplyOutcome {
  success: boolean;
  steps: string[];
  error?: string;
  rebootRequired?: boolean;
}

interface RebindResult {
  success: boolean;
  gamepadPresent: boolean;
  error?: string;
  attempts: number;
}

// Mirrors src/inputplumber-migrate.ts
type MigrationStack = "inputplumber" | "hhd" | "mixed" | "none";

interface MigrationStatus {
  hidOxpLoaded: boolean;
  hidOxpServiceEnabled: boolean;
  inputplumberInstalled: boolean;
  inputplumberActive: boolean;
  inputplumberEnabled: boolean;
  hhdActive: boolean;
  hhdMasked: boolean;
  scriptsPresent: boolean;
  prebuiltKoAvailable: boolean;
  runningKernel: string;
  stack: MigrationStack;
  summary: string;
}

interface MigrationRunResult {
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  error?: string;
  durationSeconds: number;
}

interface MigrationLogEvent {
  kind: "stdout" | "stderr" | "status";
  text: string;
}

interface MigrationStateEvent {
  running: boolean;
  result?: MigrationRunResult;
}

// ---------------------------------------------------------------------------
// Fix catalogue — static copy for each card
// ---------------------------------------------------------------------------

interface FixMeta {
  key: FixKey;
  title: string;
  Icon: typeof FaMemory;
  blurb: string;
  /** Supplementary one-liner shown below the main blurb. */
  note?: string;
}

const FIX_META: FixMeta[] = [
  {
    key: "oxpec",
    title: "Fan EC Driver (oxpec)",
    Icon: FaMemory,
    blurb:
      "Loads the out-of-tree oxpec kernel module so the APEX fan becomes visible under /sys/class/hwmon. Required by Fan Control — without it, the fan page shows 'No fan hardware detected'.",
    note: "Safe to apply now. Revert unloads the module and removes the persistence service.",
  },
  {
    key: "lightSleep",
    title: "Light Sleep (s2idle)",
    Icon: FaMoon,
    blurb:
      "Adds mem_sleep_default=s2idle and amd_iommu=off to the kernel command line and strips legacy kargs that break suspend. Persists across reboots via rpm-ostree.",
    note: "Requires the BIOS setting 'ACPI Auto configuration' to be enabled. Reboot required for changes to take effect.",
  },
  {
    key: "sleepEnable",
    title: "Sleep Enable",
    Icon: FaBed,
    blurb:
      "Neutralizes fw-fanctrl-suspend (a Framework Laptop script shipped by Bazzite that errors on APEX and blocks suspend) and installs a udev rule disabling the fingerprint reader as a wake source.",
    note: "Revert removes the udev rule; fw-fanctrl-suspend only comes back on the next Bazzite ostree update.",
  },
  {
    key: "xhciRecovery",
    title: "xHCI Recovery",
    Icon: FaUsb,
    blurb:
      "Installs a systemd service that listens for wake events via dbus and rebinds the internal gamepad's USB controller (PCI 0000:65:00.4). Without this, the gamepad sometimes disappears after sleep.",
    note: "A 'Rebind now' button below triggers the same recovery manually.",
  },
];

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function StatusChip({ summary }: { summary: FixSummary }) {
  if (summary.state === "applied") {
    return (
      <span className="chip chip-success">
        <FaCheck className="w-3 h-3" /> Applied
      </span>
    );
  }
  if (summary.state === "partial") {
    return (
      <span className="chip chip-accent">
        <FaCircleExclamation className="w-3 h-3" /> Partial
      </span>
    );
  }
  if (summary.state === "n_a") {
    return <span className="chip">Not applicable</span>;
  }
  return summary.rebootRequired ? (
    <span className="chip chip-accent">Not applied · reboot required</span>
  ) : (
    <span className="chip">Not applied</span>
  );
}

// ---------------------------------------------------------------------------
// Fix card
// ---------------------------------------------------------------------------

interface FixCardProps {
  meta: FixMeta;
  summary: FixSummary;
  busy: boolean;
  onApply: () => void;
  onRevert: () => void;
  /** Extra action rendered before Apply/Revert (e.g. "Rebind now" on xHCI). */
  extraAction?: React.ReactNode;
}

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

function FixCard({ meta, summary, busy, onApply, onRevert, extraAction }: FixCardProps) {
  const disabled = summary.state === "n_a" || busy;
  const isApplied = summary.state === "applied";
  const Icon = meta.Icon;

  return (
    <div className="card">
      <div className="card-body p-4.5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 shrink-0 text-base-content/60" />
            <div className="subsection-label mb-0 truncate">{meta.title}</div>
          </div>
          <StatusChip summary={summary} />
        </div>
        <div className="subsection-desc">{meta.blurb}</div>
        {meta.note && (
          <div className="subsection-desc mt-1.5 text-base-content/50">{meta.note}</div>
        )}
        <div className="subsection-desc mono text-[11px] mt-2 text-base-content/40">
          {summary.details}
        </div>

        <div className="flex gap-2 mt-3.5 flex-wrap">
          {extraAction}
          {isApplied ? (
            <>
              <FocusButton onClick={onRevert} disabled={disabled}>
                Revert
              </FocusButton>
              <FocusButton onClick={onApply} disabled={disabled} variant="ghost">
                Reapply
              </FocusButton>
            </>
          ) : (
            <FocusButton onClick={onApply} disabled={disabled} variant="primary">
              Apply
            </FocusButton>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InputPlumber migration section
// ---------------------------------------------------------------------------

const MIGRATION_LOG_CAP = 500; // lines — capped so long runs don't grow forever

function stackLabel(stack: MigrationStack): { text: string; tone: "success" | "accent" | "error" | "muted" } {
  switch (stack) {
    case "inputplumber":
      return { text: "InputPlumber", tone: "success" };
    case "hhd":
      return { text: "HHD", tone: "accent" };
    case "mixed":
      return { text: "Both running", tone: "error" };
    case "none":
      return { text: "None", tone: "muted" };
  }
}

function MigrationSection() {
  const { call, useEvent } = useBackend("apex-fixes");
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<MigrationRunResult | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    const s = (await call("getMigrationStatus")) as MigrationStatus;
    setStatus(s);
    const r = (await call("isMigrationRunning")) as { running: boolean };
    setRunning(r.running);
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEvent({
    event: "migration-log",
    handler: (data) => {
      const ev = data as MigrationLogEvent;
      setLogs((prev) => {
        const next = [...prev, ev.text];
        // Keep only the last MIGRATION_LOG_CAP chunks.
        if (next.length > MIGRATION_LOG_CAP) {
          return next.slice(next.length - MIGRATION_LOG_CAP);
        }
        return next;
      });
      // Auto-scroll the log pane to the bottom as chunks arrive.
      requestAnimationFrame(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  });

  useEvent({
    event: "migration-state",
    handler: (data) => {
      const ev = data as MigrationStateEvent;
      setRunning(ev.running);
      if (!ev.running && ev.result) {
        setLastResult(ev.result);
        // Re-probe the status once systemd settles after the run.
        setTimeout(() => void refresh(), 500);
      }
    },
  });

  const start = useCallback(async () => {
    setLogs([]);
    setLastResult(null);
    setRunning(true); // optimistic — backend will confirm via event
    const r = (await call("startMigration")) as {
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
      <div className="card">
        <div className="card-body p-4.5">
          <div className="flex items-center justify-center h-16">
            <Spinner size={20} />
          </div>
        </div>
      </div>
    );
  }

  const label = stackLabel(status.stack);
  const logText = logs.join("");
  const disabled = running || !status.scriptsPresent;
  // Card copy switches based on whether the install already ran.
  // On InputPlumber → label is "Reinstall"; otherwise "Install".
  const installed = status.stack === "inputplumber";
  const buttonLabel = running
    ? installed
      ? "Reinstalling…"
      : "Installing…"
    : installed
      ? "Reinstall"
      : "Install InputPlumber";

  return (
    <div className="card">
      <div className="card-body p-4.5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <FaShuffle className="w-4 h-4 shrink-0 text-base-content/60" />
            <div className="subsection-label mb-0 truncate">
              InputPlumber Install
            </div>
          </div>
          <span
            className={
              "chip " +
              (label.tone === "success"
                ? "chip-success"
                : label.tone === "accent"
                  ? "chip-accent"
                  : label.tone === "error"
                    ? "chip-accent"
                    : "")
            }
          >
            {label.text}
          </span>
        </div>
        <div className="subsection-desc">
          Builds the out-of-tree hid-oxp driver, builds and installs
          InputPlumber from upstream main (the OXP HID driver work landed
          in mid-2026), masks HHD, and lays down the Apex-specific profile
          + device config. Lets you drop Decky Loader entirely. Re-run to
          update the install in place — the script is idempotent.
        </div>
        <div className="subsection-desc mt-1.5 text-base-content/50">
          {status.summary}
        </div>

        <div className="subsection-desc mono text-[11px] mt-2 text-base-content/40">
          kernel {status.runningKernel || "unknown"} · prebuilt .ko{" "}
          {status.prebuiltKoAvailable ? "✓" : "will build on install"} · hid-oxp{" "}
          {status.hidOxpLoaded ? "loaded" : "not loaded"} · service{" "}
          {status.hidOxpServiceEnabled ? "enabled" : "not enabled"} ·
          inputplumber{" "}
          {status.inputplumberInstalled
            ? status.inputplumberActive
              ? "active"
              : "installed"
            : "absent"}{" "}
          · hhd {status.hhdActive ? "active" : status.hhdMasked ? "masked" : "inactive"}
        </div>

        {!status.scriptsPresent && (
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
              ? `Last run succeeded in ${lastResult.durationSeconds}s. Reboot for the boot service to pick up hid-oxp cleanly.`
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
  );
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

function ApexFixes() {
  const { call, useEvent } = useBackend("apex-fixes");
  const [status, setStatus] = useState<ApexStatus | null>(null);
  const [busyKey, setBusyKey] = useState<FixKey | null>(null);
  const [lastMessage, setLastMessage] = useState<{
    kind: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  useEvent({
    event: "apex-status",
    handler: (data) => setStatus(data as ApexStatus),
  });

  useEffect(() => {
    call("getStatus").then((s) => setStatus(s as ApexStatus));
  }, [call]);

  const runAction = useCallback(
    async (
      key: FixKey,
      action: "apply" | "revert",
      rpc: "applyFix" | "revertFix",
    ) => {
      setBusyKey(key);
      setLastMessage(null);
      try {
        const result = (await call(rpc, key)) as ApplyOutcome;
        if (result.success) {
          let text =
            action === "apply"
              ? `Applied: ${result.steps.join("; ") || "ok"}`
              : `Reverted: ${result.steps.join("; ") || "ok"}`;
          if (result.rebootRequired) text += " — reboot required";
          setLastMessage({ kind: result.rebootRequired ? "info" : "ok", text });
        } else {
          setLastMessage({
            kind: "err",
            text: `${action} failed: ${result.error ?? "unknown"}`,
          });
        }
        // Refresh status immediately after the RPC returns.
        const fresh = (await call("getStatus")) as ApexStatus;
        setStatus(fresh);
      } catch (err) {
        setLastMessage({
          kind: "err",
          text: `${action} threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setBusyKey(null);
      }
    },
    [call],
  );

  const rebindNow = useCallback(async () => {
    setBusyKey("xhciRecovery");
    setLastMessage(null);
    try {
      const result = (await call("rebindXhciNow")) as RebindResult;
      if (result.success) {
        setLastMessage({
          kind: "ok",
          text: `Gamepad recovered after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}.`,
        });
      } else {
        setLastMessage({
          kind: "err",
          text: `Rebind failed: ${result.error ?? "unknown"}`,
        });
      }
      const fresh = (await call("getStatus")) as ApexStatus;
      setStatus(fresh);
    } finally {
      setBusyKey(null);
    }
  }, [call]);

  if (!status) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size={32} />
      </div>
    );
  }

  if (!status.isApex) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-6">
              <div className="subsection-label mb-2">Not on APEX hardware</div>
              <div className="subsection-desc">
                These fixes are specific to the OneXPlayer APEX. DMI reports{" "}
                <span className="mono">{status.deviceModel || "unknown"}</span>.
                The plugin stays inert here — no system state is touched.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {lastMessage && (
          <div
            className="card"
            style={{
              borderColor:
                lastMessage.kind === "err"
                  ? "var(--color-error)"
                  : lastMessage.kind === "info"
                    ? "var(--accent)"
                    : undefined,
            }}
          >
            <div
              className="card-body p-3.5"
              style={{
                color:
                  lastMessage.kind === "err"
                    ? "var(--color-error)"
                    : undefined,
              }}
            >
              <div className="text-sm">{lastMessage.text}</div>
            </div>
          </div>
        )}

        {FIX_META.map((meta) => {
          const summary = status.fixes[meta.key];
          const extra =
            meta.key === "xhciRecovery" ? (
              <FocusButton
                onClick={rebindNow}
                disabled={busyKey !== null}
                variant="ghost"
              >
                <FaArrowsRotate className="w-3 h-3 mr-1" /> Rebind now
              </FocusButton>
            ) : undefined;

          return (
            <FixCard
              key={meta.key}
              meta={meta}
              summary={summary}
              busy={busyKey !== null}
              onApply={() => void runAction(meta.key, "apply", "applyFix")}
              onRevert={() => void runAction(meta.key, "revert", "revertFix")}
              extraAction={extra}
            />
          );
        })}

        <MigrationSection />
      </div>
    </div>
  );
}

export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <ApexFixes />
    </PluginProvider>,
  );
  return () => root.unmount();
}

// ---------------------------------------------------------------------------
// Header (top-bar chrome)
// ---------------------------------------------------------------------------

function Header() {
  const { call, useEvent } = useBackend("apex-fixes");
  const [status, setStatus] = useState<ApexStatus | null>(null);

  useEvent({
    event: "apex-status",
    handler: (data) => setStatus(data as ApexStatus),
  });
  useEffect(() => {
    call("getStatus").then((s) => setStatus(s as ApexStatus));
  }, [call]);

  const appliedCount = status
    ? Object.values(status.fixes).filter((f) => f.state === "applied").length
    : 0;
  const total = status ? Object.values(status.fixes).length : 4;
  const anyRebootRequired = status
    ? Object.values(status.fixes).some(
        (f) => f.rebootRequired && f.state !== "applied",
      )
    : false;

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Apex Fixes
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        {status?.isApex === false
          ? "not on APEX"
          : `${appliedCount} of ${total} applied${anyRebootRequired ? " · reboot required" : ""}`}
      </span>
    </div>
  );
}

export function mountHeader(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <Header />
    </PluginProvider>,
  );
  return () => root.unmount();
}

