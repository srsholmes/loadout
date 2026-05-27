import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FaArrowUpRightFromSquare,
  FaArrowsRotate,
  FaBookOpen,
  FaBookmark,
  FaCheck,
  FaCircleExclamation,
  FaClock,
  FaComments,
  FaGear,
  FaGlobe,
  FaGoogle,
  FaLink,
  FaLinux,
  FaNewspaper,
  FaPen,
  FaPlus,
  FaPuzzlePiece,
  FaQuestion,
  FaRedditAlien,
  FaStar,
  FaStarHalfStroke,
  FaSteam,
  FaStopwatch,
  FaTag,
  FaTrash,
  FaTwitch,
  FaWikipediaW,
  FaWrench,
  FaYoutube,
} from "react-icons/fa6";
import {
  HeaderBackButton,
  IconButton,
  PluginHeader,
  PluginProvider,
  Select,
  Spinner,
  TextInput,
  Toggle,
  notify,
  useBackend,
  useCurrentGame,
  useFocusable,
} from "@loadout/ui";

export const icon = FaLink;

// ─── Wire-shape types (mirror backend.ts) ────────────────────────────

interface LinkTemplate {
  id: string;
  name: string;
  description?: string;
  urlTemplate: string;
  suffixGroup?: string;
  steamOnly?: boolean;
  builtin: boolean;
  enabled: boolean;
}

interface GamePins {
  pinnedTemplateIds: string[];
  customLinks: { name: string; url: string }[];
}

type BrowserKind = "native" | "flatpak";

interface BrowserCandidate {
  id: string;
  name: string;
  kind: BrowserKind;
  exe: string;
  launchOptionsBase: string;
  flatpakAppId?: string;
}

interface InstalledShortcut {
  browserId: string;
  name: string;
  kind: BrowserKind;
  appId: number;
  gameId64: string;
  exe: string;
  launchOptionsBase: string;
}

interface QuickLinksStorage {
  version: 1;
  templates: LinkTemplate[];
  suffixes: Record<string, string[]>;
  perGame: Record<string, GamePins>;
  hidden: string[];
  /** BrowserCandidate.id chosen by the user. Null = use the
   *  most-recently-installed default. */
  selectedBrowserId?: string | null;
  /** All registered browser shortcuts. Persisted so the UI can show
   *  install state without re-detecting on every mount. */
  installedBrowsers: InstalledShortcut[];
}

// Pure URL/chip helpers live in lib.ts so bun:test can exercise them
// without React (see `lib.spec.ts`).
import { buildChips, isSteamApp } from "./lib";

// ─── Per-template icon mapping ───────────────────────────────────────

/**
 * Site-thematic icon used as the daisyUI `image-full` figure for each
 * landing card. Brand icons (YouTube, Reddit, Twitch, Google, Steam,
 * Wikipedia) come from `react-icons/fa6` directly; everything else
 * picks a thematic glyph (linux for ProtonDB, clock for HLTB,
 * stopwatch for Speedrun, …). Custom links + unknown ids fall through
 * to the generic FaLink. New built-ins added to `DEFAULT_TEMPLATES`
 * should grow this map at the same time.
 */
const TEMPLATE_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  youtube: FaYoutube,
  google: FaGoogle,
  protondb: FaLinux,
  steamdb: FaSteam,
  hltb: FaClock,
  pcgw: FaWrench,
  gamefaqs: FaQuestion,
  ign: FaNewspaper,
  "steam-guides": FaBookOpen,
  "steam-discuss": FaComments,
  reddit: FaRedditAlien,
  nexus: FaPuzzlePiece,
  wikipedia: FaWikipediaW,
  itad: FaTag,
  metacritic: FaStar,
  opencritic: FaStarHalfStroke,
  speedrun: FaStopwatch,
  twitch: FaTwitch,
  backloggd: FaBookmark,
};

function iconForTemplate(templateId: string): ComponentType<{ size?: number; className?: string }> {
  return TEMPLATE_ICONS[templateId] ?? FaLink;
}

// ─── Host-overlay dismissal (best-effort) ────────────────────────────

/**
 * Try to dismiss the overlay via the Electrobun host's `hide` RPC.
 * Plugins don't get a sanctioned `useHost()` SDK hook today, so reach
 * into `window.__electroview` directly. No-op outside Electrobun (vite
 * dev / unit tests) and silently swallows failures so a broken host
 * RPC can't tank the user's link click.
 */
function dismissOverlay(): void {
  try {
    const w = window as unknown as {
      __electroview?: { rpc?: { request?: Record<string, (...a: unknown[]) => Promise<unknown>> } };
    };
    const fn = w.__electroview?.rpc?.request?.hide;
    if (typeof fn === "function") void fn();
  } catch {
    /* best-effort */
  }
}

// ─── Shared launch helper ────────────────────────────────────────────

