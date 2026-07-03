import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginInfo } from "../hooks/usePlugins";
import { usePluginIcons } from "../hooks/usePluginIcons";
import { OVERLAY_VERSION } from "../version";
import { useFavorites } from "../hooks/useFavorites";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useFocusable, FocusContext, Focusable, setFocus } from "./GamepadNav";
import { useScrollFade } from "../hooks/useScrollFade";
import { useCurrentGame, Spinner } from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import { FaGear } from "react-icons/fa6";

const HOME_FOCUS_KEY = "sidebar-home";
/** Focus key for the new sidebar Settings row (issue #135). Distinct
 *  from the footer cog's `"sidebar-settings"` so the two focusables
 *  don't collide — both navigate to the same /settings route but
 *  live in different parts of the focus tree. */
const SETTINGS_ROW_FOCUS_KEY = "sidebar-settings-row";
const LAST_PLUGIN_FOCUS_KEY = "sidebar-last-plugin";

export interface SidebarProps {
  plugins: PluginInfo[];
  activePluginId: string | null;
  onSelectPlugin: (id: string) => void;
  loading: boolean;
  showHome: boolean;
  onSelectHome: () => void;
  /** Set to true when the overlay's route is `/settings` — drives
   *  the Settings row's active styling. Mirrors `showHome`. */
  showSettings: boolean;
  onSelectSettings: () => void;
  onToggleSidebar: () => void;
}

/**
 * Sidebar content rendered inside a DaisyUI `drawer-side`. The parent
 * drawer controls width via `is-drawer-close:w-14` / `is-drawer-open:w-64`
 * and we hide labels / the favorite toggle with `is-drawer-close:hidden`.
 *
 * The internal collapse button and logo moved out to the navbar — this
 * component only renders the menu (Home, plugin list, Settings).
 */
