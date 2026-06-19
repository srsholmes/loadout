import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import GridLayout, { type LayoutItem } from "react-grid-layout/legacy";
import type { PluginInfo } from "../hooks/usePlugins";
import { HomeWidgetHost } from "./HomeWidgetHost";
import { WidgetPicker } from "./WidgetPicker";
import { NowPlaying } from "@loadout/ui";
import { useFocusable, FocusContext } from "./GamepadNav";
import { useConfigValue, isUserConfigLoaded } from "../lib/userConfig";

// --- Default widgets for new users ---
const DEFAULT_FAVORITES = [
  "tdp-control",
  "fan-control",
  "lsfg-vk",
  "audio-mixer",
  "playtime",
  "protondb-badges",
  "hltb",
  "display-settings",
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "tdp-control", x: 0, y: 0, w: 6, h: 5, minW: 3, minH: 3 },
  { i: "fan-control", x: 6, y: 0, w: 6, h: 5, minW: 3, minH: 3 },
  { i: "lsfg-vk", x: 0, y: 5, w: 6, h: 4, minW: 3, minH: 2 },
  { i: "audio-mixer", x: 6, y: 5, w: 6, h: 4, minW: 3, minH: 2 },
  { i: "playtime", x: 0, y: 9, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "protondb-badges", x: 4, y: 9, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "hltb", x: 8, y: 9, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "display-settings", x: 0, y: 12, w: 6, h: 4, minW: 3, minH: 2 },
];

// --- Component ---

interface HomepageProps {
  plugins: PluginInfo[];
  // Edit-layout and widget-picker chrome lives in the shell topbar
  // (App.tsx owns the state so it can render the buttons up there);
  // Homepage reacts to the flags but doesn't own them.
  isEditing: boolean;
  pickerOpen: boolean;
  onClosePicker: () => void;
}