/**
 * Hand a URL to quick-links' own `launchUrl` backend RPC. The
 * browser-shortcut layer (formerly gaming-mode-browser, now folded
 * into this plugin) handles routing to the user's chosen browser.
 */
function useLinkLauncher(
  selectedBrowserId: string | null | undefined,
): (url: string) => Promise<void> {
  const { call } = useBackend("quick-links");
  return useCallback(
    async (url: string) => {
      try {
        // Pass the user's chosen browser as the second arg so the
        // backend routes to that specific shortcut. If omitted
        // (null/undefined), call with just url so the RPC layer
        // (and its asserting tests) doesn't see a stray undefined
        // third arg — the backend falls back to the
        // most-recently-installed default for that case.
        const args: unknown[] =
          selectedBrowserId != null
            ? ["launchUrl", url, selectedBrowserId]
            : ["launchUrl", url];
        const result = (await call(...(args as [string, ...unknown[]]))) as
          | { launched: true }
          | { launched: false; reason: string; message: string };
        if (result.launched) {
          // Drop the overlay so the user can see the browser they
          // just opened.
          dismissOverlay();
          return;
        }
        if (result.reason === "not-installed") {
          notify("Install a browser in Quick Links settings first", {
            kind: "error",
          });
          return;
        }
        notify(result.message ?? "Couldn't launch the browser", {
          kind: "error",
        });
        try {
          await navigator.clipboard.writeText(url);
          notify("URL copied to clipboard", { kind: "success" });
        } catch {
          /* best effort */
        }
      } catch (err) {
        notify(
          `Quick Links launch failed: ${err instanceof Error ? err.message : String(err)}`,
          { kind: "error" },
        );
      }
    },
    [call, selectedBrowserId],
  );
}

// ─── Focusable building blocks ──────────────────────────────────────

/**
 * Gamepad-focusable `<button>` — every interactive surface in the
 * plugin page must go through this so d-pad nav can reach it and
 * Enter / A-button activates it. `focusable: !disabled` keeps the
 * focus tree from sticking on greyed-out buttons; the inner
 * `if (!disabled)` guard fires defensively in case a stale focusable
 * is still in the tree mid-render.
 */
function FocusButton({
  onClick,
  disabled,
  children,
  className = "btn btn-sm",
  title,
  ariaLabel,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const { ref, focused } = useFocusable({
    focusable: !disabled,
    onEnterPress: () => {
      if (!disabled) onClick();
    },
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`${className} ${focused ? "ring-2 ring-primary/60" : ""}`}
    >
      {children}
    </button>
  );
}

function ChipButton({
  label,
  onClick,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  variant?: "default" | "success";
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onClick });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={
        "chip cursor-pointer hover:bg-primary/20 " +
        (variant === "success" ? "chip-success " : "") +
        (focused ? "ring-2 ring-primary/60" : "")
      }
    >
      {label}
    </button>
  );
}

// ─── Home widget ─────────────────────────────────────────────────────

