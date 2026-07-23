import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  pushBackInterceptor,
  Toggle,
  Spinner,
  Select,
  TextInput,
  useBackend,
} from "@loadout/ui";
import { Focusable, useFocusable, FocusContext } from "./GamepadNav";
import type { PluginInfo } from "../hooks/usePlugins";
import { setWelcomeCompleted } from "../hooks/useEnabledPlugins";
import { setConfigValueFlushed, getConfigValue } from "../lib/userConfig";
import { applyTheme, LOADOUT_THEMES } from "./Settings";
import {
  getControllerShortcuts,
  setControllerShortcuts,
  restartApp,
  type ControllerShortcuts,
  type ShortcutAction,
} from "../lib/host";

type StepId =
  | "welcome"
  | "input"
  | "wake"
  | "appearance"
  | "artwork"
  | "plugins"
  | "shortcuts"
  | "done";

const STEPS: { id: StepId; label: string }[] = [
  { id: "welcome",    label: "Welcome" },
  { id: "input",      label: "Input routing" },
  { id: "wake",       label: "Wake button" },
  { id: "appearance", label: "Appearance" },
  { id: "artwork",    label: "Artwork" },
  { id: "plugins",    label: "Plugins" },
  { id: "shortcuts",  label: "Shortcuts" },
  { id: "done",       label: "All set" },
];

const WAKE_CAPTURE_TIMEOUT_MS = 10_000;

const SHORTCUT_BUTTONS: { key: keyof ControllerShortcuts; label: string }[] = [
  { key: "guide_b", label: "Guide + B" },
  { key: "guide_x", label: "Guide + X" },
];

function actionToString(action: ShortcutAction): string {
  switch (action.type) {
    case "None":           return "none";
    case "ToggleOverlay":  return "toggle_overlay";
    case "OpenPlugin":     return `plugin:${action.value ?? ""}`;
    case "OpenSettings":   return "open_settings";
    case "OpenHome":       return "open_home";
    case "ToggleKeyboard": return "toggle_keyboard";
  }
}

function stringToAction(s: string): ShortcutAction {
  if (s === "toggle_overlay")  return { type: "ToggleOverlay" };
  if (s === "open_settings")   return { type: "OpenSettings" };
  if (s === "open_home")       return { type: "OpenHome" };
  if (s === "toggle_keyboard") return { type: "ToggleKeyboard" };
  if (s.startsWith("plugin:")) return { type: "OpenPlugin", value: s.slice(7) };
  return { type: "None" };
}

interface WelcomeScreenProps {
  plugins: PluginInfo[];
  /** Plugins currently disabled — used so re-opening from Settings
   *  reflects the user's current set rather than the original defaults.
   *  Deny-list: absent from this list (incl. newly installed) = enabled. */
  initialDisabled?: string[];
  loading: boolean;
  onClose: () => void;
}

/**
 * Multi-step first-boot welcome wizard. Walks the user through a quick
 * setup before they land in the main UI: theme pick, plugin pick, then
 * a summary. Re-openable from Settings → General → "Show welcome
 * screen again".
 *
 * The left rail mirrors the real Sidebar's chrome (flat base-200,
 * primary-tinted active row) so the welcome surface and the rest of
 * the app share one design system.
 */
