import { useState, useEffect, useMemo } from "react";
import {
  PluginProvider,
  TabBar,
  Slider,
  Button,
  Select,
  Toggle,
  useBackend,
  useTranslation,
  setLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} from "@loadout/ui";
import { useSidebarAutoCollapseSetting } from "../hooks/useSidebarCollapse";
import { useEnabledPlugins } from "../hooks/useEnabledPlugins";
import { useConfigValue, getConfigValue, setConfigValue } from "../lib/userConfig";
import {
  getControllerShortcuts,
  setControllerShortcuts,
  restartServer,
  restartSteam,
  forceUnfreezeSteam,
  systemShutdown,
  systemReboot,
  exportLogs,
  type ControllerShortcuts,
  type ShortcutAction,
} from "../lib/host";
import { useFocusable } from "@loadout/ui";

interface PluginOption {
  id: string;
  name: string;
  description?: string;
  subtitle?: string;
  icon?: string;
}

interface SettingsProps {
  scale: number;
  onScaleChange: (scale: number) => void;
  plugins?: PluginOption[];
  /** Re-opens the first-boot welcome modal. */
  onShowWelcome?: () => void;
}

const VERSION = "0.1.0-alpha";

/** Loadout's four signature themes. Each swaps the full token set
 *  (surfaces, ink, accent, status colors) — there is no "dark vs light"
 *  toggle independent of theme. `colors` is a 3-dot preview swatch. */