function QuickLinksHomeWidget() {
  const { call, useEvent } = useBackend("quick-links");
  const currentGame = useCurrentGame();
  const [storage, setStorage] = useState<QuickLinksStorage | null>(null);
  const launch = useLinkLauncher(storage?.selectedBrowserId);

  useEffect(() => {
    void call("getState").then((s) =>
      setStorage(s as QuickLinksStorage),
    );
  }, [call]);

  useEvent({
    event: "stateChanged",
    handler: (data) => setStorage(data as QuickLinksStorage),
  });

  if (!storage) {
    return (
      <div className="card-body">
        <div className="card-title">QUICK LINKS</div>
        <div className="flex items-center justify-center py-3">
          <Spinner size={16} />
        </div>
      </div>
    );
  }

  if (!currentGame) {
    return (
      <div className="card-body">
        <div className="card-title mb-2">QUICK LINKS</div>
        <div className="text-xs italic text-base-content/60">
          No game running — start a game to see contextual links.
        </div>
      </div>
    );
  }

  const appId = currentGame.appId;
  const gameName = currentGame.gameName || `App ${appId}`;
  const pins = storage.perGame[String(appId)];
  const chips = buildChips(storage, appId, gameName, pins);

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-2.5 gap-2">
        <div className="card-title">QUICK LINKS</div>
        <div className="chip truncate max-w-[60%]" title={gameName}>
          {gameName}
        </div>
      </div>
      {chips.length === 0 ? (
        <div className="text-xs italic text-base-content/60">
          No templates enabled. Open the Quick Links plugin to set some up.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <ChipButton
              key={c.key}
              label={c.label}
              onClick={() => void launch(c.url)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Full plugin page ────────────────────────────────────────────────

function TemplateRow({
  template,
  hidden,
  storage,
  onUpdate,
  onDelete,
  onUnhide,
}: {
  template: LinkTemplate;
  hidden: boolean;
  storage: QuickLinksStorage;
  onUpdate: (patch: Partial<LinkTemplate>) => Promise<void>;
  onDelete: () => Promise<void>;
  onUnhide: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: template.name,
    urlTemplate: template.urlTemplate,
    suffixGroup: template.suffixGroup ?? "",
  });

  useEffect(() => {
    if (!editing) {
      setDraft({
        name: template.name,
        urlTemplate: template.urlTemplate,
        suffixGroup: template.suffixGroup ?? "",
      });
    }
  }, [
    editing,
    template.name,
    template.urlTemplate,
    template.suffixGroup,
  ]);

  const save = async () => {
    await onUpdate({
      name: draft.name.trim() || template.name,
      urlTemplate: draft.urlTemplate.trim() || template.urlTemplate,
      suffixGroup:
        draft.suffixGroup.trim().length > 0
          ? draft.suffixGroup.trim()
          : undefined,
    });
    setEditing(false);
  };

  const suffixCount = template.suffixGroup
    ? (storage.suffixes[template.suffixGroup] ?? []).length
    : 0;

  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: "var(--color-base-200, rgba(255,255,255,0.04))",
        opacity: hidden ? 0.55 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <div className="text-sm font-medium truncate">
              {template.name}
            </div>
            {template.builtin ? (
              <span className="chip text-[10px]">built-in</span>
            ) : (
              <span className="chip text-[10px]">custom</span>
            )}
            {template.steamOnly && (
              <span className="chip text-[10px]">Steam apps only</span>
            )}
            {template.suffixGroup && (
              <span className="chip text-[10px]">
                {suffixCount} suffix{suffixCount === 1 ? "" : "es"}
              </span>
            )}
          </div>
          <div className="text-[11px] mono text-base-content/55 truncate">
            {template.urlTemplate}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hidden ? (
            <FocusButton
              onClick={() => void onUnhide()}
              className="btn btn-sm btn-ghost"
              title="Restore"
              ariaLabel="Restore"
            >
              <FaArrowsRotate />
            </FocusButton>
          ) : (
            <>
              <Toggle
                checked={template.enabled}
                onChange={(v) => void onUpdate({ enabled: v })}
              />
              <FocusButton
                onClick={() => setEditing((v) => !v)}
                className="btn btn-sm btn-ghost"
                title="Edit"
                ariaLabel="Edit"
              >
                <FaPen />
              </FocusButton>
              <FocusButton
                onClick={() => void onDelete()}
                className="btn btn-sm btn-ghost"
                title={template.builtin ? "Hide" : "Delete"}
                ariaLabel={template.builtin ? "Hide" : "Delete"}
              >
                <FaTrash />
              </FocusButton>
            </>
          )}
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-base-300/40">
          <TextInput
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name }))}
            placeholder="Display name"
          />
          <TextInput
            value={draft.urlTemplate}
            onChange={(urlTemplate) =>
              setDraft((d) => ({ ...d, urlTemplate }))
            }
            placeholder="URL with {appId}, {name}, {name_raw}, {suffix}"
          />
          <TextInput
            value={draft.suffixGroup}
            onChange={(suffixGroup) =>
              setDraft((d) => ({ ...d, suffixGroup }))
            }
            placeholder="Suffix group key (optional, e.g. youtube)"
          />
          <div className="flex gap-2">
            <FocusButton
              onClick={() => void save()}
              className="btn btn-sm btn-primary"
            >
              Save
            </FocusButton>
            <FocusButton
              onClick={() => setEditing(false)}
              className="btn btn-sm btn-ghost"
            >
              Cancel
            </FocusButton>
          </div>
        </div>
      )}
    </div>
  );
}