export function WelcomeScreen({
  plugins,
  initialDisabled,
  loading,
  onClose,
}: WelcomeScreenProps) {
  const { ref: rootRef, focusKey, focusSelf } = useFocusable({
    focusKey: "welcome-screen",
    trackChildren: true,
    saveLastFocusedChild: true,
    isFocusBoundary: true,
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  const [stepIndex, setStepIndex] = useState(0);
  // stepIndex is clamped to [0, STEPS.length) by the nav handlers, so the
  // fallback to the first step's id never runs for real input.
  const stepId = STEPS[stepIndex]?.id ?? "welcome";

  // Theme — controlled locally during the flow so navigating around
  // applies the preview immediately, then we persist on completion.
  const [theme, setLocalTheme] = useState<string>(() =>
    getConfigValue<string>("theme", "midnight"),
  );

  function previewTheme(id: string) {
    setLocalTheme(id);
    applyTheme(id); // writes config + sets data-theme — same call Settings uses
  }

  // `selected` holds the ENABLED set (toggle on = enabled). Seed it as the
  // complement of the persisted deny-list when re-opening, or — on first
  // boot (no deny-list yet) — turn every discovered plugin on by default.
  const seedSelected = useCallback(
    (disabled: string[] | undefined, all: PluginInfo[]) =>
      new Set(
        all
          .map((p) => p.id)
          .filter((id) => !(disabled ?? []).includes(id)),
      ),
    [],
  );
  const [selected, setSelected] = useState<Set<string>>(() =>
    seedSelected(initialDisabled, plugins),
  );

  // Re-seed when `initialDisabled` resolves after async config load, or
  // when the plugin list streams in on first boot.
  const sentinelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (plugins.length === 0) return;
    const ids = plugins.map((p) => p.id).sort();
    const key = `${(initialDisabled ?? []).slice().sort().join("|")}::${ids.join("|")}`;
    if (sentinelRef.current === key) return;
    sentinelRef.current = key;
    setSelected(seedSelected(initialDisabled, plugins));
  }, [initialDisabled, plugins, seedSelected]);

  const [shortcuts, setShortcuts] = useState<ControllerShortcuts | null>(null);
  useEffect(() => {
    getControllerShortcuts().then(setShortcuts).catch(() => {});
  }, []);

  function handleShortcutChange(key: keyof ControllerShortcuts, value: string) {
    if (!shortcuts) return;
    const updated = { ...shortcuts, [key]: stringToAction(value) };
    setShortcuts(updated);
    setControllerShortcuts(updated).catch(() => {});
  }

  useEffect(() => {
    const remove = pushBackInterceptor(() => {
      if (stepIndex > 0) {
        setStepIndex((i) => i - 1);
        return true;
      }
      onClose();
      return true;
    });
    return remove;
  }, [onClose, stepIndex]);

  useEffect(() => {
    focusSelf();
  }, [focusSelf, stepIndex]);

  useEffect(() => {
    // Reset scroll when changing steps so a tall plugin list doesn't
    // start halfway down on the next step.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [stepIndex]);

  const sortedPlugins = useMemo(
    () => [...plugins].sort((a, b) => a.name.localeCompare(b.name)),
    [plugins],
  );

  function togglePlugin(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Master switch on the Plugins step — flip everything on, or everything off.
  function setAllPlugins(on: boolean) {
    setSelected(on ? new Set(sortedPlugins.map((p) => p.id)) : new Set());
  }

  function goNext() {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1);
    else handleComplete();
  }

  function goPrev() {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  }

  // When completing turns OFF a plugin the backend currently has loaded,
  // its code can't be unloaded in place — we prompt for an app restart
  // instead of closing straight away. Holds the count of such plugins,
  // or null when no prompt is pending.
  const [restartPromptCount, setRestartPromptCount] = useState<number | null>(null);

  async function handleComplete() {
    const disabled = plugins
      .map((p) => p.id)
      .filter((id) => !selected.has(id));
    // Plugins the backend is running right now that the user just turned
    // off — these are the ones a restart actually unloads.
    const nowLoadedButDisabled = plugins.filter(
      (p) => p.status === "loaded" && !selected.has(p.id),
    ).length;
    // Flush the write before any restart so it can't race the bounce.
    await setConfigValueFlushed("disabledPlugins", disabled);
    setWelcomeCompleted(true);
    if (nowLoadedButDisabled > 0) {
      setRestartPromptCount(nowLoadedButDisabled);
      return;
    }
    onClose();
  }

  const enabledCount = selected.size;
  const themeName =
    LOADOUT_THEMES.find((t) => t.id === theme)?.name ?? "Midnight";

  if (restartPromptCount !== null) {
    return (
      <RestartPrompt
        count={restartPromptCount}
        onRestart={() => {
          void restartApp();
        }}
        onLater={onClose}
      />
    );
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={rootRef}
        className="h-full w-full bg-base-100 grid grid-cols-[260px_1fr] overflow-hidden animate-[viewEnter_180ms_ease-out]"
      >
          {/* ─── Left rail — mirrors the real Sidebar chrome ──────── */}
          <aside className="bg-base-200 border-r border-base-300/60 flex flex-col p-4 gap-1">
            <div className="flex items-center gap-2.5 px-2 pt-1 pb-4">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-[13px] font-extrabold text-white shadow-sm shrink-0">
                SL
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold leading-tight">Loadout</div>
                <div className="text-[10.5px] text-base-content/40 font-mono">first boot</div>
              </div>
            </div>

            {STEPS.map((s, i) => {
              const isActive = i === stepIndex;
              const isDone = i < stepIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    // Only allow jumping to completed or current step;
                    // forward jumps stay locked so the flow can't be
                    // skipped mid-setup.
                    if (i <= stepIndex) setStepIndex(i);
                  }}
                  tabIndex={-1}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors text-sm ${
                    isActive
                      ? "bg-primary/15 text-primary"
                      : isDone
                        ? "text-base-content/70 hover:bg-base-300/40 cursor-pointer"
                        : "text-base-content/50 cursor-default"
                  }`}
                >
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold font-mono shrink-0 ${
                      isActive
                        ? "bg-primary text-primary-content"
                        : isDone
                          ? "bg-success/20 text-success border border-success/40"
                          : "bg-base-300 text-base-content/50"
                    }`}
                  >
                    {isDone ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="truncate font-medium">{s.label}</span>
                </button>
              );
            })}

            <div className="mt-auto pt-4 border-t border-base-300/40 text-[11px] text-base-content/40 leading-snug px-1">
              Press <span className="kbd kbd-sm">B</span> any time to skip.
              You can re-open this from Settings → General.
            </div>
          </aside>

          {/* ─── Right panel — flex column so the footer always pins
              to the bottom even when the header is conditionally
              hidden. CSS Grid's auto-placement would shove the
              footer into the 1fr track on header-less steps and
              float it above the body. ────────────────────────────── */}
          <div className="flex flex-col min-h-0">
            {stepId !== "welcome" && stepId !== "done" && (
              <StepHeader
                stepIndex={stepIndex}
                enabledCount={enabledCount}
                totalPlugins={plugins.length}
              />
            )}

            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-9 pb-6 pt-2 min-h-0"
              style={{ overscrollBehavior: "contain" }}
            >
              {stepId === "welcome" && <StepWelcome />}
              {stepId === "input" && <StepInput />}
              {stepId === "wake" && <StepWakeButton />}
              {stepId === "appearance" && (
                <StepAppearance theme={theme} onSelect={previewTheme} />
              )}
              {stepId === "artwork" && <StepArtwork />}
              {stepId === "plugins" && (
                <StepPlugins
                  plugins={sortedPlugins}
                  loading={loading}
                  selected={selected}
                  toggle={togglePlugin}
                  setAll={setAllPlugins}
                />
              )}
              {stepId === "shortcuts" && (
                <StepShortcuts
                  shortcuts={shortcuts}
                  plugins={sortedPlugins}
                  onChange={handleShortcutChange}
                />
              )}
              {stepId === "done" && (
                <StepDone
                  themeName={themeName}
                  enabledCount={enabledCount}
                  totalPlugins={plugins.length}
                />
              )}
            </div>

            <div className="h-[68px] px-7 border-t border-base-300/60 bg-base-200/40 flex items-center justify-between gap-3 shrink-0">
              <div className="text-[11.5px] font-mono text-base-content/40">
                Step {stepIndex + 1} of {STEPS.length}
              </div>
              <div className="flex items-center gap-2">
                {stepIndex === 0 ? (
                  <Focusable focusKey="welcome-skip" onActivate={handleComplete}>
                    <button
                      type="button"
                      onClick={handleComplete}
                      className="btn btn-ghost btn-sm min-w-[96px]"
                    >
                      Skip setup
                    </button>
                  </Focusable>
                ) : (
                  <Focusable focusKey="welcome-back" onActivate={goPrev}>
                    <button
                      type="button"
                      onClick={goPrev}
                      className="btn btn-ghost btn-sm min-w-[96px]"
                    >
                      Back
                    </button>
                  </Focusable>
                )}
                <Focusable focusKey="welcome-next" onActivate={goNext}>
                  <button
                    type="button"
                    onClick={goNext}
                    className="btn btn-primary btn-sm min-w-[140px]"
                  >
                    {stepIndex === STEPS.length - 1 ? "Open Loadout" : "Continue"}
                  </button>
                </Focusable>
              </div>
            </div>
          </div>
        </div>
    </FocusContext.Provider>
  );
}