export function Sidebar({
  plugins,
  activePluginId,
  onSelectPlugin,
  loading,
  showHome,
  onSelectHome,
  showSettings,
  onSelectSettings,
  onToggleSidebar,
}: SidebarProps) {
  const { ref: navRef, focusKey } = useFocusable({
    focusKey: "sidebar",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const { favorites, toggle: toggleFavorite } = useFavorites();
  const currentGame = useCurrentGame();
  const homeLabel =
    currentGame?.gameName?.trim() || (currentGame ? `App ${currentGame.appId}` : "Home");
  const homeTooltip = currentGame ? `Now playing: ${homeLabel}` : "Home";
  const homeCapsuleSrc = currentGame ? steamArtworkUrls(currentGame.appId).capsule : null;

  // Group plugins by their manifest category (first-seen order). If
  // any plugins are favorited, they also surface in a "Favorites"
  // pseudo-section at the top so the star indicator isn't the only
  // way to find them. Plugins without a category fall into "Plugins".
  const sections = useMemo<{ name: string; items: PluginInfo[] }[]>(() => {
    const favSet = new Set(favorites);
    const order: string[] = [];
    const bucket: Record<string, PluginInfo[]> = {};
    for (const p of plugins) {
      const cat = p.category?.trim() || "Plugins";
      if (!bucket[cat]) {
        bucket[cat] = [];
        order.push(cat);
      }
      bucket[cat].push(p);
    }
    const result = order.map((name) => ({ name, items: bucket[name] }));
    if (favSet.size > 0) {
      const favPlugins = favorites
        .map((id) => plugins.find((p) => p.id === id))
        .filter((p): p is PluginInfo => Boolean(p));
      if (favPlugins.length > 0) {
        result.unshift({ name: "Favorites", items: favPlugins });
      }
    }
    return result;
  }, [plugins, favorites]);

  // Flat list used for the active-indicator lookup and icon loading.
  const flatPlugins = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const pluginIcons = usePluginIcons(flatPlugins);

  const listRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState(0);
  const [indicatorVisible, setIndicatorVisible] = useState(false);

  useEffect(() => {
    if (!activePluginId || !listRef.current) {
      setIndicatorVisible(false);
      return;
    }
    const el = listRef.current.querySelector(
      `[data-plugin-id="${CSS.escape(activePluginId)}"]`,
    ) as HTMLElement | null;
    if (el) {
      setIndicatorTop(el.offsetTop);
      setIndicatorVisible(true);
    }
  }, [activePluginId, flatPlugins]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={navRef}
        className="flex h-full max-h-full flex-col bg-base-200 border-r border-base-300/50 is-drawer-close:w-14 is-drawer-open:w-64 transition-[width] duration-200 ease-out"
      >
        {/* Fixed top: collapse toggle + logo (logo text only visible when open).
            Using a button + React state instead of a `<label htmlFor>` — the
            native label semantics move DOM focus to the hidden drawer-toggle
            checkbox, which knocks norigin-spatial-navigation out of sync and
            freezes d-pad navigation until the next overlay toggle. */}
        <div className="shrink-0 flex items-center gap-2 is-drawer-close:px-1.5 is-drawer-open:px-3 py-3 border-b border-base-300/40">
          <Focusable focusKey="sidebar-toggle" onActivate={onToggleSidebar}>
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              title="Toggle sidebar"
              data-tip="Toggle sidebar"
              tabIndex={-1}
              className="btn btn-square btn-ghost btn-sm shrink-0 is-drawer-close:tooltip is-drawer-close:tooltip-right"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeWidth={2}
                fill="none"
                stroke="currentColor"
                className="inline-block size-4"
              >
                <path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" />
                <path d="M9 4v16" />
                <path d="M14 10l2 2l-2 2" />
              </svg>
            </button>
          </Focusable>
          <div className="is-drawer-close:hidden flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-[11px] font-extrabold text-white shadow-sm shrink-0">
              SL
            </div>
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-sm font-bold truncate">Loadout</span>
              <span className="text-[10px] text-base-content/40">v{OVERLAY_VERSION}</span>
            </div>
          </div>
        </div>

        {/* Scrollable plugin list — Home + plugins sit here and scroll.
            `overscroll-behavior: contain` stops a wheel/touch scroll that
            reaches this container's bounds from bubbling up to any
            ancestor — without it, scroll chaining through the drawer
            can drag the main plugin view around when the sidebar scrolls
            past its end. */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto is-drawer-close:px-1.5 is-drawer-open:px-3 py-2 scroll-fade"
          style={{ overscrollBehavior: "contain" }}
        >
          <div className="mb-1">
            <Focusable focusKey={HOME_FOCUS_KEY} onActivate={onSelectHome}>
              <SidebarRow
                onClick={onSelectHome}
                active={showHome}
                tooltip={homeTooltip}
                icon={
                  homeCapsuleSrc ? (
                    <HomeCapsuleIcon src={homeCapsuleSrc} alt={homeLabel} />
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                      />
                    </svg>
                  )
                }
                label={homeLabel}
              />
            </Focusable>
          </div>

          <div className="border-t border-base-300/30 mx-2 mb-1 is-drawer-close:mx-1" />

          {loading && plugins.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Spinner variant="dots" size="md" />
            </div>
          )}

          <div ref={listRef} className="relative flex flex-col">
            {/* Active indicator bar (hidden when collapsed — the row's bg is enough) */}
            <div
              className="absolute left-0 w-1 rounded-r-full bg-primary transition-all duration-200 ease-out is-drawer-close:hidden"
              style={{ top: indicatorTop + 8, height: 32, opacity: indicatorVisible ? 1 : 0 }}
            />
            {(() => {
              // Flatten for last-item detection (driving d-pad down → Settings).
              let seen = 0;
              const total = flatPlugins.length;
              return sections.map((section) => (
                <div key={section.name} className="mb-2">
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-base-content/40 is-drawer-close:hidden">
                    {section.name}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {section.items.map((plugin) => {
                      const isActive = plugin.id === activePluginId;
                      seen += 1;
                      const isLast = seen === total;
                      const isFavorite = favorites.includes(plugin.id);
                      const IconComp = pluginIcons[plugin.id];
                      const rowFocusKey = isLast
                        ? LAST_PLUGIN_FOCUS_KEY
                        : `sidebar-plugin-${section.name}-${plugin.id}`;
                      return (
                        <Focusable
                          key={`${section.name}-${plugin.id}`}
                          focusKey={rowFocusKey}
                          onActivate={() => onSelectPlugin(plugin.id)}
                        >
                          <div className="relative group/row">
                            <SidebarRow
                              data-plugin-id={plugin.id}
                              onClick={() => {
                                setFocus(rowFocusKey);
                                onSelectPlugin(plugin.id);
                              }}
                              active={isActive}
                              tooltip={plugin.name}
                              icon={
                                IconComp ? (
                                  <IconComp
                                    className="max-w-[18px] max-h-[18px] w-[18px] h-[18px]"
                                    aria-hidden
                                  />
                                ) : (
                                  <span>{(plugin.icon ?? plugin.name)[0].toUpperCase()}</span>
                                )
                              }
                              label={plugin.name}
                              trailingPad
                            />
                            <FavoriteToggle
                              favorited={isFavorite}
                              onToggle={(e) => {
                                e.stopPropagation();
                                toggleFavorite(plugin.id);
                              }}
                            />
                          </div>
                        </Focusable>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>

        {/* Settings entry — pinned at the bottom of the sidebar
            below a thin separator. Mirrors the prior shape that
            was removed at some point and that we're now restoring
            per issue #135. The footer cog stays as a touch / muscle-
            memory affordance, but this row is the d-pad-native path
            from any plugin: scroll past the list, hit Settings.

            Lives outside the scroll-fade so a long plugin list never
            scrolls Settings off-screen — the BPM-style fixed
            placement. */}
        <div className="border-t border-base-300/30 mx-2 is-drawer-close:mx-1" />
        <div className="is-drawer-close:px-1.5 is-drawer-open:px-3 py-2 shrink-0">
          <Focusable focusKey={SETTINGS_ROW_FOCUS_KEY} onActivate={onSelectSettings}>
            <SidebarRow
              onClick={onSelectSettings}
              active={showSettings}
              tooltip="Settings"
              icon={<FaGear className="w-4 h-4" aria-hidden />}
              label="Settings"
            />
          </Focusable>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/**
 * One menu row. Icon + label; label auto-hides when the drawer is
 * collapsed. Tooltip on hover in the collapsed state (via DaisyUI's
 * `is-drawer-close:tooltip` variant).
 */
function SidebarRow({
  onClick,
  active,
  icon,
  label,
  tooltip,
  trailingPad,
  ...rest
}: {
  onClick: () => void;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  tooltip: string;
  trailingPad?: boolean;
  "data-plugin-id"?: string;
}) {
  return (
    <button
      onClick={onClick}
      tabIndex={-1}
      data-tip={tooltip}
      className={`w-full flex items-center gap-3 rounded-xl text-left transition-colors min-h-[44px] is-drawer-close:justify-center is-drawer-close:px-0 is-drawer-close:tooltip is-drawer-close:tooltip-right is-drawer-open:px-3 ${trailingPad ? "is-drawer-open:pr-8" : ""} py-2.5 ${
        active
          ? "bg-primary/15 text-primary"
          : "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
      }`}
      {...rest}
    >
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden ${
          active ? "bg-primary text-primary-content" : "bg-base-300/70 text-base-content/50"
        }`}
      >
        {icon}
      </div>
      <span className="is-drawer-close:hidden text-sm font-medium truncate flex-1">{label}</span>
    </button>
  );
}

function HomeCapsuleIcon({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  // Without this reset the running game's previous-tile failed-flag
  // sticks across game switches: a no-art shortcut → Steam app would
  // keep showing the play-arrow placeholder forever. Same SGDB-mid-
  // session limitation as NowPlaying — `src` is stable across an
  // SGDB apply for the current game, so the new art only appears on
  // next game switch / overlay reopen.
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="w-4 h-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
      </svg>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Trailing star toggle. Always visible when favorited; on non-favorites,
 * reveals on group hover or when the spatial-nav focus lands on the
 * surrounding row (group-focus-within). Hidden entirely in the collapsed
 * drawer state via `is-drawer-close:hidden`.
 */
function FavoriteToggle({
  favorited,
  onToggle,
}: {
  favorited: boolean;
  onToggle: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
      title={favorited ? "Remove from favorites" : "Add to favorites"}
      tabIndex={-1}
      className={`is-drawer-close:hidden absolute top-1/2 right-1.5 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center transition-opacity ${
        favorited
          ? "text-warning opacity-90 hover:opacity-100"
          : "text-base-content/50 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-warning"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        fill={favorited ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={favorited ? 0 : 2}
        strokeLinejoin="round"
        className="w-3.5 h-3.5"
      >
        <path d="M12 2.5l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7L2 9.7l7.1-.6L12 2.5z" />
      </svg>
    </button>
  );
}
