import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";

export { FaMicrophone as icon } from "react-icons/fa6";
import {
  FaMicrophone,
  FaStop,
  FaArrowsRotate,
  FaCheck,
  FaPlay,
  FaGear,
} from "react-icons/fa6";
import {
  Button,
  PluginProvider,
  Spinner,
  Toggle,
  useBackend,
  useFocusable,
} from "@loadout/ui";

interface HandySettings {
  microphone: string | null;
  model: string | null;
  configured: boolean;
}

interface HandyStatus {
  installed: boolean;
  appImagePath: string | null;
  installedVersion: string | null;
  running: boolean;
  setupComplete: boolean;
  missingSystemDeps: string[];
  settings: HandySettings;
}

interface HandyConfig {
  startHidden: boolean;
  autostartOnLoad: boolean;
}

interface SetupProgress {
  phase: string;
  status: string;
  percent?: number;
}

/**
 * Big centered record button — 96px circle, accent when idle, danger when live.
 * Custom styled per Loadout design; keeps d-pad focus via useFocusable.
 */
function RecordButton({
  recording,
  disabled,
  onToggle,
}: {
  recording: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) onToggle();
    },
    focusable: !disabled,
  });
  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={recording}
      style={{
        width: 96,
        height: 96,
        borderRadius: 48,
        background: recording ? "var(--color-error)" : "var(--accent)",
        color: "#fff",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "grid",
        placeItems: "center",
        margin: "0 auto 18px",
        boxShadow: focused
          ? "0 0 0 3px var(--accent), 0 8px 28px color-mix(in oklab, var(--accent) 40%, transparent)"
          : recording
            ? "0 8px 24px color-mix(in oklab, var(--color-error) 40%, transparent)"
            : "var(--glow-accent)",
        animation: recording ? "dictationPulse 1.6s ease-in-out infinite" : "none",
        opacity: disabled ? 0.6 : 1,
        transition: "transform 120ms ease",
        transform: focused ? "scale(1.04)" : "scale(1)",
      }}
    >
      {recording ? <FaStop size={32} /> : <FaMicrophone size={36} />}
    </button>
  );
}

/** Animated bars — still/low when idle, lively when recording. */
function Waveform({ recording }: { recording: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, [recording]);
  const now = Date.now();
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        alignItems: "center",
        justifyContent: "center",
        height: 40,
        marginTop: 16,
      }}
      aria-hidden
      data-tick={tick}
    >
      {Array.from({ length: 32 }).map((_, i) => {
        const h = recording
          ? 6 + Math.abs(Math.sin(now / 200 + i)) * 22
          : 4 + Math.abs(Math.sin(i)) * 8;
        return (
          <span
            key={i}
            style={{
              width: 3,
              height: h,
              borderRadius: 2,
              background: recording ? "var(--accent)" : "var(--fg-3)",
              opacity: recording ? 0.85 : 0.3,
              transition: "height 80ms linear",
            }}
          />
        );
      })}
    </div>
  );
}