export const LOADOUT_THEMES = [
  { id: "midnight", name: "Midnight",    desc: "Deep, quiet dark — default",   colors: ["#2d2a3e", "#7c5bff", "#f4f0ff"] },
  { id: "paper",    name: "Paper",       desc: "Clean light theme",            colors: ["#ffffff", "#4c2ee8", "#1a1530"] },
  { id: "synth",    name: "Synth",       desc: "Magenta + cyan retro",         colors: ["#221830", "#ff3de0", "#3df0ff"] },
  { id: "terminal", name: "Terminal",    desc: "Green on black, mono-first",   colors: ["#0e1712", "#58ff80", "#c7ffd3"] },
  { id: "nord",     name: "Nord",        desc: "Cool slate, muted pastels",    colors: ["#2e3440", "#88c0d0", "#eceff4"] },
  { id: "dracula",  name: "Dracula",     desc: "Classic purple + pink",        colors: ["#282a36", "#bd93f9", "#ff79c6"] },
  { id: "gruvbox",  name: "Gruvbox",     desc: "Warm retro tan + olive",       colors: ["#282828", "#fe8019", "#ebdbb2"] },
  { id: "tokyo",    name: "Tokyo Night", desc: "Deep indigo + cyan",           colors: ["#1a1b26", "#7dcfff", "#bb9af7"] },
  { id: "one-dark", name: "One Dark", desc: "Atom's iconic industry-standard dark", colors: ["#282c34", "#61afef", "#abb2bf"] },
  { id: "monokai-pro", name: "Monokai Pro", desc: "Vibrant pink + lime — the classic", colors: ["#2d2a2e", "#ff6188", "#ffd866"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", desc: "Pastel dark — community favorite", colors: ["#1e1e2e", "#cba6f7", "#cdd6f4"] },
  { id: "rose-pine", name: "Rosé Pine", desc: "All-natural pine + faux-fur rose", colors: ["#191724", "#c4a7e7", "#e0def4"] },
  { id: "solarized-dark", name: "Solarized Dark", desc: "Ethan Schoonover's classic muted", colors: ["#002b36", "#268bd2", "#839496"] },
] as const;

const THEME_IDS = LOADOUT_THEMES.map((t) => t.id) as readonly string[];

/** Return the theme if it's a registered Loadout theme, else the default. */
function normalizeTheme(theme: string | undefined): string {
  return theme && THEME_IDS.includes(theme) ? theme : "midnight";
}

const TAB_IDS = ["general", "plugins", "controller"] as const;

type TabId = (typeof TAB_IDS)[number];

/** Reads the persisted theme (synchronous — backed by the userConfig
 *  in-memory cache, which is seeded from its localStorage mirror at
 *  module load so boot-time reads are instant). Unknown/unset values
 *  fall back to the default theme. */
function loadTheme(): string {
  return normalizeTheme(getConfigValue<string>("theme", "midnight"));
}

export function applyTheme(theme: string) {
  const t = normalizeTheme(theme);
  document.documentElement.setAttribute("data-theme", t);
  setConfigValue("theme", t);
}

// -- Shortcut action helpers --------------------------------------------------

// Guide+A and Guide+Y are intentionally NOT bindable: Steam / InputPlumber
// reserve them (Guide+A → QAM, Guide+Y → Steam guide menu on Bazzite) and
// even when our handler runs first, Steam still opens its own UI underneath
// us, causing a focus flicker. Only Guide+B and Guide+X stay available to
// the user.
const BUTTON_LABELS: { key: keyof ControllerShortcuts; label: string }[] = [
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

// -- Theme swatch card (Loadout handoff — Settings page) ---------------------

function ThemeSwatch({
  theme,
  active,
  onSelect,
}: {
  theme: { id: string; name: string; desc: string; colors: readonly string[] };
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(),
  });
  return (
    <button
      ref={ref}
      onClick={onSelect}
      className={`rounded-xl p-3.5 text-left transition-all min-h-[120px] ${
        active
          ? "border-[1.5px] border-primary shadow-[0_0_0_3px_var(--accent-soft)]"
          : focused
            ? "border border-primary/60"
            : "border border-base-300 hover:border-base-content/30"
      } bg-base-200`}
    >
      <div className="flex gap-1 mb-3 h-9 rounded-lg overflow-hidden">
        {theme.colors.map((c) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex justify-between items-center">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{theme.name}</div>
          <div className="text-[11.5px] text-base-content/50 mt-0.5 truncate">{theme.desc}</div>
        </div>
        {active && (
          <div className="w-5 h-5 rounded-full bg-primary text-primary-content flex items-center justify-center shrink-0 ml-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

// -- Focusable shortcut row ---------------------------------------------------

// -- Maintenance action row ---------------------------------------------------
// Two-step confirm so a stray d-pad press can't take the service down or
// power-cycle the device mid-game. First click arms (button turns red,
// label flips to "Click again to confirm"), second click fires the RPC.
// Arming auto-expires after 4s so it doesn't sit hot forever.

type ActionStatus = "idle" | "arming" | "running" | "success" | "error";

interface MaintenanceAction {
  /** Base i18n key under the `app` namespace — the row reads
   *  `<i18nKey>.{title,description,idle,running,success}`. */
  i18nKey: string;
  /** RPC to call after the user confirms. */
  invoke: () => Promise<{ success: boolean; error?: string }>;
}

function MaintenanceActionRow({ action }: { action: MaintenanceAction }) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "arming") return;
    const t = setTimeout(() => setStatus("idle"), 4000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (status !== "success" && status !== "error") return;
    const t = setTimeout(() => {
      setStatus("idle");
      setErrorMsg(null);
    }, 3000);
    return () => clearTimeout(t);
  }, [status]);

  async function handleClick() {
    if (status === "idle") {
      setStatus("arming");
      return;
    }
    if (status !== "arming") return;
    setStatus("running");
    setErrorMsg(null);
    const result = await action.invoke();
    if (result.success) {
      setStatus("success");
    } else {
      setStatus("error");
      setErrorMsg(result.error ?? "Unknown error");
    }
  }

  const label =
    status === "arming" ? t("settings.maintenance.arming")
    : status === "running" ? t(`${action.i18nKey}.running`)
    : status === "success" ? t(`${action.i18nKey}.success`)
    : status === "error" ? t("settings.maintenance.failed")
    : t(`${action.i18nKey}.idle`);

  const variant =
    status === "arming" || status === "error" ? "danger"
    : status === "success" ? "primary"
    : "default";

  return (
    <div className="flex justify-between items-center min-h-[44px]">
      <div className="pr-4">
        <div className="text-sm text-base-content">{t(`${action.i18nKey}.title`)}</div>
        <div className="text-xs text-base-content/50 mt-0.5">
          {t(`${action.i18nKey}.description`)}
          {errorMsg && (
            <span className="block text-error mt-1 font-mono text-[11px]">{errorMsg}</span>
          )}
        </div>
      </div>
      <Button
        onClick={handleClick}
        disabled={status === "running"}
        variant={variant}
      >
        {label}
      </Button>
    </div>
  );
}

const EXPORT_LOGS_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.export_logs",
  invoke: exportLogs,
};

const RESTART_SERVER_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.restart_server",
  invoke: restartServer,
};

const RESTART_STEAM_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.restart_steam",
  invoke: restartSteam,
};

const UNFREEZE_STEAM_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.unfreeze_steam",
  invoke: forceUnfreezeSteam,
};

const SHUTDOWN_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.shutdown",
  invoke: systemShutdown,
};