function SuffixGroupEditor({
  group,
  suffixes,
  onChange,
}: {
  group: string;
  suffixes: string[];
  onChange: (next: string[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="rounded-lg p-3 bg-base-200">
      <div className="text-sm font-medium mb-1.5 capitalize">
        {group} suffixes
      </div>
      <div className="text-[11px] text-base-content/55 mb-2">
        Each entry becomes one chip on the home widget. Empty the list
        to render this template as a single chip.
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {suffixes.map((s, i) => (
          <ChipButton
            key={`${s}-${i}`}
            label={`${s} ×`}
            onClick={() => {
              const next = suffixes.slice();
              next.splice(i, 1);
              void onChange(next);
            }}
          />
        ))}
        {suffixes.length === 0 && (
          <span className="text-[11px] italic text-base-content/50">
            no suffixes
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder="Add a suffix, e.g. before you begin"
        />
        <FocusButton
          className="btn btn-sm"
          ariaLabel="Add suffix"
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            void onChange([...suffixes, v]);
            setDraft("");
          }}
        >
          <FaPlus />
        </FocusButton>
      </div>
    </div>
  );
}

function PerGameCard({
  storage,
  appId,
  gameName,
  onSetPins,
  onAddLink,
  onRemoveLink,
}: {
  storage: QuickLinksStorage;
  appId: number;
  gameName: string;
  onSetPins: (ids: string[]) => Promise<void>;
  onAddLink: (link: { name: string; url: string }) => Promise<void>;
  onRemoveLink: (index: number) => Promise<void>;
}) {
  const key = String(appId);
  const pins = storage.perGame[key]?.pinnedTemplateIds ?? [];
  const customLinks = storage.perGame[key]?.customLinks ?? [];
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const togglePin = (id: string) => {
    if (pins.includes(id)) {
      void onSetPins(pins.filter((x) => x !== id));
    } else {
      void onSetPins([...pins, id]);
    }
  };

  const visibleTemplates = storage.templates.filter(
    (t) =>
      !storage.hidden.includes(t.id) &&
      (!t.steamOnly || isSteamApp(appId)),
  );

  return (
    <div className="rounded-lg p-3 bg-base-200">
      <div className="text-sm font-medium mb-0.5">
        Pins for {gameName}
      </div>
      <div className="text-[11px] text-base-content/55 mb-2">
        Pinned templates show up first on the home widget while this
        game is running.
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {visibleTemplates.map((t) => (
          <ChipButton
            key={t.id}
            label={`${pins.includes(t.id) ? "★ " : ""}${t.name}`}
            onClick={() => togglePin(t.id)}
            variant={pins.includes(t.id) ? "success" : "default"}
          />
        ))}
      </div>

      <div className="text-sm font-medium mb-1.5">Custom links</div>
      <div className="flex flex-col gap-1 mb-2">
        {customLinks.length === 0 && (
          <span className="text-[11px] italic text-base-content/50">
            none yet
          </span>
        )}
        {customLinks.map((l, i) => (
          <div
            key={`${l.url}-${i}`}
            className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-base-300/30"
          >
            <div className="min-w-0">
              <div className="text-sm truncate">{l.name}</div>
              <div className="text-[10px] mono truncate text-base-content/55">
                {l.url}
              </div>
            </div>
            <FocusButton
              className="btn btn-xs btn-ghost"
              onClick={() => void onRemoveLink(i)}
              ariaLabel="Remove"
            >
              <FaTrash />
            </FocusButton>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <TextInput value={name} onChange={setName} placeholder="Label" />
        <TextInput value={url} onChange={setUrl} placeholder="https://…" />
        <FocusButton
          className="btn btn-sm"
          disabled={!name.trim() || !url.trim()}
          onClick={() => {
            void onAddLink({ name: name.trim(), url: url.trim() });
            setName("");
            setUrl("");
          }}
        >
          <FaPlus className="mr-1" /> Add custom link
        </FocusButton>
      </div>
    </div>
  );
}

// ─── Browser shortcut UI (folded in from gaming-mode-browser) ───────

function BrowserRadio({
  candidate,
  checked,
  onSelect,
}: {
  candidate: BrowserCandidate;
  checked: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className={
        "flex items-center justify-between gap-3 px-3 py-2 rounded-lg w-full text-left " +
        (checked ? "bg-primary/15 ring-1 ring-primary/40 " : "bg-base-200 ") +
        (focused ? "ring-2 ring-primary/60" : "")
      }
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{candidate.name}</div>
        <div className="text-[11px] text-base-content/55 mono truncate">
          {candidate.kind === "flatpak"
            ? `flatpak · ${candidate.flatpakAppId}`
            : candidate.exe}
        </div>
      </div>
      <span
        className={
          "w-4 h-4 rounded-full border-2 shrink-0 " +
          (checked
            ? "border-primary bg-primary"
            : "border-base-content/40 bg-transparent")
        }
      />
    </button>
  );
}

/**
 * Combined card: pick which installed shortcut Quick Links uses to
 * open URLs (the original BrowserPickerCard), plus the
 * detect-and-install flow that used to live in its own plugin
 * (gaming-mode-browser). The install flow only shows up after the
 * user clicks "Add another browser" so the common case (already have
 * one installed, just want to pick which one) stays uncluttered.
 */
function BrowserShortcutCard({
  storage,
  startExpanded,
  onChangeSelected,
  onInstall,
  onUninstall,
}: {
  storage: QuickLinksStorage;
  startExpanded: boolean;
  onChangeSelected: (browserId: string | null) => void;
  onInstall: (browserId: string) => Promise<void>;
  onUninstall: (browserId: string) => Promise<void>;
}) {
  const { call } = useBackend("quick-links");
  const [candidates, setCandidates] = useState<BrowserCandidate[] | null>(null);
  const [steamReachable, setSteamReachable] = useState<boolean | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installerOpen, setInstallerOpen] = useState(startExpanded);

  const installed = storage.installedBrowsers;
  const installedIds = useMemo(
    () => new Set(installed.map((s) => s.browserId)),
    [installed],
  );

  const refresh = useCallback(async () => {
    const [list, reachable] = await Promise.all([
      call("detectBrowsers") as Promise<BrowserCandidate[]>,
      call("isSteamReachable") as Promise<boolean>,
    ]);
    setCandidates(list);
    setSteamReachable(reachable);
    setPick((prev) => {
      // Prefer to default the picker to a not-yet-installed candidate
      // so "Install" actually adds a new entry rather than re-installing
      // the same one.
      if (prev && list.some((c) => c.id === prev)) return prev;
      const unused = list.find((c) => !installedIds.has(c.id));
      if (unused) return unused.id;
      return list[0]?.id ?? null;
    });
  }, [call, installedIds]);

  useEffect(() => {
    if (!installerOpen) return;
    void refresh();
  }, [installerOpen, refresh]);

  const install = useCallback(async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await onInstall(pick);
      // Successful install → collapse the installer back into the
      // compact state so the user lands on the picker again.
      setInstallerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onInstall, pick]);

  const pickerOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: "__default__", label: "Default (most-recent install)" },
    ];
    for (const b of installed) {
      opts.push({ value: b.browserId, label: b.name });
    }
    return opts;
  }, [installed]);

  const selectValue = storage.selectedBrowserId ?? "__default__";

  return (
    <div className="card">
      <div className="card-body p-4.5">
        <div className="flex items-center gap-2 mb-2">
          <FaGlobe className="w-4 h-4 shrink-0 text-base-content/60" />
          <div className="subsection-label mb-0">Browser shortcut</div>
        </div>
        <div className="subsection-desc mb-3">
          Quick Links opens URLs through a non-Steam game shortcut —
          that's what lets your browser inherit Gaming Mode's BPM
          session (Steam Input, overlay, library entry). Pick which
          browser is the default for new clicks, or add another.
        </div>

        {installed.length > 0 && (
          <>
            <div className="flex flex-col gap-1.5 mb-3">
              {installed.map((s) => (
                <div
                  key={s.browserId}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-base-200"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <FaCheck className="w-3 h-3 shrink-0 text-success" />
                      <div className="text-sm font-medium truncate">
                        {s.name}
                      </div>
                    </div>
                    <div className="text-[11px] text-base-content/55 mono truncate">
                      appid {s.appId}
                      {s.kind === "flatpak" ? " · flatpak" : ""}
                    </div>
                  </div>
                  <FocusButton
                    className="btn btn-xs btn-ghost"
                    onClick={() => void onUninstall(s.browserId)}
                    title={`Uninstall ${s.name}`}
                    ariaLabel={`Uninstall ${s.name}`}
                  >
                    <FaTrash />
                  </FocusButton>
                </div>
              ))}
            </div>

            <div className="text-[11px] uppercase tracking-wider text-base-content/45 mb-1.5">
              Open links in
            </div>
            <Select
              value={selectValue}
              options={pickerOptions}
              onChange={(v) =>
                onChangeSelected(v === "__default__" ? null : v)
              }
            />
          </>
        )}

        {!installerOpen ? (
          <div className="mt-3.5">
            <FocusButton
              className="btn btn-sm"
              onClick={() => setInstallerOpen(true)}
            >
              <FaPlus className="mr-1" />{" "}
              {installed.length === 0 ? "Install a browser" : "Add another browser"}
            </FocusButton>
          </div>
        ) : (
          <div className="border-t border-base-300/40 mt-4 pt-3">
            <div className="text-sm font-medium mb-1.5">
              Register a desktop browser as a non-Steam game
            </div>
            <div className="subsection-desc mb-2">
              The picked browser shows up in your Steam library so
              Gaming Mode can launch it. Used by Quick Links to open
              wiki / ProtonDB / YouTube searches for the running game.
            </div>

            {steamReachable === false && (
              <div
                className="subsection-desc mt-2"
                style={{ color: "var(--color-error)" }}
              >
                <FaCircleExclamation className="inline w-3 h-3 mr-1" />
                Steam isn't responding on its debug port. Start Steam
                (Big Picture or Gaming Mode), then click Refresh.
              </div>
            )}

            {candidates === null ? (
              <div className="flex items-center justify-center h-10">
                <Spinner size={16} />
              </div>
            ) : candidates.length === 0 ? (
              <div className="subsection-desc mt-2 italic text-base-content/60">
                No supported browsers detected. Install Firefox, Chrome,
                Brave, Chromium, Edge, or Vivaldi — either as a native
                package or as a Flatpak.
              </div>
            ) : (
              <div className="flex flex-col gap-2 mt-2">
                {candidates.map((c) => (
                  <BrowserRadio
                    key={c.id}
                    candidate={c}
                    checked={pick === c.id}
                    onSelect={() => setPick(c.id)}
                  />
                ))}
              </div>
            )}

            {error && (
              <div
                className="subsection-desc mt-2"
                style={{ color: "var(--color-error)" }}
              >
                {error}
              </div>
            )}

            <div className="flex gap-2 mt-3 flex-wrap">
              <FocusButton
                onClick={() => void install()}
                disabled={
                  busy ||
                  !pick ||
                  steamReachable === false ||
                  (candidates ?? []).length === 0
                }
                className="btn btn-sm btn-primary"
              >
                {busy
                  ? "Working…"
                  : pick && installedIds.has(pick)
                    ? "Reinstall shortcut"
                    : "Install as non-Steam game"}
              </FocusButton>
              <FocusButton
                onClick={() => void refresh()}
                disabled={busy}
                className="btn btn-sm btn-ghost"
              >
                Refresh
              </FocusButton>
              <FocusButton
                onClick={() => setInstallerOpen(false)}
                disabled={busy}
                className="btn btn-sm btn-ghost"
              >
                Cancel
              </FocusButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Gaming-mode warning banner. Shows on the landing view when:
 *   - we're running under gamescope (Gaming Mode), AND
 *   - no Chrome/Firefox shortcut is currently registered.
 *
 * "Switch to settings" is the only useful action — that's where the
 * BrowserShortcutCard lives. Outside Gaming Mode the banner stays
 * hidden because the user can just open URLs in their desktop
 * browser; the registered-shortcut path is only really needed inside
 * BPM where there's no xdg-open chain you can rely on.
 */
function NoBrowserBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onOpenSettings });
  return (
    <div
      className="p-3.5 mb-4 flex items-center gap-3 border-b border-base-content/10"
      role="alert"
    >
      <FaCircleExclamation className="w-5 h-5 shrink-0 text-warning" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium mb-0.5">
          No browser shortcut registered
        </div>
        <div className="text-[12px] text-base-content/75 leading-snug">
          In Gaming Mode, Quick Links needs a Chrome or Firefox shortcut
          registered with Steam to open links. Add one in settings.
        </div>
      </div>
      <button
        ref={ref}
        type="button"
        onClick={onOpenSettings}
        className={
          "btn btn-sm btn-primary shrink-0 " +
          (focused ? "ring-2 ring-primary/60" : "")
        }
      >
        Open settings
      </button>
    </div>
  );
}

