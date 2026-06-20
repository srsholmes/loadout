import { useState, useEffect, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  FaCheck,
  FaGear,
  FaPenToSquare,
  FaPlus,
  FaTerminal,
  FaTrash,
  FaXmark,
} from "react-icons/fa6";

export { FaTerminal as icon } from "react-icons/fa6";
import {
  Badge,
  Button,
  collectionBadgeVariant,
  friendlyCollectionName,
  fuzzySearchGames,
  GameCard,
  GameCardGrid,
  HeaderBackButton,
  IconButton,
  PluginHeader,
  PluginProvider,
  SearchField,
  Select,
  Spinner,
  TextInput,
  useBackend,
  useCurrentGame,
} from "@loadout/ui";
import type { GameInfo, GameCollection } from "@loadout/types";

// ───── Types ─────

interface GameLaunchOptions {
  appId: string;
  launchOptions: string;
}

interface Preset {
  name: string;
  options: string;
}

const ALL_COLLECTIONS = "__all__";
const STEAM_ONLY = "__steam_only__";

/**
 * Plugin-internal sub-route. Three values:
 *   - "list"    : the cover-art library grid (entry point).
 *   - "detail"  : the per-game launch-options editor + preset chips,
 *                 reached by clicking / selecting a card.
 *   - "presets" : the global preset CRUD (reached via the gear icon
 *                 in the header on the list view).
 *
 * Each view portrays its own `<PluginHeader>` content — the dynamic
 * title / subtitle / back button toggle on this state. We deliberately
 * don't drive the shell route (it doesn't have a per-plugin sub-route
 * model); same pattern HLTB / SGDB / ProtonDB use for their nested
 * settings flows.
 */
type View = "list" | "detail" | "presets";

// ───── Main component ─────

