import { FaPlus, FaTrash } from "react-icons/fa6";
import {
  Button,
  friendlyCollectionName,
  IconButton,
  SegmentedItem,
  Select,
  TextInput,
  Toggle,
  useFocusable,
} from "@loadout/ui";
import type { GameCollection } from "@loadout/types";
import type {
  Comparison,
  Filter,
  FilterType,
  MatchMode,
  SortMode,
  Tab,
} from "../lib/types";
import { newId } from "./shared";

const FILTER_LABELS: Record<FilterType, string> = {
  collection: "Collection / tag",
  regex: "Title",
  platform: "Platform",
  size: "Size on disk",
  whitelist: "Whitelist (pick games)",
  blacklist: "Blacklist (exclude games)",
  merge: "Merge (nested group)",
};

const FILTER_TYPES = Object.keys(FILTER_LABELS) as FilterType[];

const SORT_LABELS: Record<SortMode, string> = {
  alpha: "Alphabetical",
  sizeDesc: "Size (largest first)",
  sizeAsc: "Size (smallest first)",
  recent: "Recently played",
  manual: "Manual (whitelist order)",
};
const SORT_MODES = Object.keys(SORT_LABELS) as SortMode[];

/** Build a fresh filter of a given type with sensible defaults. */
export function makeFilter(type: FilterType): Filter {
  const id = newId("filter");
  switch (type) {
    case "collection":
      return { id, type, params: { collections: [], mode: "or" } };
    case "regex":
      return { id, type, params: { pattern: "" } };
    case "platform":
      return { id, type, params: { platform: "steam" } };
    case "size":
      return { id, type, params: { gb: 10, comparison: "above" } };
    case "whitelist":
      return { id, type, params: { appIds: [] } };
    case "blacklist":
      return { id, type, params: { appIds: [] } };
    case "merge":
      return { id, type, params: { mode: "or", filters: [] } };
  }
}

// ── Small building blocks ────────────────────────────────────────────

function ModePicker({
  mode,
  onChange,
}: {
  mode: MatchMode;
  onChange: (m: MatchMode) => void;
}) {
  return (
    <div className="segmented" style={{ maxWidth: 220 }}>
      <SegmentedItem active={mode === "and"} onSelect={() => onChange("and")} style={{ flex: 1 }}>
        Match all
      </SegmentedItem>
      <SegmentedItem active={mode === "or"} onSelect={() => onChange("or")} style={{ flex: 1 }}>
        Match any
      </SegmentedItem>
    </div>
  );
}