const REBOOT_ACTION: MaintenanceAction = {
  i18nKey: "settings.maintenance.reboot",
  invoke: systemReboot,
};


/**
 * "Clear all data caches" — fans `clearExternalCache` out via
 * `__broadcast` so every plugin that implements the convention
 * (protondb-badges, hltb, steamgriddb, …) wipes its on-disk
 * `@loadout/external-cache` directory in one click.
 *
 * Renders as a `MaintenanceActionRow` for visual + behavioural
 * parity with "Restart server" and friends — same arming
 * confirm dance, same idle/running/success label flow. Wraps
 * `useBackend("__broadcast")` because the row constants above
 * can't pull from a React hook context.
 *
 * The broadcast result envelope is `{ called: number, errors:
 * Array<{plugin, error}> }`. Per-plugin errors don't fail the
 * whole action — the row reports a partial failure in the error
 * label so the user knows which plugin couldn't drop its cache.
 */
function ClearDataCachesActionRow() {
  const { call } = useBackend("__broadcast");
  const action: MaintenanceAction = {
    i18nKey: "settings.maintenance.clear_caches",
    invoke: async () => {
      try {
        const res = (await call("clearExternalCache")) as {
          called: number;
          errors: Array<{ plugin: string; error: string }>;
        };
        if (res?.errors && res.errors.length > 0) {
          return {
            success: false,
            error: `${res.errors.length} plugin(s) failed: ${res.errors
              .map((e) => `${e.plugin} (${e.error})`)
              .join(", ")}`,
          };
        }
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
  return <MaintenanceActionRow action={action} />;
}

function ShortcutRow({
  label,
  value,
  onChange,
  plugins,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  plugins: PluginOption[];
}) {
  const options = [
    { value: "none", label: "None" },
    { value: "toggle_overlay", label: "Toggle Overlay" },
    { value: "open_settings", label: "Open Settings" },
    { value: "open_home", label: "Open Home" },
    { value: "toggle_keyboard", label: "Toggle Keyboard" },
    ...plugins.map((p) => ({ value: `plugin:${p.id}`, label: `Open ${p.name}` })),
  ];

  return (
    <div className="flex justify-between items-center min-h-[44px] rounded-lg px-2">
      <div className="flex items-center gap-2">
        <kbd className="kbd kbd-sm">{label}</kbd>
      </div>
      <Select value={value} options={options} onChange={onChange} className="w-56" />
    </div>
  );
}

export function Settings({ scale, onScaleChange, plugins = [], onShowWelcome }: SettingsProps) {
  return (
    <PluginProvider parentFocusKey="content">
      <SettingsInner
        scale={scale}
        onScaleChange={onScaleChange}
        plugins={plugins}
        onShowWelcome={onShowWelcome}
      />
    </PluginProvider>
  );
}

function SettingsInner({
  scale,
  onScaleChange,
  plugins,
  onShowWelcome,
}: Required<Omit<SettingsProps, "onShowWelcome">> & { onShowWelcome?: () => void }) {
  const { t } = useTranslation("app");
  const [tab, setTab] = useState<TabId>("general");
  const [theme, setTheme] = useConfigValue<string>("theme", loadTheme());
  const [language, setLanguageConfig] = useConfigValue<string>("language", DEFAULT_LANGUAGE);
  const [startupView, setStartupView] = useConfigValue<string>("startupView", "home");
  const [autoCollapseSidebar, setAutoCollapseSidebar] = useSidebarAutoCollapseSetting();
  const [shortcuts, setShortcuts] = useState<ControllerShortcuts | null>(null);
  const { isEnabled, toggle: togglePluginEnabled } = useEnabledPlugins();
  const allPluginIds = useMemo(() => plugins.map((p) => p.id), [plugins]);
  const sortedPlugins = useMemo(
    () => [...plugins].sort((a, b) => a.name.localeCompare(b.name)),
    [plugins],
  );
  const enabledCount = sortedPlugins.filter((p) => isEnabled(p.id)).length;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    getControllerShortcuts().then(setShortcuts).catch(() => {});
  }, []);

  function handleLanguageChange(code: string) {
    // Persist the choice and switch the live i18next language — every
    // mounted shell + plugin consumer re-renders, no reload needed.
    setLanguageConfig(code);
    void setLanguage(code);
  }

  function handleShortcutChange(key: keyof ControllerShortcuts, value: string) {
    if (!shortcuts) return;
    const updated = { ...shortcuts, [key]: stringToAction(value) };
    setShortcuts(updated);
    setControllerShortcuts(updated).catch(() => {});
  }

  return (
    <div data-scroll-root="true" className="p-6 h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto">
        {/* Tabs */}
        <div className="mb-6">
          <TabBar
            tabs={TAB_IDS.map((id) => ({ id, label: t(`settings.tab.${id}`) }))}
            activeTab={tab}
            onTabChange={(id) => setTab(id as TabId)}
          />
        </div>

        {/* General tab */}
        {tab === "general" && (
          <>
            {/* Appearance */}
            <section className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.appearance")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm text-base-content">{t("settings.ui_scale")}</span>
                  <span className="text-sm font-mono text-primary font-bold">{scale.toFixed(2)}x</span>
                </div>
                <Slider
                  min={0.75}
                  max={2}
                  step={0.05}
                  value={scale}
                  onChange={onScaleChange}
                />
                <div className="flex justify-between text-xs text-base-content/30 mt-1.5">
                  <span>0.75x</span>
                  <span>1.0x</span>
                  <span>2.0x</span>
                </div>
              </div>
            </section>

            {/* Language */}
            <section className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.language")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5">
                <div className="flex justify-between items-center min-h-[44px]">
                  <div className="pr-4">
                    <div className="text-sm text-base-content">{t("settings.section.language")}</div>
                    <div className="text-xs text-base-content/50 mt-0.5">
                      {t("settings.language_desc")}
                    </div>
                  </div>
                  <Select
                    value={language}
                    options={SUPPORTED_LANGUAGES.map((l) => ({
                      value: l.code,
                      label: l.label,
                    }))}
                    onChange={handleLanguageChange}
                    className="w-48"
                  />
                </div>
              </div>
            </section>

            {/* Homepage */}
            <section className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.homepage")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5 space-y-4 divide-y divide-base-300 [&>*]:pt-4 [&>*:first-child]:pt-0">
                <div className="flex justify-between items-center min-h-[44px]">
                  <span className="text-sm text-base-content">{t("settings.on_startup")}</span>
                  <Select
                    value={startupView}
                    options={[
                      { value: "home", label: t("settings.startup.home") },
                      { value: "last-tab", label: t("settings.startup.last_tab") },
                    ]}
                    onChange={setStartupView}
                    className="w-48"
                  />
                </div>
                {onShowWelcome && (
                  <div className="flex justify-between items-center min-h-[44px]">
                    <div className="pr-4">
                      <div className="text-sm text-base-content">{t("settings.welcome_tour")}</div>
                      <div className="text-xs text-base-content/50 mt-0.5">
                        {t("settings.welcome_tour_desc")}
                      </div>
                    </div>
                    <Button onClick={onShowWelcome}>{t("settings.show_welcome")}</Button>
                  </div>
                )}
              </div>
            </section>

            {/* Sidebar */}
            <section className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.sidebar")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5">
                <div className="flex justify-between items-center min-h-[44px]">
                  <div className="pr-4">
                    <div className="text-sm text-base-content">{t("settings.auto_collapse")}</div>
                    <div className="text-xs text-base-content/50 mt-0.5">
                      {t("settings.auto_collapse_desc")}
                    </div>
                  </div>
                  <Toggle checked={autoCollapseSidebar} onChange={setAutoCollapseSidebar} />
                </div>
              </div>
            </section>

            {/* Theme — four Loadout themes with big preview swatch cards */}
            <section className="mb-6">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40">{t("settings.section.theme")}</h3>
                <span className="chip chip-accent">
                  {LOADOUT_THEMES.find((t) => t.id === theme)?.name ?? "Midnight"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {LOADOUT_THEMES.map((t) => (
                  <ThemeSwatch
                    key={t.id}
                    theme={t}
                    active={theme === t.id}
                    onSelect={() => setTheme(t.id)}
                  />
                ))}
              </div>
            </section>

            {/* Maintenance */}
            <section className="mb-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.maintenance")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5 space-y-4 divide-y divide-base-300 [&>*]:pt-4 [&>*:first-child]:pt-0">
                <MaintenanceActionRow action={EXPORT_LOGS_ACTION} />
                <ClearDataCachesActionRow />
                <MaintenanceActionRow action={RESTART_SERVER_ACTION} />
                <MaintenanceActionRow action={RESTART_STEAM_ACTION} />
                <MaintenanceActionRow action={UNFREEZE_STEAM_ACTION} />
                <MaintenanceActionRow action={SHUTDOWN_ACTION} />
                <MaintenanceActionRow action={REBOOT_ACTION} />
              </div>
            </section>

            {/* About */}
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">{t("settings.section.about")}</h3>
              <div className="bg-base-200 rounded-2xl border border-base-300 p-5">
                <div className="flex justify-between items-center min-h-[44px]">
                  <span className="text-sm text-base-content">{t("settings.version")}</span>
                  <code className="text-sm text-primary bg-primary/10 px-3 py-1 rounded-lg font-mono">{VERSION}</code>
                </div>
              </div>
            </section>
          </>
        )}

        {/* Plugins tab */}
        {tab === "plugins" && (
          <section>
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40">
                {t("settings.installed_plugins")}
              </h3>
              <span className="text-xs text-base-content/40">
                {t("settings.plugins_enabled_count", {
                  enabled: enabledCount,
                  total: sortedPlugins.length,
                })}
              </span>
            </div>
            <div className="bg-base-200 rounded-2xl border border-base-300 p-2">
              {sortedPlugins.length === 0 && (
                <div className="text-center py-8 text-sm text-base-content/40">
                  {t("settings.no_plugins")}
                </div>
              )}
              {sortedPlugins.map((plugin) => {
                const on = isEnabled(plugin.id);
                return (
                  <div
                    key={plugin.id}
                    className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-base-300/30 min-h-[60px]"
                  >
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        on
                          ? "bg-primary text-primary-content"
                          : "bg-base-300/70 text-base-content/50"
                      }`}
                    >
                      {(plugin.icon ?? plugin.name)[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-base-content truncate">
                        {plugin.name}
                      </div>
                      <div className="text-xs text-base-content/50 line-clamp-2">
                        {plugin.subtitle || plugin.description || t("settings.no_description")}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Toggle
                        checked={on}
                        onChange={() => togglePluginEnabled(plugin.id, allPluginIds)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Controller tab */}
        {tab === "controller" && (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">
              {t("settings.controller_shortcuts")}
            </h3>
            <div className="bg-base-200 rounded-2xl border border-base-300 p-5 space-y-4">
              <p className="text-xs text-base-content/50">
                {t("settings.controller_hint")}
              </p>
              {shortcuts &&
                BUTTON_LABELS.map(({ key, label }) => (
                  <ShortcutRow
                    key={key}
                    label={label}
                    value={actionToString(shortcuts[key])}
                    onChange={(v) => handleShortcutChange(key, v)}
                    plugins={plugins}
                  />
                ))}
              {!shortcuts && (
                <div className="text-sm text-base-content/40">{t("settings.loading")}</div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