function HandyDictationManager() {
  const { call, useEvent } = useBackend("handy-dictation");

  const [status, setStatus] = useState<HandyStatus | null>(null);
  const [config, setConfig] = useState<HandyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState("");
  // Handy's CLI is fire-and-forget — we track the toggle state locally so
  // the UI can show Start vs Stop. Gets out of sync if the user triggers
  // Handy via its own hotkey, but that's an acceptable thin-wrapper cost.
  const [recording, setRecording] = useState(false);
  const errorTimer = useRef<Timer | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = (await call("getStatus")) as HandyStatus;
      setStatus(s);
    } catch (err) {
      console.error("[handy-dictation] Failed to get status:", err);
    }
  }, [call]);

  useEvent({
    event: "statusChanged",
    handler: () => refreshStatus(),
  });

  useEvent({
    event: "configChanged",
    handler: (data: unknown) => setConfig(data as HandyConfig),
  });

  useEvent({
    event: "setupProgress",
    handler: (data: unknown) => setProgress(data as SetupProgress),
  });

  useEffect(() => {
    Promise.all([call("getStatus"), call("getConfig")])
      .then(([s, c]) => {
        setStatus(s as HandyStatus);
        setConfig(c as HandyConfig);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [call]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(""), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setProgress({ phase: "install", status: "Starting..." });
    try {
      const result = (await call("installHandy")) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) showError(result.error ?? "Install failed");
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
      setProgress(null);
      refreshStatus();
    }
  }, [call, refreshStatus, showError]);

  const handleUninstall = useCallback(async () => {
    setBusy(true);
    try {
      const result = (await call("uninstallHandy")) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) showError(result.error ?? "Uninstall failed");
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }, [call, refreshStatus, showError]);

  const handleToggleHandy = useCallback(async () => {
    setBusy(true);
    try {
      if (status?.running) {
        await call("stopHandy");
      } else {
        const result = (await call("startHandy")) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) showError(result.error ?? "Failed to start Handy");
      }
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }, [call, status, refreshStatus, showError]);

  const handleToggleRecording = useCallback(async () => {
    // Handy's CLI is a single --toggle-transcription command for both
    // start and stop. We fire it either way and flip our local flag.
    const wasRecording = recording;
    setRecording(!wasRecording);
    try {
      const result = (await call("toggleDictation")) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        setRecording(wasRecording); // revert on error
        showError(result.error ?? "Toggle failed");
      }
    } catch (err) {
      setRecording(wasRecording);
      showError(String(err));
    }
    refreshStatus();
  }, [call, recording, refreshStatus, showError]);

  const handleLaunchHandyGui = useCallback(async () => {
    setBusy(true);
    try {
      const result = (await call("launchHandyGui")) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) showError(result.error ?? "Failed to launch Handy");
    } catch (err) {
      showError(String(err));
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }, [call, refreshStatus, showError]);

  const updateConfig = useCallback(
    async (partial: Partial<HandyConfig>) => {
      if (!config) return;
      const next = { ...config, ...partial };
      setConfig(next);
      await call("updateConfig", partial);
    },
    [call, config],
  );

  if (loading) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  const installed = !!status?.installed;
  const configured = !!status?.settings.configured;
  const running = !!status?.running;
  const canDictate = installed && configured && !busy;

  return (
    <div className="p-7 h-full overflow-y-auto">
      {/* Inline keyframes — the Loadout design uses pulse/blink that aren't
          in the shared stylesheet. Scoped here to avoid polluting global CSS. */}
      <style>{`
        @keyframes dictationPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-error) 40%, transparent), 0 8px 24px color-mix(in oklab, var(--color-error) 40%, transparent); }
          50% { transform: scale(1.04); box-shadow: 0 0 0 14px color-mix(in oklab, var(--color-error) 0%, transparent), 0 8px 28px color-mix(in oklab, var(--color-error) 50%, transparent); }
        }
        @keyframes dictationBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>

      <div className="page-content">
        {error && (
          <div className="card">
            <div className="subsection">
              <div
                className="subsection-label"
                style={{ color: "var(--color-error)" }}
              >
                Error
              </div>
              <div style={{ fontSize: 13 }}>{error}</div>
            </div>
          </div>
        )}

        {progress && (
          <div className="card">
            <div className="subsection">
              <div className="subsection-label">Setup progress</div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>{progress.status}</div>
              {progress.percent !== undefined && progress.percent > 0 && (
                <div
                  style={{
                    width: "100%",
                    height: 6,
                    background: "var(--bg-inset)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${progress.percent}%`,
                      background: "var(--accent)",
                      transition: "width 200ms ease",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* HANDY RUNTIME — install + process state in one card */}
        <div className="card">
          <div className="subsection">
            <div className="subsection-label">Handy</div>
            <div className="subsection-desc" style={{ marginTop: -4, marginBottom: 12 }}>
              Offline speech-to-text. Runs locally, no cloud, no API keys.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {installed ? (
                <span className="chip chip-success">
                  Installed{status?.installedVersion ? ` · ${status.installedVersion}` : ""}
                </span>
              ) : (
                <span className="chip chip-warn">Not installed</span>
              )}
              {installed && (running ? (
                <span className="chip chip-accent">Running</span>
              ) : (
                <span className="chip">Stopped</span>
              ))}
              {status && status.missingSystemDeps.length > 0 && (
                <span className="chip chip-danger">
                  Missing: {status.missingSystemDeps.join(", ")}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
              {!installed ? (
                <Button size="sm" variant="primary" onClick={handleInstall} disabled={busy}>
                  <FaArrowsRotate size={12} /> Install Handy
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={handleToggleHandy} disabled={busy}>
                    {running ? <FaStop size={12} /> : <FaPlay size={12} />}{" "}
                    {running ? "Stop Handy" : "Start Handy"}
                  </Button>
                  <Button size="sm" onClick={handleLaunchHandyGui} disabled={busy}>
                    <FaGear size={12} /> Open Handy Settings
                  </Button>
                  <Button size="sm" onClick={handleInstall} disabled={busy}>
                    <FaArrowsRotate size={12} /> Reinstall
                  </Button>
                  <Button size="sm" variant="danger" onClick={handleUninstall} disabled={busy}>
                    Uninstall
                  </Button>
                </>
              )}
            </div>

            {!installed && (
              <div className="subsection-desc" style={{ marginTop: 10 }}>
                Downloads the latest Handy AppImage from GitHub into{" "}
                <span className="mono">
                  ~/.local/share/loadout/handy-dictation/bin
                </span>
                .
              </div>
            )}
          </div>
        </div>

        {/* FIRST-TIME SETUP — Handy's own GUI is required to pick mic + model */}
        {installed && !configured && (
          <div className="card">
            <div className="subsection">
              <div className="subsection-label">First-time setup</div>
              <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                Handy needs a microphone and a model picked from its own window
                before you can dictate in gaming mode.
              </div>
              <div className="subsection-desc" style={{ marginTop: 8 }}>
                Switch to <strong>Desktop Mode</strong>, launch Handy, pick your
                mic and model (it&apos;ll download one on first run), then come
                back here.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
                <Button
                  variant="primary"
                  onClick={handleLaunchHandyGui}
                  disabled={busy}
                >
                  Launch Handy for Setup
                </Button>
                <Button onClick={() => refreshStatus()} disabled={busy}>
                  <FaCheck size={12} /> I&apos;ve finished setup
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* DICTATION — primary card: big record button + waveform + transcript */}
        {installed && configured && (
          <div className="card">
            <div
              className="subsection"
              style={{ textAlign: "center", padding: "32px 24px" }}
            >
              <RecordButton
                recording={recording}
                disabled={!canDictate}
                onToggle={handleToggleRecording}
              />
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                {recording ? "Listening…" : "Press to dictate"}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                  marginTop: 6,
                }}
              >
                {status?.settings.model ?? "model: —"}
                {" · "}
                {status?.settings.microphone ?? "mic: —"}
              </div>
              <Waveform recording={recording} />
            </div>

            <div className="subsection">
              <div className="subsection-label">Transcript</div>
              <div
                style={{
                  padding: 14,
                  background: "var(--bg-inset)",
                  borderRadius: 10,
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  minHeight: 90,
                  color: recording ? "var(--fg-1)" : "var(--fg-3)",
                }}
              >
                {recording ? (
                  <>
                    <span style={{ color: "var(--fg-1)" }}>
                      Listening — Handy types the transcript straight into the
                      focused text field.
                    </span>
                    <span
                      style={{
                        color: "var(--accent)",
                        marginLeft: 2,
                        animation: "dictationBlink 1s infinite",
                      }}
                    >
                      ▊
                    </span>
                  </>
                ) : (
                  "Transcribed text appears in the active app — not here. Start recording, then speak."
                )}
              </div>
              <div className="subsection-desc" style={{ marginTop: 10 }}>
                Start speaking once the button turns red; tap again to stop.
              </div>
            </div>

            <div className="subsection">
              <div className="subsection-label">Model</div>
              <div className="segmented" style={{ width: "100%" }}>
                {/* Read-only display of the current model. Was a
                    `<button disabled>` previously — converted to a
                    plain `<div>` because issue #134 audits flagged
                    disabled buttons as a fragility risk: re-enabling
                    one later without wiring `useFocusable` would
                    create a non-d-pad-reachable interactive. The
                    model is changed inside Handy's own window. */}
                <div
                  className="active"
                  style={{
                    flex: 1,
                    padding: "0.5rem 0.75rem",
                    textAlign: "center",
                  }}
                  title="Change model from Handy's Desktop Mode window"
                >
                  {status?.settings.model ?? "—"}
                </div>
              </div>
              <div className="subsection-desc">
                Model is picked inside Handy&apos;s own window — open{" "}
                <strong>Open Handy Settings</strong> above in Desktop Mode to
                change it.
              </div>
            </div>

            <div className="subsection">
              <div className="subsection-label">Device</div>
              <div className="row">
                <span className="row-label">Microphone</span>
                <span className="row-value">
                  {status?.settings.microphone ?? "—"}
                </span>
              </div>
              <div className="row">
                <span className="row-label">Model</span>
                <span className="row-value">
                  {status?.settings.model ?? "—"}
                </span>
              </div>
              <div className="row">
                <span className="row-label">Handy process</span>
                <span className="row-value">
                  {running ? "running" : "stopped"}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* OVERLAY SETTINGS — autostart + start-hidden */}
        {config && (
          <div className="card">
            <div className="subsection">
              <div className="subsection-label">Overlay integration</div>
              <div className="row">
                <span className="row-label">Start hidden in gaming mode</span>
                <Toggle
                  checked={config.startHidden}
                  onChange={(v) => updateConfig({ startHidden: v })}
                />
              </div>
              <div className="row">
                <span className="row-label">Auto-start with the overlay</span>
                <Toggle
                  checked={config.autostartOnLoad}
                  onChange={(v) => updateConfig({ autostartOnLoad: v })}
                />
              </div>
            </div>
          </div>
        )}
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
      <HandyDictationManager />
    </PluginProvider>,
  );
  return () => root.unmount();
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Dictation
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Speech-to-text input
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