function CollectionChips({
  collections,
  selected,
  onToggle,
}: {
  collections: GameCollection[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (collections.length === 0) {
    return (
      <div className="text-[11px] text-[var(--fg-3)] italic">
        No collections or tags found in your library.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
      {collections.map((c) => (
        <SegmentedItem
          key={c.id}
          active={selected.includes(c.id)}
          onSelect={() => onToggle(c.id)}
          className="rounded-full"
          style={{ fontSize: 11, padding: "4px 10px" }}
        >
          {friendlyCollectionName(c.id)} ({c.count})
        </SegmentedItem>
      ))}
    </div>
  );
}

// ── Per-filter editor ────────────────────────────────────────────────

function FilterBody({
  filter,
  collections,
  onChange,
  onEditGameList,
  depth,
}: {
  filter: Filter;
  collections: GameCollection[];
  onChange: (f: Filter) => void;
  onEditGameList: (filterId: string) => void;
  depth: number;
}) {
  switch (filter.type) {
    case "collection": {
      const { collections: sel, mode } = filter.params;
      return (
        <div className="flex flex-col gap-2">
          <ModePicker
            mode={mode}
            onChange={(m) => onChange({ ...filter, params: { ...filter.params, mode: m } })}
          />
          <CollectionChips
            collections={collections}
            selected={sel}
            onToggle={(id) => {
              const next = sel.includes(id)
                ? sel.filter((x) => x !== id)
                : [...sel, id];
              onChange({ ...filter, params: { ...filter.params, collections: next } });
            }}
          />
        </div>
      );
    }
    case "regex":
      return (
        <TextInput
          value={filter.params.pattern}
          onChange={(pattern) => onChange({ ...filter, params: { pattern } })}
          placeholder="Title contains… (or a /regex/)"
        />
      );
    case "platform": {
      const options = [
        { value: "steam", label: "Steam games" },
        { value: "nonSteam", label: "Non-Steam / emulator" },
        ...collections.map((c) => ({
          value: c.id,
          label: `Tag: ${friendlyCollectionName(c.id)}`,
        })),
      ];
      return (
        <Select
          value={filter.params.platform}
          onChange={(platform) => onChange({ ...filter, params: { platform } })}
          options={options}
        />
      );
    }
    case "size":
      return (
        <div className="flex items-center gap-2">
          <div className="segmented" style={{ maxWidth: 170 }}>
            {(["above", "below"] as Comparison[]).map((c) => (
              <SegmentedItem
                key={c}
                active={filter.params.comparison === c}
                onSelect={() => onChange({ ...filter, params: { ...filter.params, comparison: c } })}
                style={{ flex: 1 }}
              >
                {c === "above" ? "Larger than" : "Smaller than"}
              </SegmentedItem>
            ))}
          </div>
          <div style={{ width: 90 }}>
            <TextInput
              value={String(filter.params.gb)}
              inputMode="decimal"
              onChange={(v) => {
                const gb = Number(v.replace(/[^0-9.]/g, "")) || 0;
                onChange({ ...filter, params: { ...filter.params, gb } });
              }}
            />
          </div>
          <span className="text-[12px] text-[var(--fg-3)]">GB</span>
        </div>
      );
    case "whitelist":
    case "blacklist":
      return (
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-[var(--fg-2)]">
            {filter.params.appIds.length} game
            {filter.params.appIds.length === 1 ? "" : "s"} selected
          </span>
          <Button size="sm" variant="neutral" onClick={() => onEditGameList(filter.id)}>
            Choose games…
          </Button>
        </div>
      );
    case "merge":
      return (
        <MergeEditor
          filter={filter}
          collections={collections}
          onChange={onChange}
          onEditGameList={onEditGameList}
          depth={depth}
        />
      );
  }
}

function FilterCard({
  filter,
  collections,
  onChange,
  onRemove,
  onEditGameList,
  depth,
}: {
  filter: Filter;
  collections: GameCollection[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
  onEditGameList: (filterId: string) => void;
  depth: number;
}) {
  const { ref, focusKey } = useFocusable({ trackChildren: true });
  return (
    <div
      ref={ref}
      className="rounded-[10px] border p-3 flex flex-col gap-2.5"
      style={{ borderColor: "var(--line)", background: "var(--bg-inset)" }}
      data-focus-key={focusKey}
    >
      <div className="flex items-center gap-2">
        <div style={{ minWidth: 180 }}>
          <Select<FilterType>
            value={filter.type}
            onChange={(t) => onChange(makeFilter(t))}
            options={FILTER_TYPES.map((t) => ({ value: t, label: FILTER_LABELS[t] }))}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-3)] ml-auto">
          Invert
          <Toggle
            size="small"
            checked={!!filter.inverted}
            onChange={(inverted) => onChange({ ...filter, inverted })}
          />
        </label>
        <IconButton onClick={onRemove} title="Remove filter" ariaLabel="Remove filter" variant="danger">
          <FaTrash size={11} />
        </IconButton>
      </div>
      <FilterBody
        filter={filter}
        collections={collections}
        onChange={onChange}
        onEditGameList={onEditGameList}
        depth={depth}
      />
    </div>
  );
}

function MergeEditor({
  filter,
  collections,
  onChange,
  onEditGameList,
  depth,
}: {
  filter: Extract<Filter, { type: "merge" }>;
  collections: GameCollection[];
  onChange: (f: Filter) => void;
  onEditGameList: (filterId: string) => void;
  depth: number;
}) {
  const { mode, filters } = filter.params;
  const setChildren = (next: Filter[]) =>
    onChange({ ...filter, params: { ...filter.params, filters: next } });

  return (
    <div
      className="flex flex-col gap-2 pl-3 border-l-2"
      style={{ borderColor: "var(--accent)" }}
    >
      <ModePicker
        mode={mode}
        onChange={(m) => onChange({ ...filter, params: { ...filter.params, mode: m } })}
      />
      {filters.map((child) => (
        <FilterCard
          key={child.id}
          filter={child}
          collections={collections}
          depth={depth + 1}
          onChange={(f) => setChildren(filters.map((x) => (x.id === child.id ? f : x)))}
          onRemove={() => setChildren(filters.filter((x) => x.id !== child.id))}
          onEditGameList={onEditGameList}
        />
      ))}
      <Button
        size="sm"
        variant="neutral"
        onClick={() => setChildren([...filters, makeFilter("collection")])}
      >
        <span className="flex items-center gap-1.5">
          <FaPlus size={10} /> Add nested filter
        </span>
      </Button>
    </div>
  );
}

// ── The editor view ──────────────────────────────────────────────────

export function TabEditor({
  tab,
  collections,
  canDelete,
  onChange,
  onEditGameList,
  onSave,
  onCancel,
  onDelete,
}: {
  tab: Tab;
  collections: GameCollection[];
  canDelete: boolean;
  onChange: (t: Tab) => void;
  onEditGameList: (filterId: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const setFilters = (filters: Filter[]) => onChange({ ...tab, filters });

  return (
    <div className="card flex flex-col gap-5">
      {/* Name */}
      <div className="subsection">
        <div className="subsection-label mb-2">Tab name</div>
        <TextInput
          value={tab.name}
          onChange={(name) => onChange({ ...tab, name })}
          placeholder="e.g. Backlog, Roguelikes, Switch games"
        />
      </div>

      {/* Combine mode + sort + auto-hide */}
      <div className="subsection flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="subsection-label">When a tab has multiple filters</div>
          <ModePicker
            mode={tab.filtersMode}
            onChange={(filtersMode) => onChange({ ...tab, filtersMode })}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="subsection-label">Sort</div>
          <div style={{ minWidth: 220 }}>
            <Select<SortMode>
              value={tab.sort}
              onChange={(sort) => onChange({ ...tab, sort })}
              options={SORT_MODES.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="subsection-label">Hide when empty</div>
            <div className="text-[11px] text-[var(--fg-3)]">
              Drop this tab from the strip while no games match.
            </div>
          </div>
          <Toggle
            checked={tab.autoHide}
            onChange={(autoHide) => onChange({ ...tab, autoHide })}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="subsection flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="subsection-label">Filters</div>
          <span className="text-[11px] text-[var(--fg-3)]">
            {tab.filters.length === 0 ? "No filters — shows every game" : `${tab.filters.length} filter(s)`}
          </span>
        </div>

        {tab.filters.map((filter) => (
          <FilterCard
            key={filter.id}
            filter={filter}
            collections={collections}
            depth={0}
            onChange={(f) => setFilters(tab.filters.map((x) => (x.id === filter.id ? f : x)))}
            onRemove={() => setFilters(tab.filters.filter((x) => x.id !== filter.id))}
            onEditGameList={onEditGameList}
          />
        ))}

        <div className="flex flex-wrap gap-2 mt-1">
          <Button
            size="sm"
            variant="primary"
            onClick={() => setFilters([...tab.filters, makeFilter("whitelist")])}
          >
            <span className="flex items-center gap-1.5">
              <FaPlus size={10} /> Add games by hand
            </span>
          </Button>
          <Button
            size="sm"
            variant="neutral"
            onClick={() => setFilters([...tab.filters, makeFilter("collection")])}
          >
            <span className="flex items-center gap-1.5">
              <FaPlus size={10} /> Add rule filter
            </span>
          </Button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={onSave} disabled={tab.name.trim() === ""}>
          Save tab
        </Button>
        <Button variant="neutral" onClick={onCancel}>
          Cancel
        </Button>
        {canDelete && (
          <Button variant="danger" onClick={onDelete} style={{ marginLeft: "auto" }}>
            <span className="flex items-center gap-1.5">
              <FaTrash size={11} /> Delete tab
            </span>
          </Button>
        )}
      </div>
    </div>
  );
}
