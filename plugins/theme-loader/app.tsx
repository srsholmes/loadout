import { Fragment, useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  FaArrowsRotate,
  FaPalette,
} from "react-icons/fa6";
import {
  Badge,
  Button,
  HeaderBackButton,
  IconButton,
  notify,
  Panel,
  PluginHeader,
  PluginProvider,
  SearchField,
  SegmentedItem,
  Select,
  Spinner,
  Text,
  Toggle,
  useBackend,
  useFocusable,
  useIntersectionGate,
} from "@loadout/ui";

export const icon = FaPalette;

type Tab = "themes" | "community";

interface ThemeListEntry {
  id: string;
  name: string;
  kind: "pack";
  active: boolean;
  thumbnailUrl?: string | null;
  patches?: Record<string, { default: string; type?: string; values: string[] }>;
  variants?: Record<string, string>;
  meta?: {
    author: string | null;
    description: string | null;
    version: string | null;
    sourceUrl: string | null;
    license: { fileName: string; content: string } | null;
  } | null;
}

interface CommunityThemeEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  downloadBlobId: string;
  githubRepo: string | null;
  githubUrl: string | null;
  thumbnailUrl: string | null;
  downloadCount: number;
  starCount: number;
  updated: string;
  target: string;
  installed: boolean;
}

interface StatusInfo {
  connected: boolean;
  tabCount: number;
  activeThemeCount: number;
}

interface TranslationsStatus {
  state: "pending" | "ready" | "error";
  syncedAt: number | null;
  entryCount: number;
  lastError: string | null;
}

interface StateEvent {
  connected: boolean;
  activeThemes: string[];
  translations?: TranslationsStatus;
}

type SortOption = "downloads" | "updated" | "stars" | "name";

// ---------------------------------------------------------------------------
// CommunityCard — thumbnail + metadata + install/uninstall button
// ---------------------------------------------------------------------------

