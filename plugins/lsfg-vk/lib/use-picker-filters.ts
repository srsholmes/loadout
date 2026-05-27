// Single owner of the apply-to-game picker's filter state.
//
// The header (search input + collection dropdown) and the body
// (GamePicker, which renders the filtered grid) used to share four
// loose useState atoms threaded through app.tsx as ten props. This
// hook bundles them so the two consumers each take one prop —
// `filters` — and app.tsx is no longer involved in the filter
// plumbing beyond instantiating the hook.
//
// `librarySize` is a write-back from GamePicker after it fetches the
// library; `collections` is the deduplicated tag list it also reports.
// Both are exposed up so the header can render the live count in its
// subtitle / dropdown labels.
//
// PR #103 review medium: was prop drilling, now a single shape.

import { useCallback, useMemo, useState } from "react";

import { ALL_COLLECTIONS, STEAM_ONLY } from "./constants";
import type { CollectionEntry } from "./types";

export interface CollectionOption {
  value: string;
  label: string;
}

export interface PickerFilters {
  search: string;
  setSearch: (s: string) => void;

  collection: string;
  setCollection: (id: string) => void;

  collectionOptions: CollectionOption[];
  /** Total number of games surfaced by GamePicker after its initial
   *  library fetch — `null` until the first load resolves. The
   *  header reads this to render the count in its subtitle. */
  librarySize: number | null;
  /** Callback GamePicker fires once it has the deduped library +
   *  collection list. Drives `collectionOptions` and `librarySize`. */
  onCollectionsLoaded: (cols: CollectionEntry[], total: number) => void;
}

export function usePickerFilters(): PickerFilters {
  const [search, setSearch] = useState("");
  // Default to Steam-only — LSFG-VK applies launch options via
  // Steam, so non-Steam (Heroic / Lutris / emulator) shortcuts in
  // the picker are noise for most users. The "All games" + named
  // collection options stay in the dropdown.
  const [collection, setCollection] = useState<string>(STEAM_ONLY);
  const [collections, setCollections] = useState<CollectionEntry[]>([]);
  const [librarySize, setLibrarySize] = useState<number | null>(null);

  // Stable identity for the GamePicker-side callback — the picker
  // puts this in a useEffect deps array, so a fresh function every
  // render would refetch the library on every parent re-render.
  const onCollectionsLoaded = useCallback(
    (cols: CollectionEntry[], total: number) => {
      setCollections(cols);
      setLibrarySize(total);
    },
    [],
  );

  const collectionOptions = useMemo<CollectionOption[]>(() => {
    const total = librarySize ?? 0;
    const opts: CollectionOption[] = [
      {
        value: ALL_COLLECTIONS,
        label: `All games${total ? ` (${total})` : ""}`,
      },
      { value: STEAM_ONLY, label: `Steam games only` },
    ];
    for (const c of collections) {
      opts.push({ value: c.id, label: `${c.id} (${c.count})` });
    }
    return opts;
  }, [collections, librarySize]);

  return {
    search,
    setSearch,
    collection,
    setCollection,
    collectionOptions,
    librarySize,
    onCollectionsLoaded,
  };
}