function LaunchOptionsManager() {
  const launchOptionsBackend = useBackend("launch-options");
  const gameLibraryBackend = useBackend("__core:game-library");
  const currentGame = useCurrentGame();
  const { call } = launchOptionsBackend;

  // Library + per-game launch options
  const [library, setLibrary] = useState<GameInfo[]>([]);
  const [collections, setCollections] = useState<GameCollection[]>([]);
  const [launchOptsByApp, setLaunchOptsByApp] = useState<Map<string, string>>(
    new Map(),
  );
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  // Internal sub-route. `selectedAppId` is the appId for the detail
  // view; we keep them as two pieces of state so the back button can
  // reset the view without clearing which game we *would* show next.
  const [view, setView] = useState<View>("list");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  // Header search + collection filter, owned here so the dynamic
  // header can drive them. List view only — the detail view header
  // hides them.
  const [searchQuery, setSearchQuery] = useState("");
  // Default to Steam-only — most users open this to set launch
  // options on real Steam apps (PROTON_*, gamemoderun, MangoHud).
  // Heroic / Lutris / emulator shortcuts use their own launchers
  // and ignore Steam's launch-options field. The "All games" entry
  // stays in the dropdown.
  const [collectionFilter, setCollectionFilter] = useState<string>(STEAM_ONLY);

  // Inline edit state for the detail view's launch command.
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  // Preset CRUD inline form (presets view).
  const [newPresetName, setNewPresetName] = useState("");
  const [newPresetOptions, setNewPresetOptions] = useState("");
  const [showAddPreset, setShowAddPreset] = useState(false);

  const [saving, setSaving] = useState(false);

  // Defensive dedupe — __core:game-library dedupes already (single
  // source of truth), but a stale client could double-render cards
  // otherwise.
  const refresh = useCallback(async () => {
    try {
      const [games, withLO, cols, p] = await Promise.all([
        gameLibraryBackend.call("getGames").catch(() => []) as Promise<GameInfo[]>,
        call("getGames").catch(() => []) as Promise<GameLaunchOptions[]>,
        gameLibraryBackend.call("getCollections").catch(() => []) as Promise<GameCollection[]>,
        call("getPresets").catch(() => []) as Promise<Preset[]>,
      ]);
      const dedup: GameInfo[] = [];
      const seen = new Set<string>();
      for (const g of Array.isArray(games) ? games : []) {
        if (seen.has(g.appId)) continue;
        seen.add(g.appId);
        dedup.push(g);
      }
      setLibrary(dedup);
      setCollections(Array.isArray(cols) ? cols : []);
      const map = new Map<string, string>();
      for (const g of withLO) map.set(g.appId, g.launchOptions);
      setLaunchOptsByApp(map);
      setPresets(p);
    } catch (err) {
      console.error("[launch-options] Failed to refresh:", err);
    } finally {
      setLoading(false);
    }
  }, [call, gameLibraryBackend]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedGame = useMemo(
    () => library.find((g) => g.appId === selectedAppId) ?? null,
    [library, selectedAppId],
  );
  const selectedLaunchOpts = selectedAppId
    ? (launchOptsByApp.get(selectedAppId) ?? "")
    : "";

  // Filter the library: collection → fuzzy search → float running game to top.
  // Fuzzy search matches against name + collection tags, same helper
  // every other card-grid plugin (HLTB / SGDB / ProtonDB) uses so a
  // search for "Mario" lands consistently across plugins.
  const visibleLibrary = useMemo(() => {
    let list = library;
    if (collectionFilter === STEAM_ONLY) {
      list = list.filter((g) => g.source === "steam");
    } else if (collectionFilter !== ALL_COLLECTIONS) {
      list = list.filter((g) => g.tags?.includes(collectionFilter));
    }
    list = fuzzySearchGames(list, searchQuery);
    if (!currentGame) return list;
    const runningId = String(currentGame.appId);
    const idx = list.findIndex((g) => g.appId === runningId);
    if (idx <= 0) return list;
    return [list[idx], ...list.slice(0, idx), ...list.slice(idx + 1)];
  }, [library, collectionFilter, searchQuery, currentGame]);

  const collectionOptions = useMemo(() => {
    const total = library.length;
    const steamCount = library.filter((g) => g.source === "steam").length;
    const opts = [
      { value: ALL_COLLECTIONS, label: `All games${total ? ` (${total})` : ""}` },
      { value: STEAM_ONLY, label: `Steam games only (${steamCount})` },
    ];
    for (const c of collections) {
      opts.push({ value: c.id, label: `${c.id} (${c.count})` });
    }
    return opts;
  }, [collections, library]);

  // ─── Navigation handlers ───

  /**
   * Card click / d-pad Enter on a tile → enter the detail view for
   * that game. Resets any in-progress edit from a previous detail
   * session so the user always lands on the "view" (not "edit")
   * state of the new game.
   */
  const handleSelect = useCallback((appId: string) => {
    setSelectedAppId(appId);
    setEditing(false);
    setEditValue("");
    setView("detail");
  }, []);

  /** Back button on the detail header → return to the card grid. */
  const handleBackToList = useCallback(() => {
    setView("list");
    setEditing(false);
    setEditValue("");
  }, []);

  // ─── Edit handlers (detail view) ───

  const handleStartEdit = useCallback(() => {
    if (!selectedAppId) return;
    setEditing(true);
    setEditValue(selectedLaunchOpts);
  }, [selectedAppId, selectedLaunchOpts]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setEditValue("");
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!selectedAppId) return;
    setSaving(true);
    try {
      await call("setLaunchOptions", selectedAppId, editValue);
      // Backend wrote to localconfig.vdf / shortcuts.vdf — re-pull the
      // canonical list so the library Map agrees with disk. Local
      // map-mutation was racing the back-navigation render in practice
      // (the Configured pill went missing after editing a game that
      // started with no options); refetch keeps the source of truth
      // simple.
      await refresh();
      setEditing(false);
      setEditValue("");
    } catch (err) {
      console.error("[launch-options] Failed to save:", err);
    } finally {
      setSaving(false);
    }
  }, [selectedAppId, editValue, call, refresh]);

  const handleClearOptions = useCallback(async () => {
    if (!selectedAppId) return;
    setSaving(true);
    try {
      await call("setLaunchOptions", selectedAppId, "");
      await refresh();
    } catch (err) {
      console.error("[launch-options] Failed to clear:", err);
    } finally {
      setSaving(false);
    }
  }, [selectedAppId, call, refresh]);

  const handleAppendPreset = useCallback(
    async (preset: Preset) => {
      if (!selectedAppId) return;
      // Append onto whatever the user can currently see — `editValue`
      // when they're mid-edit, the committed value otherwise. Without
      // this branch a preset click in edit mode would silently
      // discard the in-progress text AND leave the input still
      // showing it, so the field looked unchanged even though the
      // backend got a different value.
      const baseline = (editing ? editValue : selectedLaunchOpts).trim();
      const next = baseline
        ? `${baseline} ${preset.options}`.trim()
        : preset.options;
      // Update the controlled input immediately so the user sees the
      // preset land — the backend write + refresh below races
      // React's edit-mode rendering and would otherwise lag a beat.
      if (editing) setEditValue(next);
      setSaving(true);
      try {
        await call("setLaunchOptions", selectedAppId, next);
        await refresh();
      } catch (err) {
        console.error("[launch-options] Failed to append preset:", err);
      } finally {
        setSaving(false);
      }
    },
    [selectedAppId, editing, editValue, selectedLaunchOpts, call, refresh],
  );

  // ─── Preset CRUD ───

  const handleSavePreset = useCallback(async () => {
    if (!newPresetName.trim() || !newPresetOptions.trim()) return;
    setSaving(true);
    try {
      await call("savePreset", newPresetName.trim(), newPresetOptions.trim());
      setNewPresetName("");
      setNewPresetOptions("");
      setShowAddPreset(false);
      const p = (await call("getPresets")) as Preset[];
      setPresets(p);
    } catch (err) {
      console.error("[launch-options] Failed to save preset:", err);
    } finally {
      setSaving(false);
    }
  }, [newPresetName, newPresetOptions, call]);

  const handleDeletePreset = useCallback(
    async (name: string) => {
      setSaving(true);
      try {
        await call("deletePreset", name);
        const p = (await call("getPresets")) as Preset[];
        setPresets(p);
      } catch (err) {
        console.error("[launch-options] Failed to delete preset:", err);
      } finally {
        setSaving(false);
      }
    },
    [call],
  );

  // ─── Dynamic header ───
  //
  // Three header layouts share one PluginHeader portal:
  //
  //   - list     : title "Launch Options", subtitle = library count
  //                + filter copy. Search + collection select +
  //                gear-toggle to the presets view on the right.
  //   - detail   : title "Launch Options", subtitle = the selected
  //                game's name. <HeaderBackButton> on the right.
  //   - presets  : title "Launch Options", subtitle "Manage presets".
  //                <HeaderBackButton> on the right.

  const subtitle = (() => {
    if (loading) return "Reading library…";
    if (view === "presets") return "Manage presets";
    if (view === "detail" && selectedGame) return selectedGame.name;
    if (library.length === 0) return "No installed games found";
    const total = library.length;
    const shown = visibleLibrary.length;
    return searchQuery.trim() && shown !== total
      ? `${shown} of ${total} games`
      : `${total} games`;
  })();

  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Launch Options
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {view === "list" && (
            <>
              <SearchField
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={() => setSearchQuery("")}
                placeholder="Search library…"
                width={220}
              />
              <div style={{ minWidth: 180 }}>
                <Select
                  value={collectionFilter}
                  onChange={setCollectionFilter}
                  options={collectionOptions}
                />
              </div>
              <IconButton
                onClick={() => setView("presets")}
                title="Manage presets"
                ariaLabel="Manage presets"
              >
                <FaGear size={11} />
              </IconButton>
            </>
          )}
          {view === "detail" && (
            <HeaderBackButton
              onBack={handleBackToList}
              title="Back to library"
            />
          )}
          {view === "presets" && (
            <HeaderBackButton
              onBack={() => setView("list")}
              title="Back to library"
            />
          )}
        </div>
      </div>
    </PluginHeader>
  );

  if (loading) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="flex items-center justify-center h-64">
              <Spinner size={32} />
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Presets view (gear icon → manage presets) ───
  if (view === "presets") {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content full">
            <div className="card">
              <div className="subsection">
                <div className="flex items-center justify-between mb-2">
                  <div className="subsection-label m-0">Presets</div>
                  {!showAddPreset && (
                    <Button onClick={() => setShowAddPreset(true)}>
                      <FaPlus size={10} className="mr-1.5" /> New preset
                    </Button>
                  )}
                </div>

                {showAddPreset && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      padding: 10,
                      marginBottom: 10,
                      background: "var(--bg-inset)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                    }}
                  >
                    <TextInput
                      placeholder="Preset name"
                      value={newPresetName}
                      onChange={setNewPresetName}
                      className="bg-[var(--bg-2)] border border-[var(--line)] outline-none rounded-md px-2.5 py-1.5 text-[13px] text-[var(--fg-1)]"
                    />
                    <TextInput
                      placeholder="Launch options (e.g. mangohud %command%)"
                      value={newPresetOptions}
                      onChange={setNewPresetOptions}
                      className="bg-[var(--bg-2)] border border-[var(--line)] outline-none rounded-md px-2.5 py-1.5 text-[13px] text-[var(--fg-1)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                    <div className="flex gap-1.5">
                      <Button
                        variant="primary"
                        onClick={handleSavePreset}
                        disabled={saving || !newPresetName.trim() || !newPresetOptions.trim()}
                      >
                        Save preset
                      </Button>
                      <Button
                        onClick={() => {
                          setShowAddPreset(false);
                          setNewPresetName("");
                          setNewPresetOptions("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {presets.length === 0 ? (
                  <div className="subsection-desc mt-1">
                    No presets saved yet. Common ones: <span className="mono">mangohud %command%</span>,
                    {" "}<span className="mono">gamemoderun %command%</span>,
                    {" "}<span className="mono">PROTON_USE_WINED3D=1 %command%</span>.
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    {presets.map((p) => (
                      <div
                        key={p.name}
                        className="flex items-center gap-3 p-2.5 bg-[var(--bg-inset)] rounded-lg border border-[var(--line)]"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold truncate">{p.name}</div>
                          <div className="mono text-[10.5px] text-[var(--fg-3)] truncate">
                            {p.options}
                          </div>
                        </div>
                        <IconButton
                          onClick={() => handleDeletePreset(p.name)}
                          disabled={saving}
                          title="Delete preset"
                          ariaLabel={`Delete preset ${p.name}`}
                          variant="danger"
                        >
                          <FaTrash size={11} />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Detail view (per-game launch options + preset chips) ───
  //
  // Reached by clicking a card on the list view. If the user somehow
  // hits this state without a valid selection (shouldn't be possible
  // via the UI, but defensive against state-replay or test errors)
  // we fall back to the list.
  if (view === "detail" && selectedGame) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="card">
              <div className="subsection">
                <div className="flex items-center gap-2 mb-2">
                  <div className="subsection-label m-0 flex-1 min-w-0">
                    Launch command
                  </div>
                  <span className="mono text-[11px] text-[var(--fg-3)]">
                    AppID {selectedGame.appId}
                  </span>
                </div>
                {editing ? (
                  <div
                    style={{
                      padding: 10,
                      background: "var(--bg-inset)",
                      borderRadius: 10,
                      border: "1px solid var(--line)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <TextInput
                      value={editValue}
                      onChange={setEditValue}
                      autoFocus
                      placeholder="e.g. mangohud %command%"
                      className="bg-[var(--bg-2)] border border-[var(--line)] outline-none rounded-md px-2.5 py-2 text-[13px] text-[var(--fg-1)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                    <div className="flex gap-1.5">
                      <Button variant="primary" onClick={handleSaveEdit} disabled={saving}>
                        <FaCheck size={10} className="mr-1.5" /> Save
                      </Button>
                      <Button onClick={handleCancelEdit} disabled={saving}>
                        <FaXmark size={10} className="mr-1.5" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-2.5 px-3 py-3.5 rounded-[10px] border border-[var(--line)] bg-[var(--bg-inset)]"
                    style={{ minHeight: 60 }}
                  >
                    <FaTerminal size={14} className="text-[var(--fg-3)] shrink-0" />
                    <span
                      className="mono flex-1"
                      style={{ fontSize: 12.5, color: "var(--fg-1)", wordBreak: "break-all" }}
                    >
                      {selectedLaunchOpts || (
                        <span style={{ color: "var(--fg-3)" }}>(empty)</span>
                      )}
                    </span>
                    <IconButton
                      onClick={handleStartEdit}
                      title="Edit"
                      ariaLabel="Edit launch options"
                      className="bg-transparent"
                    >
                      <FaPenToSquare size={12} />
                    </IconButton>
                    {selectedLaunchOpts && (
                      <IconButton
                        onClick={handleClearOptions}
                        disabled={saving}
                        title="Clear"
                        ariaLabel="Clear launch options"
                        variant="danger"
                        className="bg-transparent"
                      >
                        <FaTrash size={12} />
                      </IconButton>
                    )}
                  </div>
                )}
              </div>

              {/* Append preset — pulls saved presets from the presets view */}
              {presets.length > 0 && (
                <div className="subsection">
                  <div className="subsection-label">Append preset</div>
                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((p) => (
                      <Button
                        key={p.name}
                        size="sm"
                        variant="accent"
                        onClick={() => handleAppendPreset(p)}
                        disabled={saving}
                      >
                        <FaPlus size={9} className="mr-1" /> {p.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── List view (default): cover-art grid ───
  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content full">
          {/* Library picker — portrait `<GameCard>` grid, sitting flush
              like the SGDB / ProtonDB / HLTB pickers. Each tile is the
              artwork; an "Options →" affordance opens the detail view. */}
          {visibleLibrary.length === 0 ? (
            <div className="subsection-desc mt-1">
              {library.length === 0
                ? "No installed games found. Library data comes from __core:game-library — the loader's single source of truth."
                : "No games match the current filter."}
            </div>
          ) : (
            <GameCardGrid>
              {visibleLibrary.map((game) => {
                const lo = launchOptsByApp.get(game.appId) ?? "";
                const isCurrent =
                  currentGame !== null &&
                  String(currentGame.appId) === game.appId;
                return (
                  <LaunchOptionsCard
                    key={game.appId}
                    game={game}
                    launchOpts={lo}
                    isCurrent={isCurrent}
                    onPick={() => handleSelect(game.appId)}
                  />
                );
              })}
            </GameCardGrid>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Library tile ───

/**
 * One tile in the launch-options library grid. Backed by the shared
 * `<GameCard>` so the picker matches HLTB / SGDB / ProtonDB visually.
 *
 * Per issue #85, the *whole card* is the click target: tapping the
 * artwork or selecting it via the d-pad opens the per-game options
 * detail view. We also render an "Options →" affordance below the
 * title so mouse users get an explicit "this is a button" signal
 * without nesting a real `<button>` inside the card's outer button
 * (which would be invalid HTML — see LSFG-VK where the action button
 * is the *only* interactive surface). The pill is decorative; the
 * card's own `onPick` handles every interaction path.
 *
 * The top-left "RUNNING" chip and the overlay "Configured" pill let
 * the user spot the currently-playing game and any games that
 * already have launch options without opening each tile.
 */
function LaunchOptionsCard({
  game,
  launchOpts,
  isCurrent,
  onPick,
}: {
  game: GameInfo;
  launchOpts: string;
  isCurrent: boolean;
  onPick: () => void;
}) {
  return (
    <GameCard
      imageUrl={game.capsuleUrl}
      fallbackImageUrl={game.headerUrl}
      title={game.name}
      onPick={onPick}
      highlighted={isCurrent}
      topLeftBadge={
        isCurrent ? (
          <span className="chip chip-accent">RUNNING</span>
        ) : undefined
      }
      overlayBadges={
        // Compose the Configured pill + the first user-collection badge
        // into the shared bottom-of-image slot. `overlayBadges` short-
        // circuits the auto-`collections` render in GameCard, so we
        // re-render the first tag here using the same shared helpers
        // (`collectionBadgeVariant` + `friendlyCollectionName`) the
        // auto-path uses — that keeps the badge hue stable across
        // SGDB / LSFG-VK / HLTB / Launch-Options. SGDB's logic is the
        // reference; see plugins/steamgriddb/app.tsx:995.
        launchOpts || (game.tags && game.tags.length > 0) ? (
          // Each pill gets a solid `--bg-inset` backdrop so the soft
          // tint (chip-accent + badge-soft are both translucent) stays
          // legible over bright artwork. Mirrors the same treatment in
          // GameCard's auto-collections render so every plugin's tiles
          // look consistent.
          <>
            {launchOpts ? (
              <span
                className="chip chip-accent truncate max-w-full"
                title={launchOpts}
                style={{ background: "var(--bg-inset)" }}
              >
                <FaTerminal size={9} className="mr-1" />
                Configured
              </span>
            ) : null}
            {game.tags && game.tags[0] ? (
              <span
                title={game.tags[0]}
                className="max-w-full inline-flex rounded-full"
                style={{ background: "var(--bg-inset)" }}
              >
                <Badge
                  variant={collectionBadgeVariant(game.tags[0])}
                  size="xs"
                  className="max-w-full truncate min-w-0"
                >
                  {friendlyCollectionName(game.tags[0])}
                </Badge>
              </span>
            ) : null}
          </>
        ) : undefined
      }
      subtitle={
        <span className="inline-flex items-center gap-1 font-semibold text-[var(--accent)]">
          Options <span aria-hidden>→</span>
        </span>
      }
    />
  );
}

// ─── Mounts ───

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
      <LaunchOptionsManager />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>`.
 */
export function mountHeader(): () => void {
  return () => {};
}