// ─── Landing page (default view) ─────────────────────────────────────

/**
 * Card grid shown when a game is running. One card per visible
 * template (suffix-expanded), each with title, description, the
 * resolved URL preview, and a focusable "Open" button. Per-game
 * custom links append at the end.
 */
function LandingCardGrid({
  storage,
  appId,
  gameName,
  onOpen,
}: {
  storage: QuickLinksStorage;
  appId: number;
  gameName: string;
  onOpen: (url: string) => void;
}) {
  const pins = storage.perGame[String(appId)];
  const chips = useMemo(
    () => buildChips(storage, appId, gameName, pins),
    [storage, appId, gameName, pins],
  );

  if (chips.length === 0) {
    return (
      <div className="card">
        <div className="card-body p-4.5">
          <div className="text-sm italic text-base-content/60">
            No templates enabled. Open settings (cog in the header) to
            turn some on or restore hidden templates.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {chips.map((c) => {
        let host = "";
        try {
          host = new URL(c.url).host;
        } catch {
          host = c.url;
        }
        const description = c.description || `Open ${host}`;
        const Icon = iconForTemplate(c.templateId);
        return (
          <div
            key={c.key}
            className="card bg-base-200 shadow-sm h-full relative overflow-hidden"
          >
            <Icon
              size={170}
              className="absolute -right-6 -bottom-8 text-base-content opacity-[0.07] pointer-events-none"
            />
            <div className="card-body relative p-4 gap-2">
              <h2 className="card-title text-base truncate" title={c.label}>
                {c.label}
              </h2>
              <p className="text-[12px] text-base-content/75 leading-snug">
                {description}
              </p>
              <div
                className="text-[10px] mono truncate text-base-content/55"
                title={c.url}
              >
                {host}
              </div>
              <div className="card-actions justify-end mt-auto">
                <FocusButton
                  className="btn btn-sm btn-primary"
                  onClick={() => onOpen(c.url)}
                  ariaLabel={`Open ${c.label}`}
                >
                  <FaArrowUpRightFromSquare className="mr-1.5" /> Open
                </FocusButton>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QuickLinksLandingPage({
  storage,
  showBanner,
  onOpenSettings,
}: {
  storage: QuickLinksStorage;
  showBanner: boolean;
  onOpenSettings: () => void;
}) {
  const currentGame = useCurrentGame();
  const launch = useLinkLauncher(storage.selectedBrowserId);

  if (!currentGame) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          {showBanner && <NoBrowserBanner onOpenSettings={onOpenSettings} />}
          <div className="card">
            <div className="card-body p-6 flex flex-col items-center text-center gap-3">
              <FaLink className="w-6 h-6 text-base-content/40" />
              <div className="text-sm text-base-content/70">
                No game running — start a game to see contextual links.
              </div>
              <FocusButton
                className="btn btn-sm btn-primary"
                onClick={onOpenSettings}
                ariaLabel="Open Quick Links settings"
              >
                <FaGear className="mr-1.5" /> Open Settings
              </FocusButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const appId = currentGame.appId;
  const gameName = currentGame.gameName || `App ${appId}`;
  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {showBanner && <NoBrowserBanner onOpenSettings={onOpenSettings} />}
        <LandingCardGrid
          storage={storage}
          appId={appId}
          gameName={gameName}
          onOpen={(url) => void launch(url)}
        />
      </div>
    </div>
  );
}

// ─── Top-level panel: header + view router ───────────────────────────

function QuickLinksPanel() {
  const { call, useEvent } = useBackend("quick-links");
  const currentGame = useCurrentGame();
  const [storage, setStorage] = useState<QuickLinksStorage | null>(null);
  const [view, setView] = useState<"landing" | "settings">("landing");
  const [inGamingMode, setInGamingMode] = useState(false);
  const [newTpl, setNewTpl] = useState({
    name: "",
    urlTemplate: "",
  });

  useEffect(() => {
    void call("getState").then((s) =>
      setStorage(s as QuickLinksStorage),
    );
    void call("isGamingMode").then((v) => setInGamingMode(v === true));
  }, [call]);

  useEvent({
    event: "stateChanged",
    handler: (data) => setStorage(data as QuickLinksStorage),
  });

  const update = useCallback(
    async (id: string, patch: Partial<LinkTemplate>) => {
      await call("updateTemplate", id, patch);
    },
    [call],
  );

  const remove = useCallback(
    async (id: string) => {
      await call("deleteTemplate", id);
    },
    [call],
  );

  const unhide = useCallback(
    async (id: string) => {
      await call("unhideTemplate", id);
    },
    [call],
  );

  const setSuffixes = useCallback(
    async (group: string, suffixes: string[]) => {
      await call("setSuffixes", group, suffixes);
    },
    [call],
  );

  const setPins = useCallback(
    async (appId: number, ids: string[]) => {
      await call("setPinnedTemplateIds", String(appId), ids);
    },
    [call],
  );

  const addLink = useCallback(
    async (appId: number, link: { name: string; url: string }) => {
      await call("addCustomLink", String(appId), link);
    },
    [call],
  );

  const removeLink = useCallback(
    async (appId: number, index: number) => {
      await call("removeCustomLink", String(appId), index);
    },
    [call],
  );

  const installBrowser = useCallback(
    async (browserId: string) => {
      await call("installBrowserShortcut", browserId);
    },
    [call],
  );

  const uninstallBrowser = useCallback(
    async (browserId: string) => {
      await call("uninstallBrowserShortcut", browserId);
    },
    [call],
  );

  const addCustom = useCallback(async () => {
    if (!newTpl.name.trim() || !newTpl.urlTemplate.trim()) return;
    await call("addCustomTemplate", {
      id: `custom-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      name: newTpl.name.trim(),
      urlTemplate: newTpl.urlTemplate.trim(),
      enabled: true,
    });
    setNewTpl({ name: "", urlTemplate: "" });
  }, [call, newTpl]);

  const visibleTemplates = useMemo(
    () =>
      storage
        ? storage.templates.filter((t) => !storage.hidden.includes(t.id))
        : [],
    [storage],
  );
  const hiddenTemplates = useMemo(
    () =>
      storage
        ? storage.templates.filter((t) => storage.hidden.includes(t.id))
        : [],
    [storage],
  );

  // Banner gating: only nag in Gaming Mode, only when no
  // Chrome/Firefox shortcut is registered. Keeps the banner out of
  // the way for the much larger group of users who use Quick Links
  // in desktop mode.
  const hasChromeOrFirefox = useMemo(
    () =>
      (storage?.installedBrowsers ?? []).some(
        (s) =>
          s.browserId.includes("firefox") ||
          s.browserId.includes("librewolf") ||
          s.browserId.includes("chrome"),
      ),
    [storage],
  );
  const showBanner =
    storage !== null && inGamingMode && !hasChromeOrFirefox && view === "landing";

  // Shared header: title + dynamic running-game subtitle, cog on
  // landing, HeaderBackButton on settings. Mirrors the convention
  // every other plugin uses (see protondb-badges/app.tsx).
  const subtitle = currentGame
    ? `running: ${currentGame.gameName || `App ${currentGame.appId}`}`
    : "idle — start a game for contextual links";
  const header = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Quick Links
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {view === "settings" ? (
            <HeaderBackButton
              onBack={() => setView("landing")}
              title="Back to Quick Links"
            />
          ) : (
            <IconButton
              onClick={() => setView("settings")}
              title="Quick Links settings"
              ariaLabel="Quick Links settings"
            >
              <FaGear size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </PluginHeader>
  );

  if (!storage) {
    return (
      <>
        {header}
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
      </>
    );
  }

  if (view === "landing") {
    return (
      <>
        {header}
        <QuickLinksLandingPage
          storage={storage}
          showBanner={showBanner}
          onOpenSettings={() => setView("settings")}
        />
      </>
    );
  }

  // Settings view — auto-open the browser installer card when the
  // user has no shortcut installed AND we're in Gaming Mode, so the
  // landing-page banner's "Open settings" CTA lands them on the
  // action they need rather than a collapsed Add button.
  const hasInstalled = storage.installedBrowsers.length > 0;
  const installerStartExpanded = !hasInstalled;

  return (
    <>
      {header}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content space-y-4">
          <BrowserShortcutCard
            storage={storage}
            startExpanded={installerStartExpanded}
            onChangeSelected={(id) => void call("setSelectedBrowserId", id)}
            onInstall={installBrowser}
            onUninstall={uninstallBrowser}
          />

        <div className="card">
          <div className="card-body p-4.5">
            <div className="flex items-start justify-between gap-3 mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <FaLink className="w-4 h-4 shrink-0 text-base-content/60" />
                <div className="subsection-label mb-0 truncate">
                  Quick Links
                </div>
              </div>
              <FocusButton
                className="btn btn-sm btn-ghost"
                onClick={() => void call("resetToDefaults")}
                title="Reset all templates and suffixes"
              >
                Reset
              </FocusButton>
            </div>
            <div className="subsection-desc">
              Templates render as chips on the home widget while a game
              is running. Use placeholders like{" "}
              <span className="mono">{"{name}"}</span> (game title) and{" "}
              <span className="mono">{"{appId}"}</span> (Steam app id) in
              the URL.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body p-4.5">
            <div className="subsection-label mb-2">Templates</div>
            <div className="flex flex-col gap-2">
              {visibleTemplates.map((t) => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  hidden={false}
                  storage={storage}
                  onUpdate={(patch) => update(t.id, patch)}
                  onDelete={() => remove(t.id)}
                  onUnhide={() => unhide(t.id)}
                />
              ))}
              {hiddenTemplates.length > 0 && (
                <>
                  <div className="text-[11px] uppercase tracking-wider text-base-content/45 mt-2">
                    Hidden
                  </div>
                  {hiddenTemplates.map((t) => (
                    <TemplateRow
                      key={t.id}
                      template={t}
                      hidden
                      storage={storage}
                      onUpdate={(patch) => update(t.id, patch)}
                      onDelete={() => remove(t.id)}
                      onUnhide={() => unhide(t.id)}
                    />
                  ))}
                </>
              )}
            </div>

            <div className="border-t border-base-300/40 mt-4 pt-3">
              <div className="text-sm font-medium mb-2">
                Add custom template
              </div>
              <div className="flex flex-col gap-2">
                <TextInput
                  value={newTpl.name}
                  onChange={(name) =>
                    setNewTpl((d) => ({ ...d, name }))
                  }
                  placeholder="Display name"
                />
                <TextInput
                  value={newTpl.urlTemplate}
                  onChange={(urlTemplate) =>
                    setNewTpl((d) => ({ ...d, urlTemplate }))
                  }
                  placeholder="URL template"
                />
                <FocusButton
                  className="btn btn-sm btn-primary self-start"
                  disabled={!newTpl.name.trim() || !newTpl.urlTemplate.trim()}
                  onClick={() => void addCustom()}
                >
                  <FaPlus className="mr-1" /> Add
                </FocusButton>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body p-4.5">
            <div className="subsection-label mb-2">Suffix groups</div>
            <div className="flex flex-col gap-2">
              {Object.entries(storage.suffixes).map(([group, suffixes]) => (
                <SuffixGroupEditor
                  key={group}
                  group={group}
                  suffixes={suffixes}
                  onChange={(next) => setSuffixes(group, next)}
                />
              ))}
            </div>
          </div>
        </div>

        {currentGame && (
          <div className="card">
            <div className="card-body p-4.5">
              <PerGameCard
                storage={storage}
                appId={currentGame.appId}
                gameName={currentGame.gameName || `App ${currentGame.appId}`}
                onSetPins={(ids) => setPins(currentGame.appId, ids)}
                onAddLink={(link) => addLink(currentGame.appId, link)}
                onRemoveLink={(i) => removeLink(currentGame.appId, i)}
              />
            </div>
          </div>
        )}
        </div>
      </div>
    </>
  );
}

// ─── Mounts ──────────────────────────────────────────────────────────

export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider
      parentFocusKey={opts?.parentFocusKey}
      headerSlot={opts?.headerSlot ?? null}
    >
      <QuickLinksPanel />
    </PluginProvider>,
  );
  return () => root.unmount();
}

export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider
      parentFocusKey={opts?.parentFocusKey}
      headerSlot={opts?.headerSlot ?? null}
    >
      <QuickLinksHomeWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * loader to allocate a header slot for this plugin; the actual
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * it stays in the same React tree as the body and shares state
 * (current view, current game, etc.) without prop-drilling across
 * mount boundaries.
 */
export function mountHeader(): () => void {
  return () => {};
}