// ─── Restart prompt ─────────────────────────────────────────────────────────
// Shown after the wizard completes IF the user turned off a plugin the
// backend already has running. A loaded plugin's code can't be unloaded
// in place, so we ask to restart the whole app (backend + overlay) to
// clear it — otherwise a "disabled" hardware plugin (TDP/fan/RGB) keeps
// running and can fight other tools like Decky Loader.
function RestartPrompt({
  count,
  onRestart,
  onLater,
}: {
  count: number;
  onRestart: () => void;
  onLater: () => void;
}) {
  const { ref, focusKey, focusSelf } = useFocusable({
    focusKey: "welcome-restart-prompt",
    trackChildren: true,
    isFocusBoundary: true,
  });
  useEffect(() => {
    focusSelf();
  }, [focusSelf]);
  const noun = count === 1 ? "plugin" : "plugins";
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="h-full w-full bg-base-100 flex items-center justify-center p-8 animate-[viewEnter_180ms_ease-out]"
      >
        <div className="max-w-md flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center text-2xl">
            ↻
          </div>
          <h2 className="text-xl font-bold text-base-content">
            Restart to finish disabling {noun}
          </h2>
          <p className="text-sm text-base-content/60 leading-relaxed">
            You turned off {count} {noun} that {count === 1 ? "is" : "are"}{" "}
            still running in the background. Restart Loadout now to fully
            unload {count === 1 ? "it" : "them"} — the overlay will close and
            reopen, and your game keeps running. You can also do this later
            from Settings.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <Focusable focusKey="welcome-restart-later" onActivate={onLater}>
              <button
                type="button"
                onClick={onLater}
                className="btn btn-ghost btn-sm min-w-[110px]"
              >
                Later
              </button>
            </Focusable>
            <Focusable focusKey="welcome-restart-now" onActivate={onRestart}>
              <button
                type="button"
                onClick={onRestart}
                className="btn btn-primary btn-sm min-w-[140px]"
              >
                Restart now
              </button>
            </Focusable>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// ─── Step header ───────────────────────────────────────────────────────────
function StepHeader({
  stepIndex,
  enabledCount,
  totalPlugins,
}: {
  stepIndex: number;
  enabledCount: number;
  totalPlugins: number;
}) {
  // Keyed by stepId rather than position so adding/reordering STEPS
  // can't silently shift every header forward (we shipped that bug
  // when the Wake button step landed — every subsequent step's header
  // was the previous step's title).
  const headers: Record<StepId, { title: string; sub: string }> = {
    welcome: {
      title: "Welcome to Loadout",
      sub: "A controller-first overlay for Linux handhelds. We'll get the basics sorted — theme, artwork, plugins — in about a minute.",
    },
    input: {
      title: "Input routing",
      sub: "Loadout uses InputPlumber to route a controller button to the overlay when you're in a game — Steam Input owns the controller in big-picture, so we need a daemon layered below it. Required on handhelds; optional on a plain desktop.",
    },
    wake: {
      title: "Wake button",
      sub: "Pick the physical button that opens the overlay from inside a game. Back paddles and the QAM button are the safest picks because no game binds them. You can change this any time from the InputPlumber plugin.",
    },
    appearance: {
      title: "Pick an appearance",
      sub: "Every theme swaps the full token palette — chips, charts and accents follow along. You can switch any time from Settings.",
    },
    artwork: {
      title: "Artwork (optional)",
      sub: "A SteamGridDB API key unlocks high-res cover art across the recomp catalog, store-bridge, the SteamGridDB plugin and any homepage tile that doesn't already have art. Skip if you'd rather plain tiles — it's just visuals.",
    },
    plugins: {
      title: "Choose your plugins",
      sub: `${totalPlugins} plugins discovered, all enabled by default. Turn off any you won't use — disabled plugins are hidden from the sidebar and homepage. Re-toggle any time from Settings → Plugins.`,
    },
    shortcuts: {
      title: "Controller shortcuts",
      sub: "Hold the Guide button and press a face button to fire an action from any game. Guide + A / Y are reserved by Steam; the remaining pair is rebindable from Settings → Controller.",
    },
    done: {
      title: "You're all set",
      sub: "Press Open Loadout to head to your home dashboard. Everything below can be tweaked from the Settings page.",
    },
  };
  // stepIndex is clamped to [0, STEPS.length) by the nav handlers, so the
  // fallback to the first step's id never runs for real input.
  const stepId = STEPS[stepIndex]?.id ?? "welcome";
  const h = headers[stepId];
  return (
    <div className="px-9 pt-8 pb-4">
      <h2 className="text-2xl font-semibold tracking-tight text-base-content leading-tight">
        {h.title}
      </h2>
      <p className="text-sm text-base-content/60 mt-1.5 max-w-2xl leading-relaxed">
        {h.sub}
      </p>
      {stepId === "plugins" && (
        <div className="text-[12px] font-mono text-base-content/50 mt-3">
          <span className="text-primary font-semibold">{enabledCount}</span>{" "}
          of {totalPlugins} enabled
        </div>
      )}
    </div>
  );
}

// ─── Step 1: Welcome landing ───────────────────────────────────────────────
function StepWelcome() {
  const features = [
    { title: "Tune every watt",   desc: "TDP, fan curves and per-game overrides." },
    { title: "Plugin-first",      desc: "A growing catalog of optional plugins." },
    { title: "Themes that match", desc: "Tokenized themes, instantly previewable." },
    { title: "D-pad native",      desc: "Reach every screen without leaving the game." },
  ];
  return (
    <div className="flex flex-col items-center text-center gap-5 pt-2">
      <div className="relative">
        <div
          aria-hidden
          className="absolute inset-0 -m-6 rounded-full bg-primary/20 blur-2xl"
        />
        <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-2xl font-extrabold text-white shadow-lg">
          SL
        </div>
      </div>
      <div className="text-[10.5px] font-mono uppercase tracking-[0.18em] text-base-content/40">
        Loadout · first-time setup
      </div>
      <h1 className="text-3xl font-bold tracking-tight max-w-md leading-tight">
        Your handheld,<br />dialed in.
      </h1>
      <p className="text-[13px] text-base-content/70 max-w-md leading-relaxed">
        A controller-first command center for Linux handhelds. Tune power,
        manage plugins and theme the entire UI — without ever leaving the game.
      </p>
      <div className="grid grid-cols-2 gap-2.5 w-full max-w-2xl mt-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="bg-base-200 border border-base-300/70 rounded-xl px-4 py-3 text-left"
          >
            <div className="text-[13px] font-semibold text-base-content">
              {f.title}
            </div>
            <div className="text-[11.5px] text-base-content/50 mt-0.5 leading-snug">
              {f.desc}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Step 2: Input routing — install / enable InputPlumber ────────────────

/**
 * Status panel + single-button setup for InputPlumber.
 *
 * Mirrors `plugins/input-plumber`'s own panel but compresses it to fit the
 * wizard's rhythm: one chip per dependency (IP, HHD), one primary action
 * that does the right thing for the current state, and a live log so the
 * user sees `sudo` prompts + script output in real time.
 *
 * Decision matrix for the button label:
 *   - IP missing                  → "Install InputPlumber"
 *   - IP installed, service down  → "Enable & start service"
 *   - IP active, no HHD conflict  → "Reinstall" (idempotent re-run)
 *   - IP active + HHD active      → "Disable HHD" — the install script
 *                                    is what stops/masks HHD, so we
 *                                    funnel that case through the same
 *                                    startInstall RPC.
 *
 * All paths run `startInstall`. The install script (idempotent) decides
 * what work to do; we just relabel the button so the intent is legible.
 */
interface HhdStatus {
  installed: boolean;
  active: boolean;
  units: string[];
}
interface IpStatus {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  managedBy: "us" | "distro" | "none";
  serviceActive: boolean;
  serviceEnabled: boolean;
  scriptPresent: boolean;
  /** Optional — the plugin's getStatus doesn't currently emit this field;
   *  HHD-detection lives elsewhere now (apex-fixes has migrated off HHD). */
  hhd?: HhdStatus;
  summary: string;
}
interface IpInstallLog { kind: "stdout" | "stderr" | "status"; text: string }
interface IpInstallState {
  running: boolean;
  result?: { success: boolean; durationSeconds: number; error?: string };
}

const STEP_INPUT_LOG_CAP = 200;

function StepInput() {
  const { call, useEvent } = useBackend("input-plumber");
  const [status, setStatus] = useState<IpStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = (await call("getStatus")) as IpStatus;
      setStatus(s);
      const r = (await call("isInstallRunning")) as { running: boolean };
      setRunning(r.running);
    } catch {
      // Backend not loaded (plugin disabled) — leave status null and
      // show the unavailable card below.
      setStatus(null);
    }
  }, [call]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEvent({
    event: "input-plumber-status",
    handler: (data) => setStatus(data as IpStatus),
  });
  useEvent({
    event: "install-log",
    handler: (data) => {
      const ev = data as IpInstallLog;
      setLogs((prev) => {
        const next = [...prev, ev.text];
        return next.length > STEP_INPUT_LOG_CAP
          ? next.slice(next.length - STEP_INPUT_LOG_CAP)
          : next;
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
      const ev = data as IpInstallState;
      setRunning(ev.running);
      if (!ev.running && ev.result && !ev.result.success) {
        setLastError(ev.result.error ?? "install failed");
      }
      if (!ev.running) {
        // Re-probe shortly so the chips reflect post-install state.
        setTimeout(() => void refresh(), 500);
      }
    },
  });

  const start = useCallback(async () => {
    setLogs([]);
    setLastError(null);
    setRunning(true);
    const r = (await call("startInstall")) as { started: boolean; error?: string };
    if (!r.started) {
      setRunning(false);
      setLastError(r.error ?? "could not start install");
    }
  }, [call]);

  if (status === null) {
    return (
      <div className="bg-base-200 border border-base-300 rounded-xl p-4 max-w-2xl">
        <div className="text-sm font-semibold text-base-content">
          InputPlumber plugin not loaded
        </div>
        <p className="text-[12.5px] text-base-content/60 mt-1.5 leading-relaxed">
          Input routing setup needs the <code className="mono">input-plumber</code> plugin to be enabled.
          You can skip this step and enable it later from Settings → Plugins —
          on a plain desktop with a USB controller, the overlay can read the
          controller directly without InputPlumber.
        </p>
      </div>
    );
  }

  const needsInstall = !status.installed;
  const needsServiceUp = status.installed && !status.serviceActive;
  const hhdConflict = status.hhd?.active ?? false;

  let buttonLabel: string;
  if (running) {
    buttonLabel = needsInstall ? "Installing…" : "Working…";
  } else if (needsInstall) {
    buttonLabel = "Install InputPlumber";
  } else if (needsServiceUp) {
    buttonLabel = "Enable & start service";
  } else if (hhdConflict) {
    buttonLabel = "Disable conflicting HHD";
  } else {
    buttonLabel = "Reinstall (latest)";
  }

  const allClear =
    status.installed && status.serviceActive && !hhdConflict;

  return (
    <div className="flex flex-col gap-4 pt-2 max-w-2xl">
      {/* Status panel */}
      <div className="bg-base-200 border border-base-300 rounded-xl p-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-base-content/40 mb-2.5">
          Detected state
        </div>

        <div className="flex flex-col gap-2 text-sm">
          {/* IP row */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-base-content/80">InputPlumber</span>
            <span className={
              "chip " +
              (status.installed && status.serviceActive
                ? "chip-success"
                : status.installed
                  ? "chip-accent"
                  : "")
            }>
              {status.installed && status.serviceActive
                ? `Active${status.version ? ` · v${status.version}` : ""}`
                : status.installed
                  ? "Installed, service down"
                  : "Not installed"}
            </span>
          </div>

          {/* HHD row — only shown when HHD is present (active or dormant) */}
          {status.hhd?.installed && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-base-content/80">Handheld Daemon (HHD)</span>
              <span className={
                "chip " + (status.hhd.active ? "" : "chip-accent")
              } style={status.hhd.active ? { color: "var(--color-warning)" } : undefined}>
                {status.hhd.active ? "Running — conflicts with IP" : "Installed, inactive"}
              </span>
            </div>
          )}
        </div>

        <div className="text-[11.5px] text-base-content/50 mt-3 leading-relaxed">
          {status.summary}
        </div>
      </div>

      {/* Action card */}
      <div className="bg-base-200 border border-base-300 rounded-xl p-4">
        <div className="text-sm font-semibold text-base-content mb-1">
          {allClear ? "You're set" : "One-click setup"}
        </div>
        <p className="text-[12.5px] text-base-content/60 leading-relaxed">
          {allClear
            ? "InputPlumber is installed and running, and nothing is conflicting. You can re-run the installer to update to the latest release, or continue."
            : needsInstall
              ? "We'll install the latest InputPlumber release (system package on Arch/Fedora, upstream tarball otherwise) and enable the service."
              : needsServiceUp
                ? "InputPlumber is installed but the service is stopped. We'll enable + start it."
                : "Stop and mask any active Handheld Daemon units so InputPlumber can claim the controller."}
          {" "}
          Runs under <code className="mono">sudo</code> — your password manager / polkit will prompt.
        </p>

        <div className="flex gap-2 mt-3">
          <Focusable focusKey="welcome-input-action" onActivate={start}>
            <button
              type="button"
              onClick={start}
              disabled={running || !status.scriptPresent}
              className="btn btn-primary btn-sm"
            >
              {buttonLabel}
            </button>
          </Focusable>
          <Focusable focusKey="welcome-input-refresh" onActivate={() => void refresh()}>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={running}
              className="btn btn-ghost btn-sm"
            >
              Re-check
            </button>
          </Focusable>
        </div>

        {!status.scriptPresent && (
          <div className="text-[12px] mt-2" style={{ color: "var(--color-error)" }}>
            Install script missing from the input-plumber plugin directory.
          </div>
        )}
        {lastError && (
          <div className="text-[12px] mt-2" style={{ color: "var(--color-error)" }}>
            {lastError}
          </div>
        )}
      </div>

      {/* Live log */}
      {(logs.length > 0 || running) && (
        <pre
          ref={logRef}
          className="mono text-[11px]"
          style={{
            background: "var(--bg-2, rgba(255,255,255,0.04))",
            borderRadius: 8,
            padding: "8px 10px",
            maxHeight: 220,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            margin: 0,
            color: "var(--fg-1, rgba(255,255,255,0.8))",
          }}
        >
          {logs.join("") || "waiting for output…"}
        </pre>
      )}
    </div>
  );
}

// ─── Step 2b: Wake button — press-to-capture ───────────────────────────────

interface WakeStatusLite {
  ipActive: boolean;
  isDeck: boolean;
  devices: { name: string; buttons: unknown[] }[];
  selectedRaw: string | null;
  hasLegacyProfile?: boolean;
}

interface WakeCaptureResultLite {
  ok: boolean;
  error?: string;
  timedOut?: boolean;
  capturedRaw?: string;
  capturedLabel?: string;
}

function labelForWakeRaw(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split(":").map((s) => s.trim()).filter(Boolean);
  const name = parts[parts.length - 1] ?? raw;
  const known: Record<string, string> = {
    leftpaddle1: "Left Back Paddle (L4)",
    leftpaddle2: "Left Back Paddle (L5)",
    rightpaddle1: "Right Back Paddle (R4)",
    rightpaddle2: "Right Back Paddle (R5)",
    lefttop: "Left Extra Button",
    righttop: "Right Extra Button",
    keyboard: "Keyboard Button",
    quickaccess: "Quick Access (QAM) Button",
    quickaccess2: "Quick Access (QAM) Button",
    quickaccessmenu: "Quick Access (QAM) Button",
  };
  const k = known[name.toLowerCase()];
  if (k) return k;
  if (parts[0]?.toLowerCase() === "keyboard") {
    return name.replace(/^Key/, "Key ").replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  return name.replace(/([a-z])([A-Z0-9])/g, "$1 $2");
}

function StepWakeButton() {
  const { call, useEvent, ready } = useBackend("input-plumber");
  const [wake, setWake] = useState<WakeStatusLite | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacyAck, setLegacyAck] = useState(false);

  // Track whether the initial `getWakeStatus` has resolved (success or
  // error). Separate from `wake === null` because we want to distinguish
  // "still loading" from "plugin unavailable".
  const [statusFetched, setStatusFetched] = useState(false);

  // Mounted-ref guard so awaited callbacks don't `setState` after the
  // user nav's past this step mid-capture.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const s = (await call("getWakeStatus")) as WakeStatusLite;
      if (mountedRef.current) {
        setWake(s);
        setStatusFetched(true);
      }
    } catch {
      if (mountedRef.current) {
        setWake(null);
        setStatusFetched(true);
      }
    }
  }, [call, ready]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEvent({
    event: "wake-status",
    handler: (data) => { if (mountedRef.current) setWake(data as WakeStatusLite); },
  });

  useEffect(() => {
    if (!capturing) return;
    const tick = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(tick);
  }, [capturing]);

  const startCapture = useCallback(async () => {
    if (!mountedRef.current) return;
    setError(null);
    setInfo(null);
    setCapturing(true);
    setRemaining(Math.ceil(WAKE_CAPTURE_TIMEOUT_MS / 1000));
    try {
      const r = (await call("captureWakeButton", WAKE_CAPTURE_TIMEOUT_MS)) as WakeCaptureResultLite;
      if (!mountedRef.current) return;
      if (r.ok) {
        setInfo(`Bound: ${r.capturedLabel ?? r.capturedRaw ?? "button"}`);
      } else {
        setError(r.timedOut ? "No button pressed — try again." : r.error ?? "Capture failed.");
      }
      await refresh();
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) {
        setCapturing(false);
        setRemaining(0);
      }
    }
  }, [call, refresh]);

  const clear = useCallback(async () => {
    if (!mountedRef.current) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await call("clearWakeButton");
      await refresh();
      if (mountedRef.current) setInfo("Wake button disabled.");
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [call, refresh]);

  // Loading: backend handle ready but first probe not yet resolved.
  if (ready && !statusFetched) {
    return (
      <div className="max-w-xl">
        <p className="text-[13px] text-base-content/70 mb-4">
          Pick the physical button on your handheld that opens this overlay
          in-game.
        </p>
        <div className="flex items-center justify-center py-12">
          <Spinner variant="dots" size="md" />
        </div>
      </div>
    );
  }

  // Plugin not available (disabled / not installed) — surface a friendly note
  // and let the user move on; they can set this later from the plugin panel.
  if (!ready || wake === null) {
    return (
      <div className="max-w-xl">
        <p className="text-[13px] text-base-content/70 mb-4">
          Pick the physical button on your handheld that opens this overlay
          in-game. You can change this any time from the InputPlumber plugin.
        </p>
        <div className="rounded-xl bg-base-200 border border-base-300 p-4 text-[12px] text-base-content/60">
          InputPlumber plugin isn&apos;t loaded yet. Skip this step — you can
          set the wake button from Plugins → InputPlumber after first boot.
        </div>
      </div>
    );
  }

  if (!wake.ipActive) {
    return (
      <div className="max-w-xl">
        <p className="text-[13px] text-base-content/70 mb-4">
          Pick the physical button on your handheld that opens this overlay
          in-game.
        </p>
        <div className="rounded-xl bg-base-200 border border-base-300 p-4 text-[12px] text-base-content/60">
          InputPlumber isn&apos;t running yet — finish installing it on the
          previous step, then come back. You can also set this later from the
          InputPlumber plugin.
        </div>
      </div>
    );
  }

  if (wake.devices.length === 0) {
    return (
      <div className="max-w-xl">
        <p className="text-[13px] text-base-content/70 mb-4">
          Pick the physical button on your handheld that opens this overlay
          in-game.
        </p>
        <div className="rounded-xl bg-base-200 border border-base-300 p-4 text-[12px] text-base-content/60">
          No controller detected by InputPlumber. Connect a handheld
          controller and revisit this step, or skip and set it later.
        </div>
      </div>
    );
  }

  const currentLabel = labelForWakeRaw(wake.selectedRaw);
  const needsLegacyAck = wake.hasLegacyProfile && !currentLabel && !legacyAck;

  return (
    <div className="max-w-xl">
      <p className="text-[13px] text-base-content/70 mb-4">
        Press <span className="font-medium">Set wake button</span>, then push
        the button you want on your handheld — a back paddle, the QAM /
        keyboard button, anything extra. The choice takes effect immediately.
      </p>

      <div className="rounded-xl bg-base-200 border border-base-300 p-4 mb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide opacity-50">
              Currently bound
            </div>
            <div className="truncate font-medium">
              {currentLabel ?? <span className="opacity-60">None</span>}
            </div>
          </div>
        </div>

        {needsLegacyAck && (
          <div
            className="text-[12px] rounded-lg p-3 mt-3"
            style={{
              background: "color-mix(in oklch, var(--color-warning) 8%, transparent)",
              border: "1px solid color-mix(in oklch, var(--color-warning) 30%, transparent)",
              color: "var(--color-warning, #facc15)",
            }}
          >
            <div className="font-medium mb-1">Heads up — replaces existing IP profile</div>
            <div className="opacity-80">
              A legacy InputPlumber profile with custom mappings is installed.
              IP profiles replace rather than merge, so capturing a wake
              button will deactivate those mappings. Skip this step if you
              want to keep them.
            </div>
            <div className="mt-2">
              <Focusable focusKey="welcome-wake-ack" onActivate={() => setLegacyAck(true)}>
                <button
                  type="button"
                  onClick={() => setLegacyAck(true)}
                  tabIndex={-1}
                  className="btn btn-primary btn-sm"
                >
                  I understand, continue
                </button>
              </Focusable>
            </div>
          </div>
        )}

        {capturing ? (
          <div className="flex items-center gap-3 mt-4">
            <Spinner variant="dots" size="sm" />
            <div className="flex-1">
              <div className="font-medium">Press a button on your handheld…</div>
              <div className="text-[12px] opacity-60">
                Try a back paddle or the QAM/keyboard button. {remaining}s left.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 mt-4">
            <Focusable
              focusKey="welcome-wake-set"
              onActivate={() => void startCapture()}
            >
              <button
                type="button"
                onClick={() => void startCapture()}
                disabled={busy || capturing || needsLegacyAck}
                tabIndex={-1}
                className="btn btn-primary btn-sm"
              >
                {currentLabel ? "Change button" : "Set wake button"}
              </button>
            </Focusable>
            {currentLabel && (
              <Focusable
                focusKey="welcome-wake-clear"
                onActivate={() => void clear()}
              >
                <button
                  type="button"
                  onClick={() => void clear()}
                  disabled={busy || capturing}
                  tabIndex={-1}
                  className="btn btn-ghost btn-sm"
                >
                  Off
                </button>
              </Focusable>
            )}
          </div>
        )}

        {info && (
          <div className="text-[12px] mt-3" style={{ color: "var(--color-success, #4ade80)" }}>
            {info}
          </div>
        )}
        {error && (
          <div className="text-[12px] mt-3" style={{ color: "var(--color-error)" }}>
            {error}
          </div>
        )}
      </div>

      <div className="text-[11px] text-base-content/40 leading-snug">
        Optional — Ctrl+Shift+O and the controller shortcuts on the next step
        also open the overlay. You can change or clear this later from the
        InputPlumber plugin.
      </div>
    </div>
  );
}

// ─── Step 3: Appearance — theme grid ───────────────────────────────────────
function StepAppearance({
  theme,
  onSelect,
}: {
  theme: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-3">
      {LOADOUT_THEMES.map((t) => {
        const active = theme === t.id;
        return (
          <Focusable
            key={t.id}
            focusKey={`welcome-theme-${t.id}`}
            onActivate={() => onSelect(t.id)}
          >
            <button
              type="button"
              onClick={() => onSelect(t.id)}
              tabIndex={-1}
              className={`relative w-full h-full rounded-xl p-3 text-left transition-all bg-base-200 border ${
                active
                  ? "border-primary"
                  : "border-base-300 hover:border-base-content/30"
              }`}
              style={
                active
                  ? { boxShadow: "0 0 0 3px color-mix(in oklch, var(--color-primary) 30%, transparent)" }
                  : undefined
              }
            >
              <div className="flex gap-1 h-12 rounded-lg overflow-hidden mb-2.5">
                {t.colors.map((c, i) => (
                  <div key={i} className="flex-1" style={{ background: c }} />
                ))}
              </div>
              <div className="text-[13px] font-semibold text-base-content">
                {t.name}
              </div>
              <div className="text-[11px] text-base-content/50 mt-0.5">
                {t.desc}
              </div>
              {active && (
                <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full bg-primary text-primary-content flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
            </button>
          </Focusable>
        );
      })}
    </div>
  );
}

// ─── Step 3: Artwork — SteamGridDB API key ─────────────────────────────────

/**
 * Skippable SGDB API key entry. The user pastes a key from
 * https://www.steamgriddb.com/profile/preferences/api and clicks
 * Save; the steamgriddb plugin's `setApiKey` RPC validates against
 * SGDB's API before persisting. Empty input + Continue is the
 * "skip" path — no key is set, the user can configure later from
 * the SteamGridDB plugin's Settings page.
 *
 * Why a dedicated step instead of a Settings link: artwork is the
 * single highest-leverage 30 seconds in onboarding. Without a key
 * recomp tiles, store-bridge tiles and any plugin that fetches
 * SGDB-art-by-title fall back to default capsules — the UI looks
 * empty for the user's first session. Surfacing the API URL +
 * paste box up front means even first-time users land on a
 * visually-populated home page.
 */
function StepArtwork() {
  const { call } = useBackend("steamgriddb");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Re-seed if the user comes back to this step after already saving.
  useEffect(() => {
    void call("hasApiKey").then((has) => {
      if (has) setStatus({ kind: "saved" });
    });
  }, [call]);

  async function handleSave() {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setStatus({ kind: "saving" });
    try {
      const r = (await call("setApiKey", trimmed)) as {
        success: boolean;
        error?: string;
      };
      if (r.success) {
        setStatus({ kind: "saved" });
        setKey(""); // hide the key from the UI once accepted
      } else {
        setStatus({
          kind: "error",
          message: r.error ?? "SteamGridDB rejected the key.",
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  const saved = status.kind === "saved";

  return (
    <div className="flex flex-col gap-5 pt-2 max-w-2xl">
      {/* Where to get a key. The overlay can't reliably open a browser
          on Gaming Mode without quick-links being installed, so we
          surface the URL as selectable text + a kbd hint instead. */}
      <div className="bg-base-200 border border-base-300 rounded-xl p-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-base-content/40 mb-2">
          Step 1 · Generate a key
        </div>
        <p className="text-sm text-base-content/70 leading-relaxed">
          Sign in at SteamGridDB and visit your API preferences:
        </p>
        <div className="mt-2 font-mono text-[12.5px] text-primary break-all select-all">
          https://www.steamgriddb.com/profile/preferences/api
        </div>
        <p className="text-[11.5px] text-base-content/50 mt-2 leading-relaxed">
          Open on your phone or another device — copy the key from the
          page, then paste it below.
        </p>
      </div>

      <div className="bg-base-200 border border-base-300 rounded-xl p-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-base-content/40 mb-2">
          Step 2 · Paste it here
        </div>
        <div className="flex gap-2 items-stretch">
          <div className="flex-1">
            <TextInput
              value={key}
              onChange={setKey}
              placeholder={
                saved
                  ? "Key saved — paste a new one to replace"
                  : "Paste your SteamGridDB API key"
              }
            />
          </div>
          <Focusable focusKey="welcome-sgdb-save" onActivate={handleSave}>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || key.trim().length === 0}
              className="btn btn-primary btn-sm min-w-[88px]"
            >
              {status.kind === "saving" ? "Checking…" : "Save"}
            </button>
          </Focusable>
        </div>

        {/* Inline status row — single source of truth for what the
            user just did. */}
        {status.kind === "saved" && (
          <div className="text-[12px] text-success mt-3 flex items-center gap-1.5">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-3.5 h-3.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>API key saved — artwork unlocked.</span>
          </div>
        )}
        {status.kind === "error" && (
          <div className="text-[12px] text-error mt-3">{status.message}</div>
        )}
      </div>

      <div className="text-[11.5px] text-base-content/50 leading-relaxed">
        Skip if you'd rather plain tiles — Continue moves on without
        saving anything. You can add or change the key any time from
        Settings → SteamGridDB.
      </div>
    </div>
  );
}

// ─── Step 4: Plugins ───────────────────────────────────────────────────────
function StepPlugins({
  plugins,
  loading,
  selected,
  toggle,
  setAll,
}: {
  plugins: PluginInfo[];
  loading: boolean;
  selected: Set<string>;
  toggle: (id: string) => void;
  setAll: (on: boolean) => void;
}) {
  if (loading && plugins.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner variant="dots" size="md" />
      </div>
    );
  }
  if (plugins.length === 0) {
    return (
      <div className="text-center py-12 text-sm text-base-content/40">
        No plugins discovered.
      </div>
    );
  }
  const allOn = plugins.every((p) => selected.has(p.id));
  return (
    <div className="flex flex-col gap-1">
      {/* Master switch — flips every plugin on or off together. */}
      <Focusable
        focusKey="welcome-plugin-all"
        onActivate={() => setAll(!allOn)}
      >
        <div
          role="button"
          tabIndex={-1}
          onClick={() => setAll(!allOn)}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl min-h-[56px] cursor-pointer transition-colors border border-base-300/60 bg-base-200/60 hover:bg-base-200 mb-1"
        >
          <div className="w-9 h-9 rounded-lg flex items-center justify-center text-base font-bold shrink-0 bg-base-300/70 text-base-content/70">
            ★
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-base-content truncate">
              {allOn ? "Disable all plugins" : "Enable all plugins"}
            </div>
            <div className="text-xs text-base-content/50 line-clamp-2">
              Toggle every plugin at once.
            </div>
          </div>
          <div className="shrink-0">
            <Toggle checked={allOn} onChange={() => setAll(!allOn)} />
          </div>
        </div>
      </Focusable>
      {plugins.map((plugin) => {
        const on = selected.has(plugin.id);
        return (
          <Focusable
            key={plugin.id}
            focusKey={`welcome-plugin-${plugin.id}`}
            onActivate={() => toggle(plugin.id)}
          >
            <div
              role="button"
              tabIndex={-1}
              onClick={() => toggle(plugin.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl min-h-[56px] cursor-pointer transition-colors border ${
                on
                  ? "bg-primary/10 border-primary/40"
                  : "border-transparent hover:bg-base-200"
              }`}
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                  on
                    ? "bg-primary text-primary-content"
                    : "bg-base-300/70 text-base-content/50"
                }`}
              >
                {(plugin.icon ?? plugin.name).charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-base-content truncate">
                  {plugin.name}
                </div>
                <div className="text-xs text-base-content/50 line-clamp-2">
                  {plugin.subtitle || plugin.description || "No description."}
                </div>
              </div>
              <div className="shrink-0">
                <Toggle checked={on} onChange={() => toggle(plugin.id)} />
              </div>
            </div>
          </Focusable>
        );
      })}
    </div>
  );
}

// ─── Step 5: Controller shortcuts ──────────────────────────────────────────
function StepShortcuts({
  shortcuts,
  plugins,
  onChange,
}: {
  shortcuts: ControllerShortcuts | null;
  plugins: PluginInfo[];
  onChange: (key: keyof ControllerShortcuts, value: string) => void;
}) {
  const options = useMemo(
    () => [
      { value: "none", label: "None" },
      { value: "toggle_overlay", label: "Toggle Overlay" },
      { value: "open_settings", label: "Open Settings" },
      { value: "open_home", label: "Open Home" },
      { value: "toggle_keyboard", label: "Toggle Keyboard" },
      ...plugins.map((p) => ({ value: `plugin:${p.id}`, label: `Open ${p.name}` })),
    ],
    [plugins],
  );

  if (!shortcuts) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner variant="dots" size="md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {SHORTCUT_BUTTONS.map(({ key, label }) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 bg-base-200 border border-base-300 rounded-xl px-4 py-3 min-h-[60px]"
        >
          <div className="flex items-center gap-3 min-w-0">
            <kbd className="kbd kbd-sm shrink-0">{label}</kbd>
            <div className="text-[12px] text-base-content/50 truncate">
              Triggered while a game is running.
            </div>
          </div>
          <Select
            value={actionToString(shortcuts[key])}
            options={options}
            onChange={(v) => onChange(key, v)}
            className="w-60 shrink-0"
          />
        </div>
      ))}
      <div className="text-[12px] text-base-content/40 mt-2 leading-snug">
        Guide + A and Guide + Y stay reserved by Steam — bind the remaining
        pair to Toggle Overlay or any plugin. Re-edit any time from Settings →
        Controller.
      </div>
    </div>
  );
}

// ─── Step 6: Done ──────────────────────────────────────────────────────────
function StepDone({
  themeName,
  enabledCount,
  totalPlugins,
}: {
  themeName: string;
  enabledCount: number;
  totalPlugins: number;
}) {
  return (
    <div className="pt-2">
      <div className="text-center pb-7">
        <div className="relative inline-flex">
          <div
            aria-hidden
            className="absolute inset-0 -m-3 rounded-full bg-primary/20 blur-xl"
          />
          <div className="relative w-16 h-16 rounded-full bg-primary/15 border border-primary/30 text-primary flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>
        <div className="text-xl font-semibold mt-4">Loadout is ready</div>
        <div className="text-[13px] text-base-content/60 mt-1.5 max-w-md mx-auto">
          Press <span className="kbd kbd-sm">Open Loadout</span> to head to
          your home dashboard. Everything below can be tweaked from Settings.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SummaryCard label="Theme" value={themeName} />
        <SummaryCard
          label="Plugins"
          value={`${enabledCount} of ${totalPlugins} enabled`}
        />
      </div>
      <div className="text-[12px] text-base-content/50 mt-4 max-w-md mx-auto text-center">
        Tip: to open this overlay with a controller button in-game, set a wake
        button in the <span className="font-medium">InputPlumber</span> plugin —
        pick any paddle or the Quick&nbsp;Access / keyboard button on your
        handheld.
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-base-200 border border-base-300 rounded-xl px-4 py-3">
      <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-base-content/40">
        {label}
      </div>
      <div className="text-sm font-semibold text-base-content mt-0.5">
        {value}
      </div>
    </div>
  );
}