function CommunityCard({
  entry,
  installing,
  uninstalling,
  onInstall,
  onUninstall,
  onViewGithub,
}: {
  entry: CommunityThemeEntry;
  installing: boolean;
  uninstalling: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onViewGithub: () => void;
}) {
  const busy = installing || uninstalling;
  // Lazy-load the thumbnail when the card scrolls near-view —
  // a long list of themes would otherwise blow through deckthemes'
  // CDN bandwidth (and our CEF cache) on mount.
  const [inView, imgRef] = useIntersectionGate<HTMLDivElement>();

  // Thumbnails are hotlinked from the upstream deckthemes CDN. The CEF
  // webview loads them directly (no caching, no rebundling on our
  // side); deckthemes' Cloudflare CDN handles delivery.
  const thumbUrl = entry.thumbnailUrl;

  return (
    <div
      className={`flex flex-col rounded-lg overflow-hidden border transition-colors ${
        entry.installed
          ? "border-success/40 bg-success/5"
          : "border-base-300 bg-base-200/60"
      }`}
    >
      <div
        ref={imgRef}
        className="aspect-video bg-base-300 overflow-hidden flex items-center justify-center"
      >
        {inView && thumbUrl ? (
          <img
            src={thumbUrl}
            alt={entry.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-base-300 to-base-200" />
        )}
      </div>
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm truncate">{entry.name}</span>
              {entry.installed && <Badge variant="success">Installed</Badge>}
            </div>
            <div className="text-xs text-base-content/60">by {entry.author}</div>
          </div>
        </div>
        {entry.description && (
          <div className="text-xs text-base-content/70 line-clamp-3">
            {entry.description}
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-auto pt-1">
          {entry.installed ? (
            <Button onClick={onUninstall} disabled={busy}>
              {uninstalling ? "Removing..." : "Uninstall"}
            </Button>
          ) : (
            <Button variant="primary" onClick={onInstall} disabled={busy}>
              {installing ? "Installing..." : "Install"}
            </Button>
          )}
          {entry.githubUrl && (
            <Button onClick={onViewGithub} disabled={busy}>
              GitHub
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommunityTab — search + sort + grid of CommunityCard
// ---------------------------------------------------------------------------

function CommunityTab({
  call,
  onThemesChanged,
  query,
}: {
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  onThemesChanged: () => void;
  /**
   * Search query lifted to the parent — the header (which lives in a
   * `<PluginHeader>` portal) owns the input, and we filter against
   * its value here.
   */
  query: string;
}) {
  const [entries, setEntries] = useState<CommunityThemeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOption>("downloads");

  const refresh = useCallback(async () => {
    try {
      const res = (await call("listCommunityThemes")) as CommunityThemeEntry[];
      setEntries(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleInstall = useCallback(
    async (id: string) => {
      setInstalling(id);
      setError(null);
      try {
        const result = (await call("installCommunityTheme", id)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Install failed");
        } else {
          await refresh();
          onThemesChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInstalling(null);
      }
    },
    [call, refresh, onThemesChanged],
  );

  const handleUninstall = useCallback(
    async (id: string) => {
      setUninstalling(id);
      setError(null);
      try {
        const result = (await call("uninstallCommunityTheme", id)) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          setError(result.error ?? "Uninstall failed");
        } else {
          await refresh();
          onThemesChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUninstalling(null);
      }
    },
    [call, refresh, onThemesChanged],
  );

  const handleViewGithub = useCallback(
    async (id: string) => {
      try {
        await call("openThemeGithub", id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [call],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = entries;
    if (q) {
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.author.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    switch (sort) {
      case "downloads":
        sorted.sort((a, b) => b.downloadCount - a.downloadCount);
        break;
      case "stars":
        sorted.sort((a, b) => b.starCount - a.starCount);
        break;
      case "updated":
        sorted.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return sorted;
  }, [entries, query, sort]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="bg-error/20 border border-error rounded-lg p-3">
          <Text variant="body" style={{ color: "oklch(var(--er))", margin: 0 }}>
            {error}
          </Text>
        </div>
      )}
      <div className="text-xs text-base-content/55">
        Theme metadata is fetched live from{" "}
        <a
          href="https://deckthemes.com"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          deckthemes.com
        </a>
        . Themes are authored, hosted, and curated by the DeckThemes
        community — we just plug into their public API.
      </div>
      <Panel title={`Community Themes (${filtered.length} of ${entries.length})`}>
        <div className="flex flex-wrap items-center justify-end gap-3 mb-4">
          <Select
            value={sort}
            options={[
              { value: "downloads", label: "Most Popular" },
              { value: "stars", label: "Most Starred" },
              { value: "updated", label: "Recently Updated" },
              { value: "name", label: "Name (A-Z)" },
            ]}
            onChange={(v) => setSort(v as SortOption)}
          />
        </div>

        {filtered.length === 0 ? (
          <Text variant="secondary">No themes match your search.</Text>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {filtered.map((entry) => (
              <CommunityCard
                key={entry.id}
                entry={entry}
                installing={installing === entry.id}
                uninstalling={uninstalling === entry.id}
                onInstall={() => handleInstall(entry.id)}
                onUninstall={() => handleUninstall(entry.id)}
                onViewGithub={() => handleViewGithub(entry.id)}
              />
            ))}
          </div>
        )}
      </Panel>
      <div className="text-center text-xs text-base-content/40 pb-2 flex flex-wrap justify-center gap-x-2 gap-y-1">
        <span>Themes from the</span>
        <a
          href="https://deckthemes.com"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          DeckThemes
        </a>
        <span>community · powered by</span>
        <a
          href="https://github.com/DeckThemes/SDH-CssLoader"
          target="_blank"
          rel="noopener noreferrer"
          className="link"
        >
          SDH-CssLoader
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ThemeLoader component
// ---------------------------------------------------------------------------

function ThemeLoader() {
  const { call, useEvent } = useBackend("theme-loader");

  const [activeTab, setActiveTab] = useState<Tab>("themes");
  const [themes, setThemes] = useState<ThemeListEntry[]>([]);
  const [, setStatus] = useState<StatusInfo | null>(null);
  const [translations, setTranslations] = useState<TranslationsStatus | null>(null);
  const [refreshingTranslations, setRefreshingTranslations] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** IDs of themes whose options panel is currently expanded inline. */
  const [expandedThemes, setExpandedThemes] = useState<Set<string>>(new Set());
  /**
   * Community-tab search query. Lifted out of `CommunityTab` so the
   * header (rendered into the shell topbar via `<PluginHeader>`) and
   * the community grid body can share state — same component scope,
   * no cross-root plumbing. Cleared automatically when leaving the
   * tab via the back arrow.
   */
  const [communityQuery, setCommunityQuery] = useState("");

  const toggleThemeExpanded = useCallback((id: string) => {
    setExpandedThemes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refreshThemes = useCallback(async () => {
    const updated = (await call("getThemes")) as ThemeListEntry[];
    setThemes(updated);
  }, [call]);

  // Listen for real-time state changes from the backend
  useEvent({
    event: "stateChanged",
    handler: (data) => {
      const state = data as StateEvent;
      setThemes((prev) =>
        prev.map((t) => ({
          ...t,
          active: state.activeThemes.includes(t.id),
        })),
      );
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              connected: state.connected,
              activeThemeCount: state.activeThemes.length,
            }
          : null,
      );
      if (state.translations) setTranslations(state.translations);
    },
  });

  useEvent({
    event: "themesChanged",
    handler: () => {
      refreshThemes();
    },
  });

  useEffect(() => {
    refreshThemes();
    call("getStatus").then((result) => setStatus(result as StatusInfo));
    call("getTranslationStatus")
      .then((result) => setTranslations(result as TranslationsStatus))
      .catch(() => { /* legacy backend */ });
  }, [call, refreshThemes]);

  const handleRefreshTranslations = useCallback(async () => {
    setRefreshingTranslations(true);
    try {
      const next = (await call("refreshTranslationCache")) as TranslationsStatus;
      setTranslations(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingTranslations(false);
    }
  }, [call]);

  const handleToggleTheme = useCallback(
    async (id: string, currentlyActive: boolean) => {
      setLoading(id);
      setError(null);
      try {
        const result = currentlyActive
          ? ((await call("disableTheme", id)) as { success: boolean; error?: string })
          : ((await call("enableTheme", id)) as { success: boolean; error?: string });
        if (!result.success) {
          setError(result.error || "Failed to toggle theme");
        }
        await refreshThemes();
      } catch (err) {
        setError(String(err));
      }
      setLoading(null);
    },
    [call, refreshThemes],
  );

  const handleReconnect = useCallback(async () => {
    setLoading("reconnect");
    setError(null);
    try {
      const result = (await call("reconnect")) as { success: boolean; error?: string };
      if (!result.success) {
        const msg = result.error || "Failed to reapply themes";
        notify(msg, { kind: "error" });
        setError(msg);
      } else {
        notify("Themes reapplied", { kind: "success" });
      }
      const newStatus = (await call("getStatus")) as StatusInfo;
      setStatus(newStatus);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(msg, { kind: "error" });
      setError(msg);
    }
    setLoading(null);
  }, [call]);

  const handleSetVariant = useCallback(
    async (id: string, patchName: string, value: string) => {
      try {
        await call("setThemePackVariant", id, patchName, value);
        await refreshThemes();
      } catch (err) {
        setError(String(err));
      }
    },
    [call, refreshThemes],
  );

  // Dynamic topbar header. Same React tree as the body — the
  // `activeTab` toggle, `communityQuery`, and Reapply callback are
  // shared by closure. Renders into the overlay shell's reserved
  // 60px topbar slot via `<PluginHeader>`. On the Themes view the
  // segmented `[Themes | Community]` toggle + Reapply button sit
  // here; on the Community drill-in those swap for a search input
  // and a back arrow that returns to Themes.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Theme Loader
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            Inject CSS into Steam Big Picture
          </span>
        </div>

        {activeTab === "themes" && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="segmented flex">
              <SegmentedItem
                active={activeTab === "themes"}
                onSelect={() => setActiveTab("themes")}
              >
                Themes
              </SegmentedItem>
              <SegmentedItem
                active={(activeTab as Tab) === "community"}
                onSelect={() => setActiveTab("community")}
              >
                Community
              </SegmentedItem>
            </div>
            <IconButton
              onClick={handleReconnect}
              disabled={
                loading === "reconnect" || !themes.some((t) => t.active)
              }
              title={loading === "reconnect" ? "Reapplying themes…" : "Reapply themes"}
              ariaLabel="Reapply themes"
            >
              <FaArrowsRotate
                size={11}
                className={loading === "reconnect" ? "animate-spin" : ""}
              />
            </IconButton>
          </div>
        )}

        {activeTab === "community" && (
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={communityQuery}
              onChange={setCommunityQuery}
              onClear={() => setCommunityQuery("")}
              placeholder="Search by name, author, description…"
              width={280}
            />
            <HeaderBackButton
              onBack={() => {
                setCommunityQuery("");
                setActiveTab("themes");
              }}
              title="Back to themes"
            />
          </div>
        )}
      </div>
    </PluginHeader>
  );

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {error && (
          <div className="card">
            <div className="card-body p-4.5">
              <div className="subsection-label mb-1.5" style={{ color: "var(--color-error)" }}>Error</div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
        )}

        {/* Tab Content */}
        {activeTab === "themes" && (
          <Panel title="Themes">
            {translations && translations.state !== "ready" && (
              <div className="mb-3 p-2 rounded bg-base-300/40 flex items-center gap-2 text-xs">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    translations.state === "pending"
                      ? "bg-warning animate-pulse"
                      : "bg-error"
                  }`}
                />
                <span className="flex-1">
                  {translations.state === "pending"
                    ? "Syncing community theme support…"
                    : `Offline — community themes can't apply (${translations.lastError ?? "no network"}).`}
                </span>
                <Button
                  onClick={handleRefreshTranslations}
                  disabled={refreshingTranslations}
                >
                  {refreshingTranslations ? "Retrying…" : "Retry"}
                </Button>
              </div>
            )}
            {themes.length === 0 ? (
              <Text variant="secondary">
                No themes installed. Browse the Community tab to add some.
              </Text>
            ) : (
              themes.map((theme) => {
                const hasOptions =
                  theme.patches && Object.keys(theme.patches).length > 0;
                const meta = theme.meta;
                const blockedByTranslations =
                  !theme.active &&
                  translations !== null &&
                  translations.state !== "ready";
                const licenseLabel = meta
                  ? meta.license
                    ? `License: ${meta.license.fileName}`
                    : "License: not declared"
                  : null;
                const isExpanded = expandedThemes.has(theme.id);
                return (
                  <div
                    key={theme.id}
                    className="py-3 border-b border-base-300/50 last:border-b-0"
                  >
                    <div className="flex justify-between items-center gap-3 min-h-[48px]">
                      {hasOptions ? (
                        <ThemeRowToggle
                          isExpanded={isExpanded}
                          onToggle={() => toggleThemeExpanded(theme.id)}
                          ariaControls={`theme-options-${theme.id}`}
                        >
                          <span
                            className={`mt-1 inline-block transition-transform shrink-0 text-base-content/50 text-xs ${
                              isExpanded ? "rotate-90" : ""
                            }`}
                            aria-hidden
                          >
                            ▶
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="flex items-center gap-2 flex-wrap">
                              <Text variant="body" style={{ margin: 0, fontWeight: 500 }}>
                                {theme.name}
                              </Text>
                              <Badge variant="accent">Community</Badge>
                              <Badge variant="neutral">
                                {Object.keys(theme.patches!).length} options
                              </Badge>
                            </span>
                            {meta && (meta.author || licenseLabel || meta.sourceUrl) && (
                              <span className="block text-xs text-base-content/60 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                                {meta.author && <span>by {meta.author}</span>}
                                {licenseLabel && <span>{licenseLabel}</span>}
                                {meta.sourceUrl && (
                                  <SourceLink
                                    onClick={() =>
                                      call("openThemeGithub", theme.id)
                                    }
                                  />
                                )}
                              </span>
                            )}
                          </span>
                        </ThemeRowToggle>
                      ) : (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Text variant="body" style={{ margin: 0, fontWeight: 500 }}>
                              {theme.name}
                            </Text>
                            <Badge variant="accent">Community</Badge>
                          </div>
                          {meta && (meta.author || licenseLabel || meta.sourceUrl) && (
                            <div className="text-xs text-base-content/60 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                              {meta.author && <span>by {meta.author}</span>}
                              {licenseLabel && <span>{licenseLabel}</span>}
                              {meta.sourceUrl && (
                                <SourceLink
                                  onClick={() => call("openThemeGithub", theme.id)}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex items-center shrink-0">
                        <Toggle
                          checked={theme.active}
                          onChange={() => handleToggleTheme(theme.id, theme.active)}
                          disabled={loading === theme.id || blockedByTranslations}
                        />
                      </div>
                    </div>

                    {hasOptions && isExpanded && (
                      <div
                        id={`theme-options-${theme.id}`}
                        className="mt-3 ml-5 pl-3 border-l-2 border-base-300/60"
                      >
                        <div className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-3 items-center">
                          {Object.entries(theme.patches!).map(([name, patch]) => (
                            <Fragment key={name}>
                              <span className="text-sm text-base-content/80">
                                {name}
                              </span>
                              <Select
                                value={theme.variants?.[name] ?? patch.default}
                                options={patch.values.map((v) => ({
                                  value: v,
                                  label: v,
                                }))}
                                onChange={(v) =>
                                  handleSetVariant(theme.id, name, v)
                                }
                                style={{ display: "block", width: "100%" }}
                                className="w-full"
                              />
                            </Fragment>
                          ))}
                        </div>
                        {!theme.active && (
                          <Text variant="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                            Enable this theme to apply these options.
                          </Text>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </Panel>
        )}

        {activeTab === "community" && (
          <CommunityTab
            call={call}
            onThemesChanged={refreshThemes}
            query={communityQuery}
          />
        )}

      </div>
      </div>
    </>
  );
}

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
/**
 * Whole-row expand toggle for community themes that have configurable
 * options. Wraps the existing big-row clickable layout with `useFocusable`
 * so the d-pad reaches it.
 */
function ThemeRowToggle({
  isExpanded,
  onToggle,
  ariaControls,
  children,
}: {
  isExpanded: boolean;
  onToggle: () => void;
  ariaControls: string;
  children: ReactNode;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onToggle });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-controls={ariaControls}
      className={
        "flex-1 min-w-0 text-left flex items-start gap-2 cursor-pointer rounded transition-all" +
        (focused ? " ring-2 ring-[var(--accent)]" : "")
      }
    >
      {children}
    </button>
  );
}

function SourceLink({ onClick }: { onClick: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onClick });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={"link text-xs" + (focused ? " ring-2 ring-[var(--accent)] rounded" : "")}
    >
      source
    </button>
  );
}

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
      <ThemeLoader />
    </PluginProvider>
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot for this plugin
 * (`usePluginHasHeader` probes for the export). The actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` in
 * @loadout/ui — same React tree as the body, so `activeTab`
 * and `communityQuery` are shared without any cross-root pub/sub.
 */
export function mountHeader(): () => void {
  return () => {};
}
