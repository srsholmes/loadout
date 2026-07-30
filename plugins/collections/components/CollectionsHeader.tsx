/**
 * The plugin's topbar.
 *
 * Portaled into the overlay shell's 60px header slot from inside the main
 * React tree, so it reads the same state as the body without prop-drilling
 * through a second mount. `app.tsx` exports `mountHeaderStub` purely to make
 * the shell reserve the slot.
 *
 * The subtitle is the plugin's running commentary: which tab you're looking
 * at and what it selects, or which tab you're editing. That sentence used to
 * sit in the body, where it pushed the grid down by a line for no reason —
 * the header is where a status line belongs, and it frees the vertical space
 * that a game grid actually wants.
 *
 * Search and "Add tab" live here for the same reason: they are chrome, not
 * content, and the body below is a grid that should start at the top.
 */

import { Button, PluginHeader, SearchField } from "@loadout/ui";

export interface CollectionsHeaderProps {
  /** Sentence describing the active tab, or the tab being edited. */
  subtitle: string;
  search: string;
  onSearchChange: (next: string) => void;
  /** Hidden while editing — the builder owns the screen then. */
  showBrowseActions: boolean;
  /**
   * Opens the tab's options page — rename, reorder, hide, edit rules, delete.
   * Offered for built-ins too: they can still be hidden and moved, and hiding
   * the control entirely is what made the whole surface look absent.
   */
  onTabOptions?: () => void;
  /** Absent when the config is read-only. */
  onAddTab?: () => void;
  /** Opens the plugin's settings — Steam syncing lives there. */
  onSettings?: () => void;
  /** Label for the add/close toggle, since it doubles as a close. */
  addTabLabel: string;
  searchPlaceholder: string;
}

export function CollectionsHeader({
  subtitle,
  search,
  onSearchChange,
  showBrowseActions,
  onTabOptions,
  onAddTab,
  onSettings,
  addTabLabel,
  searchPlaceholder,
}: CollectionsHeaderProps) {
  return (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Collections
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>

        {showBrowseActions ? (
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={search}
              onChange={onSearchChange}
              onClear={() => onSearchChange("")}
              placeholder={searchPlaceholder}
              width={220}
            />
            {onTabOptions ? (
              <Button variant="neutral" onClick={onTabOptions}>
                Tab options
              </Button>
            ) : null}
            {onAddTab ? (
              <Button variant="neutral" onClick={onAddTab}>
                {addTabLabel}
              </Button>
            ) : null}
            {onSettings ? (
              <Button variant="neutral" onClick={onSettings}>
                Settings
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </PluginHeader>
  );
}