// Note: there's no `onOpenPlugin` prop. The home surface is
// intentionally glanceable-only — widgets don't navigate to their
// plugin page on press (see `HomeWidgetHost.tsx` and the
// homepage-widgets-inert feedback memo). The sidebar is the only
// path to a plugin's main view.
export function Homepage({
  plugins,
  isEditing,
  pickerOpen,
  onClosePicker,
}: HomepageProps) {
  // Back both state keys with the persisted user config. On a fresh
  // install the CEF cache is empty so the synchronous read returns
  // defaults; when `loadUserConfig()` finishes and fires the change
  // event, `useConfigValue` resyncs both values to the real saved
  // layout/favorites.
  const [favorites, setFavorites] = useConfigValue<string[]>(
    "homeWidgets",
    DEFAULT_FAVORITES,
  );
  const [layout, setLayout] = useConfigValue<LayoutItem[]>(
    "homeLayout",
    DEFAULT_LAYOUT,
  );
  const [showNowPlaying, setShowNowPlaying] = useConfigValue<boolean>(
    "homeShowNowPlaying",
    true,
  );
  // Draft layout kept live while the user is dragging/resizing in edit
  // mode. We don't persist every RGL onLayoutChange — the gesture
  // fires dozens of events and we'd hammer the config file — we snap
  // the final layout back to disk when the user exits edit mode.
  const [draftLayout, setDraftLayout] = useState<LayoutItem[] | null>(null);
  const prevEditingRef = useRef(isEditing);
  const [gridWidth, setGridWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (w: number) => {
      setGridWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    };
    update(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { ref: gridFocusRef, focusKey: gridFocusKey } = useFocusable({
    focusKey: "homepage-grid",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Enter/exit edit mode:
  // - on enter, snapshot the current saved layout into a draft
  // - on exit, commit the draft to disk (one PATCH per edit session)
  useEffect(() => {
    if (!prevEditingRef.current && isEditing) {
      setDraftLayout([...layout]);
    }
    if (prevEditingRef.current && !isEditing) {
      if (draftLayout) {
        setLayout(draftLayout);
      }
      setDraftLayout(null);
    }
    prevEditingRef.current = isEditing;
    // We only want this to run when isEditing flips; `layout`/`draftLayout`
    // are intentionally read as latest values without re-triggering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Sync layout with favorites — ensure every favorite has a layout entry.
  // Writes to the draft while editing (so the in-progress gesture isn't
  // clobbered by an immediate PATCH); writes to persisted config otherwise.
  useEffect(() => {
    if (!isUserConfigLoaded()) return;
    const base = draftLayout ?? layout;
    const existing = new Set(base.map((l) => l.i));
    const added: LayoutItem[] = [];
    for (const id of favorites) {
      if (!existing.has(id)) {
        const maxY = base.reduce((max, l) => Math.max(max, l.y + l.h), 0);
        added.push({ i: id, x: 0, y: maxY, w: 6, h: 4, minW: 3, minH: 2 });
      }
    }
    const filtered = base.filter((l) => favorites.includes(l.i));
    if (added.length === 0 && filtered.length === base.length) return;
    const next = [...filtered, ...added];
    if (draftLayout) {
      setDraftLayout(next);
    } else {
      setLayout(next);
    }
  }, [favorites, layout, draftLayout, setLayout]);

  const handleLayoutChange = useCallback(
    (newLayout: readonly LayoutItem[]) => {
      // While editing, buffer the layout locally — the commit happens on
      // edit-mode exit. Outside edit mode RGL still fires this for its
      // mount-time normalization; those passes are either identical to
      // the saved layout (no-op once loaded) or come from a mount before
      // loadUserConfig resolved, in which case we skip so the saved file
      // doesn't get stomped by DEFAULT_LAYOUT.
      if (prevEditingRef.current) {
        setDraftLayout([...newLayout]);
        return;
      }
      if (!isUserConfigLoaded()) return;
      setLayout([...newLayout]);
    },
    [setLayout],
  );

  const handleToggleFavorite = useCallback(
    (pluginId: string) => {
      const next = favorites.includes(pluginId)
        ? favorites.filter((id) => id !== pluginId)
        : [...favorites, pluginId];
      setFavorites(next);
    },
    [favorites, setFavorites],
  );

  const handleRemoveWidget = useCallback(
    (pluginId: string) => {
      setFavorites(favorites.filter((id) => id !== pluginId));
    },
    [favorites, setFavorites],
  );

  // WidthProvider listens to window resize; nudge it to re-measure after the
  // container's ring/rounded classes toggle so the grid doesn't lock onto a
  // stale width.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(id);
  }, [isEditing]);

  // Build a map for quick plugin lookup
  const pluginMap = new Map(plugins.map((p) => [p.id, p]));

  // Filter layout to only include favorites that exist as plugins. Use
  // the draft while editing so drags/resizes are visually live; fall
  // back to the persisted value the rest of the time.
  const activeLayout = (draftLayout ?? layout).filter(
    (l) => favorites.includes(l.i) && pluginMap.has(l.i),
  );

  const isEmpty = favorites.length === 0;

  return (
    <div data-scroll-root="true" className="h-full overflow-y-auto p-6" style={{ scrollbarGutter: "stable" }}>
      <div className="max-w-5xl mx-auto">
        {showNowPlaying && <NowPlaying />}
        {/* Empty state — the page title and Edit Layout / Add Widget
            buttons live in the shell topbar; the Home view starts with
            just its content, no duplicate heading row. */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-base-300/50 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-base-content/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4z" />
              </svg>
            </div>
            <p className="text-base-content/40 text-sm">
              No widgets on your homepage yet. Tap <span className="text-base-content/70">Add Widget</span> in the top bar.
            </p>
          </div>
        )}

        {/* Widget grid */}
        {!isEmpty && (
          <FocusContext.Provider value={gridFocusKey}>
            <div ref={gridFocusRef}>
              <div
                ref={containerRef}
                className={isEditing ? "ring-2 ring-primary/20 ring-offset-4 ring-offset-base-100 rounded-xl" : ""}
              >
                {gridWidth > 0 && (
                <GridLayout
                  className="layout"
                  width={gridWidth}
                  layout={activeLayout}
                  cols={12}
                  rowHeight={40}
                  isDraggable={isEditing}
                  isResizable={isEditing}
                  onLayoutChange={(newLayout) => handleLayoutChange(newLayout)}
                  draggableHandle=".widget-drag-handle"
                  compactType="vertical"
                  margin={[16, 16]}
                >
                  {activeLayout.map((item) => {
                    const plugin = pluginMap.get(item.i);
                    if (!plugin) return null;
                    return (
                      <div key={item.i}>
                        {isEditing && (
                          <div className="widget-drag-handle absolute top-0 left-0 right-0 h-[44px] cursor-grab z-10" />
                        )}
                        <HomeWidgetHost
                          pluginId={plugin.id}
                          pluginName={plugin.name}
                          isEditing={isEditing}
                          onRemove={() => handleRemoveWidget(plugin.id)}
                        />
                      </div>
                    );
                  })}
                </GridLayout>
                )}
              </div>
            </div>
          </FocusContext.Provider>
        )}

        {/* Edit mode hint */}
        {isEditing && (
          <div className="flex justify-center mt-4">
            <div className="flex gap-4 text-xs text-base-content/30">
              <span>Drag widgets to rearrange</span>
              <span>Resize from edges</span>
            </div>
          </div>
        )}
      </div>

      {/* Widget picker modal — opened from the shell topbar button */}
      {pickerOpen && (
        <WidgetPicker
          plugins={plugins}
          favorites={favorites}
          onToggle={handleToggleFavorite}
          showNowPlaying={showNowPlaying}
          onToggleNowPlaying={() => setShowNowPlaying(!showNowPlaying)}
          onClose={onClosePicker}
        />
      )}
    </div>
  );
}
