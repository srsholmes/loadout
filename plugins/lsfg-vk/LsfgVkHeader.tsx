// Dynamic topbar header for the LSFG-VK plugin.
//
// Title + dynamic subtitle on the left; on the picker view the right
// half hosts the search input + collection dropdown + gear icon, and
// on the settings view it collapses to a back-arrow only (search and
// the collection filter have nothing to filter in settings).
//
// Picker filter state (search + collection dropdown) comes in as a
// single `filters` bundle from `usePickerFilters()` — the header
// reads + writes the same shape the body's GamePicker consumes,
// without app.tsx having to thread 8 individual props.
//
// Extracted from app.tsx as part of the D-010 decomposition.

import { FaGear } from "react-icons/fa6";
import {
  HeaderBackButton,
  IconButton,
  PluginHeader,
  SearchField,
  Select,
} from "@loadout/ui";

import type { PickerFilters } from "./lib/use-picker-filters";

interface LsfgVkHeaderProps {
  subtitle: string;
  showConfig: boolean;
  /** Only show the search + collection dropdown when the layer is
   *  installed AND we're on the picker view. */
  installed: boolean;
  filters: PickerFilters;
  onEnterConfig: () => void;
  onLeaveConfig: () => void;
}

export function LsfgVkHeader({
  subtitle,
  showConfig,
  installed,
  filters,
  onEnterConfig,
  onLeaveConfig,
}: LsfgVkHeaderProps) {
  return (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            LSFG-VK
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!showConfig && installed && (
            <>
              <SearchField
                value={filters.search}
                onChange={filters.setSearch}
                onClear={() => filters.setSearch("")}
                placeholder="Search library…"
                width={220}
              />
              <div style={{ minWidth: 180 }}>
                <Select
                  value={filters.collection}
                  onChange={filters.setCollection}
                  options={filters.collectionOptions}
                />
              </div>
            </>
          )}
          {showConfig ? (
            <HeaderBackButton
              onBack={onLeaveConfig}
              title="Back to library"
            />
          ) : (
            <IconButton
              onClick={onEnterConfig}
              title="Plugin preferences"
              ariaLabel="Plugin preferences"
            >
              <FaGear size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </PluginHeader>
  );
}
