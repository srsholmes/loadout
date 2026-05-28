# @loadout/game-library

> **⚠️ Server-only.** This package is consumed by the loader's
> `__core:game-library` core service. **Plugins MUST NOT import it.**
> Use `useBackend("__core:game-library").call("getGames")` from a
> plugin instead — the RPC surface is the contract; the implementation
> is internal to the loader.
>
> Enforced by the `serverOnly` lint rule in `eslint.config.js` (reads
> `loadout.serverOnly: true` from this package.json).

## Purpose

Pure async scan logic for the installed Steam library: walks every
`appmanifest_*.acf`, merges in non-Steam `shortcuts.vdf` entries, and
attaches user-defined Library Collection tags from
`localconfig.vdf`. The result is a deduped, alphabetised `GameInfo[]`
the loader caches and exposes via the `__core:game-library` RPC.

This package is the implementation; the runtime service wrapper
(caching, debounced broadcast, RPC method names) lives in
`apps/loadout/src/loader/services/game-library.ts`.

## API

```ts
import {
  scanLibrary,
  getCollectionsFromGames,
} from "@loadout/game-library";
import type { GameInfo, GameCollection } from "@loadout/types";

const games: GameInfo[] = await scanLibrary();
const collections: GameCollection[] = getCollectionsFromGames(games);

// Optional: override the loader origin used to build local artwork URLs
// (defaults to `http://localhost:33820`).
await scanLibrary({ loaderOrigin: "http://localhost:33820" });
```

Types are re-exported from `@loadout/types` so plugins can type the
RPC return without importing this package.

## Consumers

- **Loader only**, via `apps/loadout/src/loader/services/game-library.ts`.

Plugins that need library listings (e.g. hltb, launch-options, sgdb,
lsfg-vk, protondb-badges) call the service over RPC:

```ts
const library = useBackend<{
  getGames(): Promise<GameInfo[]>;
  getCollections(): Promise<GameCollection[]>;
  rescan(): Promise<GameInfo[]>;
}>("__core:game-library");
const games = await library.call("getGames");
```

Subscribe to `libraryChanged` to get pushed updates when the scan
result changes between rescans.
