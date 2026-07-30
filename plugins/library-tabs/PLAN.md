# Library Tabs — implementation plan

> **Scratch file — delete when the feature is complete.** This is working
> context for whoever picks the branch up next, not shipped documentation. It
> is deliberately not linked from `README.md`, which is the user-facing doc
> and should survive.
>
> The plan body below is the *original* design, committed unedited, so it
> describes unbuilt work as though it were pending — which it is. The table in
> this preamble is the authoritative statement of what exists today. For the
> conventions you need before editing code, read `README.md`.

## Where this actually stands (as of PR #236)

Phase 1 is functional: browse tabs with live match counts, create tabs from
templates, search, launch. 437 tests pass.

| Plan section | State |
|---|---|
| Architecture, verified constraints | Applied. Two corrections found during implementation — see below. |
| TabMaster parity map | All 25 filters exist in the `Rule` union. Rules needing Phase 2/3 data are defined but evaluate to `indeterminate` until their provider lands. |
| The rule engine | **Built and specced.** `lib/types.ts`, `rules.ts`, `evaluate.ts`, `facts.ts`, `sort.ts`, `group.ts`. |
| Config durability | **Built and specced.** `config.ts`, `migrations.ts`, `share.ts`, `backups.ts`, `storage.ts`. |
| The metadata layer | **Not built.** `lib/adapt.ts` stands in for Phase 1, adapting `__core:game-library` + `playtime` up to the full `GameMetadata` shape. `packages/game-metadata` and `packages/steam-appinfo` do not exist. |
| The Steam Collection mirror | **Not built.** `MirrorLedger` types exist in `lib/types.ts`; `lib/mirror.ts`, `mirror-ledger.ts` and `packages/steam-cdp/src/collections.ts` do not. |
| The filter-builder UX | **Built.** `Sheet`, `ParamEditors`, `RuleNodeRow`, `RuleGroupNode` (with the `ALL → n · ANY → m` line), `RulePalette` (priced candidates), `RuleEditorSheet`, `RuleBuilder`, plus `lib/rule-tree.ts` and `lib/rule-params.ts`. Reached from "Edit rules" on a non-builtin tab. `TabTemplates`, `MirrorPanel`, `BackupsPanel` and `SubTabStrip` still do not exist. |
| Test strategy | Followed. `plugins/library-tabs/lib` is in `SPEC_SCOPED_LIB_DIRS`, so the gate is enforced. Shared fixture at `test/fixtures/library.ts`. |

### Next piece of work, in priority order

1. ~~**The rule builder.**~~ **Built.** Both differentiating features ship:
   the `ALL → 0 · ANY → 340` consequence line on every group, and
   per-candidate palette counts. Editing is a draft, so Cancel reverts.
2. `BackupsPanel` — `listBackups` / `createBackup` / `restoreBackupFile` are
   on the backend already; nothing renders them.
3. Tab reorder / hide / rename UI — backend methods exist.
4. Row windowing (`hooks/useVisibleRows.ts`). Evaluation is fast (<25 ms for
   2000 games x 8 rules); mounting 2000 `GameCard`s is not. **Now the largest
   remaining risk**, since the builder made long sessions on one tab likely.
5. Phases 2–4 — no longer gated; the probe has run.

Still unbuilt in the builder itself: drag-to-reorder (the menu path covers
it), and `SubTabStrip` / grouping UI, which is Phase 5.

### The probe has run — Phases 2–4 are unblocked

`docs/steam-metadata-probe.md`, measured 2026-07-30 on a Steam Deck (2497
apps, CEF 126, `appinfo.vdf` v29). Re-run after a Steam client update with:

```sh
bun plugins/library-tabs/scripts/probe-steam-metadata.ts > docs/steam-metadata-probe.md
```

Read-only. Steam must be running with its library opened at least once.

**Everything below this preamble that calls an `appStore` field name or an
`appinfo.vdf` offset "inferred, not measured" is now measured.** Four results
change the plan, and the sections further down have *not* been rewritten — the
list here wins:

1. **The `appinfo.vdf` per-section header is 68 bytes**, and `sha1_binary`
   *is* present in v29:
   `appid u32 · size u32 · infoState u32 · lastUpdated u32 · picsToken u64 ·
   sha1_text u8[20] · changeNumber u32 · sha1_binary u8[20]`, body at `+68`.
   The plan's mitigation — chain-validate and retry the other layout — **does
   not work**: the next section is at `offset + 8 + size` regardless of header
   size, so the chain cannot fail on a wrong header. `sections.ts` must
   validate **body framing** instead (a body opens `0x00`; a section ends
   `0x08 0x08`). Measured: 68 frames 1247/1247 sections, the alternatives 8, 5
   and 2.
2. **`appStore` field names from TabMaster were right, but they are prototype
   getters, not own keys** — invisible to `Object.keys`, which is why the plan
   doubted them. 22 getters and 57 methods. Prefer
   `steam_deck_compat_category` (decoded `1|2|3`) over the own key
   `steam_hw_compat_category_packed` (bitfield `33|162|227`) and skip
   unpacking. `steam_os_compat_category` exists, so `steamOsCompat` needs no
   new source. Methods that collapse whole rules into one call: `BIsOwned`,
   `BIsDemo`, `BIsBorrowed`/`BIsOwnedByAnotherUser` (familyShared),
   `BIsUnreleased` (comingSoon), `BIsShortcut`, `BIsMusicAlbum`,
   `BHasStoreCategory`, `BHasStoreTag`, `GetStoreTags`, `GetLastTimePlayed`,
   `GetCanonicalReleaseDate`.
3. **Presence is not population.** Over the whole library:
   `size_on_disk` **3%**, `rt_original_release_date` 3%,
   `rt_steam_release_date` 15%, `metacritic_score` 9%,
   `minutes_playtime_forever` 9%, `rt_last_time_played` 10%,
   `steam_deck_compat_category` 15%, `review_percentage` 17%,
   `store_tag` 16%. Consequences: `sizeOnDisk` **cannot** be sourced from
   `appStore` (use `appmanifest_*.acf`), and `releaseDate` should use
   `GetCanonicalReleaseDate()` rather than either `rt_*` field. Also
   **`store_tag` returns numeric tag IDs, not names** — the parity table's
   "names, not opaque numeric ids" needs an ID→name map before a tag rule can
   be authored or displayed.
4. **`RemoveApps` exists.** `CollectionsApi.setApps` does a true replace-set;
   the create-then-delete fallback that loses the user's sidebar position is
   not needed. Phase 4's open question is closed.

The other stated hardware risk — `pushBackInterceptor` from a plugin React
root — is **also retired, by precedent rather than measurement**: `Select`
pushes one whenever its dropdown is open, and five shipped plugins render
`Select`. See the constraints section.

### Two plan assumptions that turned out wrong

Both were corrected in the implementation; the plan text below still reflects
the original reasoning.

1. **`indeterminate` was over-applied.** The plan routed both "Steam never
   recorded this game's playtime" and "the HLTB plugin is disabled" through
   `indeterminate` under one policy. They need opposite defaults, and the tell
   was that nearly every builtin tab and template needed an explicit
   `indeterminatePolicy: "fail"` override to behave sanely. Now: missing
   metadata for *one game* is a definite `false` (overridable per rule via
   `NumericRange.includeUnknown`), and `indeterminate` is reserved for a whole
   *source* being unavailable. Concretely, "Metacritic 80 or more" no longer
   lists unrated games.
2. **`evaluate.ts` and `group.ts` form an import cycle** as specified.
   `groupGames` now takes a `RuleMatcher` callback instead of importing
   `evaluateRule`, so `group.ts` imports nothing from `evaluate.ts`.

### Test baselines on this repo

Both suites have large pre-existing failure counts; each was measured against
a stashed clean tree rather than assumed. Do not read either as a regression
from this branch.

- `bun run test:backend` — 423 failures on macOS, clean *and* with this
  branch. Linux-only codebase (sysfs, `/run/media`, systemd). Should be far
  lower on the Deck.
- `bun run test:ui` — 115 fail / 174 pass clean, 113 / 191 with this branch.
  The `mock.module` leakage in `docs/test-mock-contamination.md`; it also
  takes down `@loadout/ui`'s own `Text` and `hideOverlay` specs. Traced
  mechanism: `lsfg-vk`'s `useBackend` mock reaches
  `components/TabStrip.spec.tsx`, which mocks nothing at all. Every spec in
  this plugin passes in isolation.

---


## Context

TabMaster is the most-loved library-organisation plugin on Steam Deck
(~293k downloads, #15 of 110 Decky plugins) and has **no direct
competitor**. Its actual job-to-be-done is not customisation, it is
**backlog suppression** — users hide every tab except Installed and
Favourites *"so I cannot see everything I can install"*, and merge Steam
+ non-Steam games into single tabs.

It is also structurally fragile, and that fragility is the wedge:

1. **It patches Steam's Library route.** `patchLibrary` hot-swaps React's
   internal `useMemo` dispatcher and mines Steam's closure by positional
   dependency index (`deps[7]`). When it fails, the library becomes
   *unreachable* — users report rebooting ~19 times and getting locked out
   of Decky itself, so they cannot even uninstall it. Fixes then lag the
   Decky store by 5–44 days.
2. **Its data layer is synchronous.** `FilterFunction` is
   `(params, appOverview) => boolean` — no async, no I/O. The maintainer
   cites this to refuse the entire backlog: sub-tabs, live player counts,
   ProtonDB, HLTB, install paths, friends-playing-now.
3. **Its builder silently produces empty tabs.** AND/OR defaults confuse
   users; there is no match count until you save. The maintainer conceded
   in #333: *"merge groups aren't the most intuitive way to do this."*
4. **Config loss is unrecoverable**, and users are vocal about it:
   *"Spent a lot of time putting together those tabs, I really do not
   want to lose all that."*
5. Mouse/keyboard (docked) is the broken input path — controller nav is fine.

Loadout beats all five *by construction*, because its overlay is its own
X11/CEF window rather than an injection into Steam's library UI. Nothing
we render can take Steam's library down.

**Outcome:** a `library-tabs` plugin with full TabMaster parity, the top
declined asks, a builder that cannot silently produce an empty tab, and
each tab optionally mirrored into a **real Steam Collection** — so the
organisation appears natively in Steam without patching one webpack module.

## Architecture

Three layers, one evaluator, zero webpack patches.

```
  Corpus:  __core:game-metadata  ← manifest (ACF) + appstore (CDP) + appinfo.vdf
           one flat GameMetadata[] snapshot, per-provider health
                              │
  Rules:   plugins/library-tabs/lib/  — pure, sync, isomorphic evaluator
           async data prefetched as batched FACTS, then evaluated sync
           three-valued logic: true | false | "indeterminate"
                    ┌─────────┴─────────┐
  Surfaces:   app.tsx (overlay)    backend.ts → Steam Collection mirror
        ┌──────────────────────┐   ┌──────────────────────┐
        │ Unplayed│Short│Deck✓ │   │ Steam ▸ Collections  │
        │ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ │──►│  ▸ Unplayed     (42) │
        │ live counts, builder │   │  ▸ Short Games  (18) │
        └──────────────────────┘   └──────────────────────┘
```

`app.tsx` evaluates client-side (instant tab switch, instant live counts,
zero RPC per keystroke); `backend.ts` imports the *same* evaluator to plan
the collection mirror. One evaluator, two callers.

**The thing that actually beats TabMaster is `EvalResult.trace`.** Every
evaluation emits per-rule pass/fail/indeterminate counts plus leave-one-out
counts. Live counts, plain-English summaries, and a self-diagnosing empty
state then fall out for free instead of being bolted on.

**Deliberately rejected:** patching Steam's library tab array via
`apps/loadout/src/injector/webpack-patcher.ts`. It is wired
(`injector.ts:394`) but no shipped plugin declares `patches` — live
infrastructure, zero users — and it is the exact mechanism behind
TabMaster's worst failure mode.

## Verified constraints (checked against the repo)

- `scripts/check-plugin-specs.sh` is **opt-in per directory**:
  `SPEC_SCOPED_LIB_DIRS="plugins/recomp/lib"`, `SPEC_SCOPED_PACKAGES=""`.
  We add our dirs — as the **first commit of Phase 1**, so the gate is
  green throughout rather than bolted on at the end.
- **`useConfigValue`/`setConfigValue` are NOT available to plugins** — they
  live in `apps/loadout-overlay/src/overlay/lib/userConfig.ts` and are not
  in the `@loadout/ui` barrel. All state goes through backend RPC +
  `@loadout/plugin-storage`. The plugin owns its persistence end to end.
- `@loadout/ui`'s `TabBar` is unusable as our strip (no counts, no overflow
  scroll, no reorder, no context menu). Build `components/TabStrip.tsx`
  in-plugin — which we want anyway, since **adding a `@loadout/ui` export
  forces a full overlay rebuild + reinstall**.
- ~~`pushBackInterceptor` is used only by overlay-internal components.
  library-tabs would be the first plugin consumer.~~ **Wrong — it already has
  plugin consumers.** `packages/ui/src/components/Select.tsx:186` pushes an
  interceptor whenever its dropdown is open, and `protondb-badges`,
  `battery-tracker`, `steamgriddb`, `hltb` and `lsfg-vk` all render `Select`.
  So B-closes-the-modal-without-popping-the-page is shipped behaviour from a
  plugin React root, and `Sheet.tsx` can follow `Select`'s pattern rather than
  treating it as unproven. Still worth eyeballing once on hardware, but it is
  no longer a design risk.
- `readUserCollections` (`packages/game-library/src/index.ts:140`) types the
  JSON as `{ id?, added? }` and **discards `name` and `removed`**. So
  `tags` holds raw ids like `uc-1234567` with no way to render a friendly
  name, and a game explicitly removed from a collection still reads as a
  member. Both must be fixed for a credible collection filter.
- Same function does `if (!game) continue;` — collections on
  owned-but-not-installed games are dropped. Ownership cannot be bolted
  onto `game-library`.
- `getAllApps()` (`steam-cdp/src/steam-client.ts:674`) filters
  `app_type === 1` and projects only `{appId, name}`. Needs a **sibling
  method**, not a change — `protondb-badges` depends on the current shape.
- `withSteamClient` needs `network: ["localhost"]` in the manifest —
  `steam-cdp/src/tabs.ts:73` fetches `http://localhost:<port>/json` through
  the loader's sandboxed fetch.
- `packages/game-library/src/index.ts` is 341 LOC with **no test file**. If
  we touch it, add `index.test.ts`.
- **No Steam install on this dev machine** — `appinfo.vdf` and every
  `appStore` field name are unverifiable locally. This is why Phase 1 ships
  a hardware probe and Phase 3 must not be estimated before it runs.

## Phases

Each phase is independently shippable and user-visible.

### Phase 1 — Tabbed library browser (MVP). Zero CDP, zero appinfo.

Ships: the plugin page with a horizontally-scrolling tab strip with live
counts; builtin tabs (All / Installed / Non-Steam / Recently Played /
Never Played); one auto tab per Steam collection; the full rule builder
restricted to the Phase-1 rule set; `GameCardGrid` tiles; fuzzy search
(`fuzzysort` + `collectionSearchTokens`); A-to-launch; per-tab sort + item
cap; config with schema versioning, timestamped backups, restore,
export/import.

Phase-1 rules — all derivable from `__core:game-library` + `plugins/playtime`:
`group`, `collection`, `installed`, `title`, `source`, `playtime`,
`sizeOnDisk`, `lastPlayed`, `whitelist`, `blacklist`.

Also ships the additive `game-library` fix:
`GameCollectionDetail { id, name, appIds, removedAppIds }` +
`getCollectionDetails()` RPC, honouring `removed`.

Also ships **`plugins/library-tabs/scripts/probe-steam-metadata.ts`**
(maintainer-only, zero user risk). Run on a real Deck; dumps (a) the full
key set and value types of 5 sampled `appStore.allApps` overviews, (b) the
first 64 bytes of `appcache/appinfo.vdf` plus decoded headers for the first
3 sections plus an `offset + size` chain-validation report over the whole
file, (c) `collectionStore` shapes including `Object.getOwnPropertyNames`
on a collection and on `collectionStore` itself (to confirm whether
`RemoveApps` exists), and which collections are dynamic/editable. Output
committed as `docs/steam-metadata-probe.md`.
~~**Phases 2, 3 and 4 do not start until this has run on hardware.**~~ Ran
2026-07-30; results in the preamble.

### Phase 2 — Ownership + rich online metadata (CDP).

Ships `__core:game-metadata` with the `manifest` + `appstore` providers,
backed by a persisted ownership snapshot so it degrades instead of dying.
New rules: `owned`, `appKind` (unlocks demo), `deckCompat`, `steamOsCompat`,
`reviewScore`, `metacritic`, `releaseDate`, `purchaseDate`, `storeTags`,
`comingSoon`, `familyShared`, `streamable`, `installFolder`, `feature`.

The `installed`/`owned` split is the backlog-suppression job-to-be-done.

Measured corrections to this phase (see the preamble): read the **prototype
getters**, not the own keys — `steam_deck_compat_category` and
`steam_os_compat_category` come decoded, so `deckCompat`/`steamOsCompat` need
no bitfield unpacking. `owned`, `appKind: ["demo"]`, `familyShared` and
`comingSoon` are one method call each (`BIsOwned`, `BIsDemo`, `BIsBorrowed`,
`BIsUnreleased`). `releaseDate` uses `GetCanonicalReleaseDate()` because both
`rt_*` date fields are populated for under 15% of the library. `sizeOnDisk`
moves to the `manifest` provider — `appStore` carries it for 3% of apps.
`storeTags` needs an **ID→name map**; `store_tag` and `GetStoreTags()` both
return numeric IDs.

Provider health renders as a persistent chip: *"Ownership data from 3 days
ago — Steam wasn't reachable."* Rules needing an unavailable provider are
**visibly annotated and evaluate to `indeterminate`, never silently false**.

### Phase 3 — `appinfo.vdf` offline metadata.

Ships `packages/steam-appinfo` + the `appinfo` provider, so every Phase-2
filter keeps working with Steam closed, plus fields `appStore` doesn't
carry: `genres`, `developers`, `publishers`, `franchises`, `features` (full
set), `sortAs`. Other plugins can now consume `__core:game-metadata` —
`hltb` gets release dates for disambiguation, `protondb-badges` gets
`appKind` to stop badging soundtracks, `store-bridge` gets genres.

### Phase 4 — Steam Collection mirror.

Ships per-tab "Mirror to Steam collection", a pure reconciliation planner
with a dry-run preview, an ownership ledger, conflict-refusal against
user-made collections, an offline pending-sync queue, one-button "Remove
all mirrored collections", and TabMaster's **Snapshot** equivalent (freeze
a dynamic tab into a static collection). New `CollectionsApi` in
`packages/steam-cdp`.

### Phase 5 — Sub-tabs, async facts, presentation. (The declined-asks phase.)

Ships `GroupSpec` → sub-tab strip or in-tab sections, both `{kind:"field"}`
auto-grouping and `{kind:"rules"}` manual groups — **the #1 unmet
TabMaster demand**. Async fact resolvers for `friendsPlaying`, `friendsOwn`,
`achievements`, `hltbMain` (cross-plugin RPC to `hltb`), `protonTier`
(cross-plugin RPC to `protondb-badges`), `onSdCard`. Per-game `sortAs` /
`displayName` overrides and `manual` sort order. Per-tab tile size and
badge selection.

### Phase 6 — Profiles, sharing, polish.

Ships Tab Profiles keyed off `handleGameLaunch`/`handleGameExit`
(TabMaster's are global and manual — ours auto-switch, which is the ask);
single-tab share strings; `mountHomeWidget` ("Jump back in" from the
default tab); `mountHeader` global search.

## TabMaster parity map

All 25 TabMaster filters, and where each lands. Phase in brackets.

| TabMaster filter | Our rule | Notes |
|---|---|---|
| Collection | `collection` [1] | + friendly names via `getCollectionDetails` |
| Installed | `installed` [1] | |
| Regex | `title` [1] | `match: "contains"｜"startsWith"｜"regex"` — contains is the safe default TabMaster lacks |
| Friends | `friendsOwn` [5] | async fact |
| Community Tags | `storeTags` [2] | names, not opaque numeric ids — **needs an ID→name map**; Steam returns IDs |
| Whitelist / Blacklist | `whitelist` / `blacklist` [1] | non-invertible by design |
| Merge | `group` [1] | first-class nesting, visible indentation, max depth 4 |
| Platform | `source` + `appKind` [1/2] | `appKind` replaces the tools/videos exclusion hack |
| Deck Compatibility | `deckCompat` [2] | |
| SteamOS Compatibility | `steamOsCompat` [2] | |
| Review Score | `reviewScore`, `metacritic` [2] | split into two rules — TabMaster conflates them behind a dropdown |
| Time Played | `playtime` [1] | `NumericRange`, not slider-capped at 300 |
| Size on Disk | `sizeOnDisk` [1] | |
| Release Date | `releaseDate` [2] | absolute *and* relative via one `NumericRange` |
| Purchase Date | `purchaseDate` [2] | |
| Last Played | `lastPlayed` [1] | + explicit `neverPlayedOnly` |
| Family Sharing | `familyShared` [2] | |
| Demo | `appKind: ["demo"]` [2] | |
| Coming Soon | `comingSoon` [2] | |
| Streamable | `streamable` [2] | installed on another client |
| Steam Features | `feature` [2/3] | named keys, not 33 magic category ids |
| Achievements | `achievements` [5] | async fact — TabMaster's is knowingly unreliable |
| MicroSD Card | `onSdCard` [5] | derived from `installPath`, **no MicroSDeck dependency** |
| Install Folder | `installFolder` [2] | |

Tab-management parity: Quick Tabs presets → `templates.ts`; `autoHide` →
`Tab.autoHide`; `sortByOverride` → `Tab.sort` (with asc/desc, which
TabMaster cannot do); hide default tabs → `Tab.visible` +
`hiddenBuiltinTabs`; `visibleToOthers` / shared tabs → `share.ts` strings
(cross-device, not same-device-only); Snapshot → Phase 4; Fix System →
`diagnose.ts` (dismissable and non-blocking, unlike TabMaster's
un-dismissable modal); `categoriesToInclude` bit field → just an `appKind`
rule. **New: `defaultTabId`** — set the opening tab without hiding All
Games (declined upstream as #221).

## The metadata layer

**Decision: a new `__core:game-metadata` core service.** Not an extension
of `GameInfo`, not plugin-local.

- **Extending `GameInfo`** is wrong three ways. (a) `getGames()` is called
  on mount by ~9 plugins that want a name and a capsule URL; +25 fields
  makes all of them pay ~800 KB of WS payload. (b) It couples the ~100 ms
  ACF scan to a 50–200 MB parse in the *same* lazily-cached call. (c)
  `GameLibraryService.signature()` is `count + sorted appIds` — metadata
  changes wouldn't invalidate it, so the cache would be silently wrong.
- **Plugin-local** is wrong because the appinfo parse and the `appStore`
  snapshot are process-wide singletons; two plugins doing it independently
  double a 200 MB parse and diverge.

```
packages/steam-appinfo/    # NOT serverOnly — pure codec, Buffer in / objects out
packages/game-metadata/    # serverOnly — orchestration, fs, cache, CDP merge
apps/loadout/src/loader/services/game-metadata.ts   # the __core:* wrapper
packages/types/src/game-metadata.ts                 # shared contract
```

`steam-appinfo` is deliberately unsealed, mirroring `@loadout/vdf` — a pure
decoder with no privilege story. `game-metadata` **is** sealed
(`loadout.serverOnly: true`), same rationale as `game-library`.

**Do not refactor `parseBinaryVdf`.** v29's string table makes keys `uint32`
indices, so the reader needs a `keyMode: "inline" | "table"` switch.
`parseBinaryVdf` is shipped, spec'd, and load-bearing for `shortcuts.vdf`.
Duplicate ~120 LOC into `steam-appinfo/src/inner-kv.ts` rather than risk a
silent `shortcuts.vdf` regression; unify later as an isolated change.

### appinfo.vdf: two-pass with an on-disk index

Never read 200 MB to answer "what genre is app 620".

1. **Index pass** — stream with a `FileHandle` + 4 MB sliding window;
   read each section's fixed header and `seek` past the body. Yields
   `Map<appId, {offset, size, changeNumber}>`.
2. **Projection pass** — for appIds we care about, decode and project to a
   compact `AppInfoRecord`, dropping ~95 % of the tree (no launch configs,
   depots, ufs, localisation). Write `appinfo-projected.json` (~2–5 MB for
   3000 apps) to `~/.cache/loadout/game-metadata/`.
3. **Cache key** `{fileSize, mtimeMs, magic}` — on match, skip both passes.
4. **Incremental** — on mtime change re-run only the index and compare
   `changeNumber` per app; re-project only deltas. Steam bumps
   `changeNumber` on every PICS update, so this is exact, not heuristic.

Target: cold ~3–8 s (backgrounded, non-blocking), warm ~50 ms,
incremental ~300 ms.

### Owned-but-not-installed

`appStore.allApps` over CDP is the only source and needs Steam's library to
have booted.

- Every successful read writes
  `~/.cache/loadout/game-metadata/ownership-snapshot.json`.
- CDP fails → serve the snapshot with
  `providers.appstore = { status: "stale", capturedAt, reason: "Steam isn't running — showing ownership from <relative time>" }`.
- Never captured → `status: "unavailable"`, reason *"Ownership data needs
  Steam's library to have opened at least once."* The builder then
  **disables** owned-only rules with that exact sentence beside them and a
  "Retry now" button. It does **not** evaluate them to `false`. This single
  mechanism kills TabMaster's worst UX bug class.
- Field precedence in `packages/game-metadata/src/merge.ts`:
  `manifest > appstore > appinfo` for `installed`/`sizeOnDisk`/`name`;
  `appstore > appinfo` for `lastPlayed`/`playtimeMinutes`/
  `reviewPercentage`/`deckCompat`; `appinfo` only for `genres`/
  `developers`/`publishers`/`metacritic`/`features`/`sortAs`; union for
  `collections`/`storeTags`.

### The record type

```ts
// packages/types/src/game-metadata.ts
export type AppKind =
  | "game" | "demo" | "dlc" | "tool" | "application" | "music"
  | "video" | "series" | "mod" | "config" | "beta" | "shortcut" | "unknown";
export type DeckCompat = "unknown" | "unsupported" | "playable" | "verified";
export type SteamOsCompat = "unknown" | "unsupported" | "compatible";
export type MetadataProviderId = "manifest" | "appstore" | "appinfo";

export interface GameFeatures {
  singlePlayer: boolean; multiPlayer: boolean; coop: boolean;
  cloudSaves: boolean; achievements: boolean; tradingCards: boolean;
  workshop: boolean; fullControllerSupport: boolean;
  partialControllerSupport: boolean; remotePlayAnywhere: boolean;
  remotePlayTogether: boolean; vr: boolean; hdr: boolean;
}

/** Sentinel discipline: numeric "unknown" is ALWAYS -1 — never 0, never
 *  undefined — so range predicates can exclude unknowns explicitly
 *  instead of accidentally matching `min: 0`. */
export interface GameMetadata {
  appId: string;
  name: string;
  /** `common.sortas` when present, else `name`. Never empty. */
  sortAs: string;
  kind: AppKind;
  source: GameSource;
  installed: boolean;
  /** false only means "not provably owned" — check providers.appstore. */
  owned: boolean;
  sizeOnDisk: number;          // bytes, -1 unknown
  installPath: string | null;  // drives onSdCard + installFolder
  releaseDate: number;         // epoch sec, -1 unknown
  purchasedAt: number;         // epoch sec, -1 unknown
  lastPlayed: number;          // epoch sec, 0 = never, -1 unknown
  playtimeMinutes: number;     // 0 = never, -1 unknown
  deckCompat: DeckCompat;
  steamOsCompat: SteamOsCompat;
  reviewPercentage: number;    // 0-100, -1 unknown
  metacritic: number;          // 0-100, -1 unknown
  comingSoon: boolean;
  familyShared: boolean;
  /** Installed on some OTHER client — TabMaster's "streamable". */
  streamable: boolean;
  developers: string[]; publishers: string[]; franchises: string[];
  genres: string[];
  storeTags: string[];         // human-readable names
  collections: string[];       // collection ids AND user tags
  features: GameFeatures;
  headerUrl: string; capsuleUrl: string;
  /** Which providers actually contributed a field to this record. */
  contributors: MetadataProviderId[];
}

export interface ProviderState {
  status: "ok" | "stale" | "unavailable" | "loading";
  capturedAt: number;   // epoch ms, 0 when never captured
  /** Rendered VERBATIM in the UI when status !== "ok". Write it for users. */
  reason?: string;
  /** Fields this provider solely sources — drives which rules get
   *  disabled + annotated in the builder. */
  ownsFields: readonly (keyof GameMetadata)[];
}

export interface GameMetadataSnapshot {
  games: GameMetadata[];
  providers: Record<MetadataProviderId, ProviderState>;
  generatedAt: number;
}
```

Service RPC: `getSnapshot()`, `refresh(providers?)`, `getProviderStates()`;
emits `metadataChanged`. Registered in
`apps/loadout/src/loader/index.ts` immediately after `GameLibraryService`,
copying that block verbatim (`apps/loadout/src/loader/index.ts:295-312`).
The loader wires `libraryChanged` → `refresh(["manifest"])` in the same section.

**Progressive delivery is mandatory.** `getSnapshot()` must return the
manifest-only snapshot in <150 ms with the other providers at
`status: "loading"`, then emit `metadataChanged` per provider as it lands.
If it blocks on a cold appinfo parse we have reproduced TabMaster's
synchronous data layer.

## The rule engine

```ts
// plugins/library-tabs/lib/types.ts   (type-only — exempt from the spec gate)
export interface NumericRange {
  min?: number; max?: number;    // inclusive; undefined = unbounded
  /** When true, the -1/unknown sentinel PASSES. Default false. Explicit
   *  because "released before 2015" silently swallowing every
   *  unknown-date game is exactly the TabMaster empty-tab bug. */
  includeUnknown?: boolean;
}
export type SetMode = "anyOf" | "allOf";
export type FactKey =
  | "friendsPlaying" | "friendsOwn" | "achievements"
  | "hltbMain" | "protonTier" | "onSdCard";

export type Rule =
  | { id: string; kind: "group"; combinator: "all" | "any"; invert?: boolean; children: Rule[] }
  | { id: string; kind: "collection"; invert?: boolean; collectionIds: string[]; mode: SetMode }
  | { id: string; kind: "installed"; invert?: boolean }
  | { id: string; kind: "owned"; invert?: boolean }
  | { id: string; kind: "source"; invert?: boolean; sources: GameSource[] }
  | { id: string; kind: "appKind"; invert?: boolean; kinds: AppKind[] }
  | { id: string; kind: "title"; invert?: boolean; match: "contains" | "startsWith" | "regex"; value: string; caseSensitive?: boolean }
  | { id: string; kind: "playtime"; invert?: boolean; minutes: NumericRange }
  | { id: string; kind: "sizeOnDisk"; invert?: boolean; bytes: NumericRange }
  | { id: string; kind: "releaseDate"; invert?: boolean; epochSec: NumericRange }
  | { id: string; kind: "purchaseDate"; invert?: boolean; epochSec: NumericRange }
  | { id: string; kind: "lastPlayed"; invert?: boolean; epochSec: NumericRange; neverPlayedOnly?: boolean }
  | { id: string; kind: "deckCompat"; invert?: boolean; categories: DeckCompat[] }
  | { id: string; kind: "steamOsCompat"; invert?: boolean; categories: SteamOsCompat[] }
  | { id: string; kind: "reviewScore"; invert?: boolean; percent: NumericRange }
  | { id: string; kind: "metacritic"; invert?: boolean; score: NumericRange }
  | { id: string; kind: "storeTags"; invert?: boolean; tags: string[]; mode: SetMode }
  | { id: string; kind: "genres"; invert?: boolean; genres: string[]; mode: SetMode }
  | { id: string; kind: "developer"; invert?: boolean; names: string[] }
  | { id: string; kind: "publisher"; invert?: boolean; names: string[] }
  | { id: string; kind: "feature"; invert?: boolean; features: (keyof GameFeatures)[]; mode: SetMode }
  | { id: string; kind: "comingSoon"; invert?: boolean }
  | { id: string; kind: "familyShared"; invert?: boolean }
  | { id: string; kind: "streamable"; invert?: boolean }
  | { id: string; kind: "installFolder"; invert?: boolean; paths: string[] }
  // Explicit membership. Deliberately NOT invertible — inverting a
  // whitelist IS a blacklist, and offering both invites confusion.
  | { id: string; kind: "whitelist"; appIds: string[] }
  | { id: string; kind: "blacklist"; appIds: string[] }
  // ── Async-fact rules (Phase 5). Same shape; they simply report a
  //    FactKey from `requiredFacts()`.
  | { id: string; kind: "friendsPlaying"; invert?: boolean; minCount: number }
  | { id: string; kind: "friendsOwn"; invert?: boolean; steamIds: string[]; mode: SetMode }
  | { id: string; kind: "achievements"; invert?: boolean; percent: NumericRange }
  | { id: string; kind: "hltbMain"; invert?: boolean; hours: NumericRange }
  | { id: string; kind: "protonTier"; invert?: boolean; tiers: string[] }
  | { id: string; kind: "onSdCard"; invert?: boolean };

export type SortField =
  | "sortAs" | "name" | "lastPlayed" | "playtimeMinutes" | "sizeOnDisk"
  | "releaseDate" | "reviewPercentage" | "deckCompat" | "random" | "manual";
export interface SortSpec { field: SortField; dir: "asc" | "desc" }

export type GroupFieldKey =
  | "collection" | "genre" | "appKind" | "deckCompat" | "developer"
  | "firstLetter" | "releaseYear" | "source";
export type GroupSpec =
  | { kind: "none" }
  | { kind: "field"; field: GroupFieldKey; sortGroups: "alpha" | "countDesc"; maxGroups?: number; otherLabel: string | null }
  /** Manual sub-tabs — the #1 declined TabMaster ask. */
  | { kind: "rules"; groups: Array<{ id: string; label: string; rule: Rule }>; residualLabel: string | null };

export interface Tab {
  id: string;
  label: string;
  icon?: string;                 // react-icons name via a whitelist map
  /** false = "concealed": exists, evaluable, mirrorable, not in the strip. */
  visible: boolean;
  /** Hide automatically when the tab evaluates to zero games (preserves
   *  strip order, unlike manual hiding). TabMaster's `autoHide`. */
  autoHide: boolean;
  /** Present => hideable but not deletable, and `root` is not editable. */
  builtin?: "all" | "installed" | "non-steam" | "recent" | "never-played";
  root: Extract<Rule, { kind: "group" }>;
  sort: SortSpec[];
  manualOrder?: string[];        // appIds, for sort.field === "manual"
  limit: number | null;          // cap after sort. Declined by TabMaster.
  group: GroupSpec;
  display: { tileWidth: number; showLabels: boolean; badges: string[] };
  mirror: { enabled: boolean; collectionName: string };
  /** What to do with rules whose facts are unavailable. Default "pass" —
   *  a broken data source must never silently empty a tab. */
  indeterminatePolicy: "pass" | "fail";
}
```

### Async as a first-class citizen

This is the structural fix for TabMaster's refused backlog. Async data is
**not** evaluated asynchronously — it is prefetched as batched facts and
materialised onto `EvalGame.facts` before a synchronous pass.

```ts
// plugins/library-tabs/lib/facts.ts  [iso]
export type FactValue =
  | { state: "ok"; value: number | string | boolean | string[] }
  | { state: "loading" }
  | { state: "unavailable"; reason: string };

/** The fully-materialised unit the evaluator sees. Built ONCE per
 *  snapshot, not per rule. */
export interface EvalGame {
  meta: GameMetadata;
  norm: {  // precomputed to keep predicates allocation-free
    nameLower: string;
    collectionSet: ReadonlySet<string>;
    storeTagSet: ReadonlySet<string>;
    genreSet: ReadonlySet<string>;
  };
  facts: Partial<Record<FactKey, FactValue>>;
}
export function requiredFacts(rule: Rule): Set<FactKey>;
export function buildEvalGames(
  games: GameMetadata[],
  facts: Partial<Record<FactKey, ReadonlyMap<string, FactValue>>>,
): EvalGame[];
```

```ts
// plugins/library-tabs/lib/async-facts.ts  [backend]
export interface FactResolver {
  key: FactKey;
  ttlSec: number;
  /** Batched over the whole library. Must resolve, never reject: a failed
   *  source returns {state:"unavailable", reason} for every appId. */
  resolve(appIds: string[]): Promise<Map<string, FactValue>>;
}
export function createResolvers(deps: { callPlugin: CallPlugin; cache: ExternalCache }): FactResolver[];
```

Backend RPC `getFacts(keys, appIds)` returns whatever is warm in
`@loadout/external-cache` **immediately** (missing entries as
`{state:"loading"}`), resolves the rest in the background, and emits
`factsUpdated`. Render path: tab mounts → renders instantly with `loading`
facts → refines on `factsUpdated`. A slow ProtonDB fetch delays nothing and
empties nothing.

### The evaluator

```ts
// plugins/library-tabs/lib/evaluate.ts  [iso]
export type Verdict = true | false | "indeterminate";

/** Kleene three-valued logic:
 *    all: any false → false; else any indeterminate → indeterminate; else true
 *    any: any true  → true;  else any indeterminate → indeterminate; else false
 *    invert: flips true/false, PRESERVES indeterminate. */
export function evaluateRule(rule: Rule, game: EvalGame): Verdict;

export interface RuleNodeTrace {
  nodeId: string; kind: RuleKind;
  passed: number; failed: number; indeterminate: number;
  /** Count the PARENT group would produce with this child removed.
   *  This one number is what makes the diagnostic empty state possible. */
  withoutThis: number;
  children?: RuleNodeTrace[];
}

export interface EvalResult {
  matched: GameMetadata[];               // post-sort, post-cap
  groups: Array<{ id: string; label: string; games: GameMetadata[] }>;
  total: number;                         // pre-cap match count
  cappedOut: number;
  trace: RuleNodeTrace;
  blockedFacts: Array<{ fact: FactKey; reason: string; ruleIds: string[] }>;
  /** One Uint8Array per LEAF rule (1 = passed), aligned to the input
   *  array. Powers pairwise contradiction detection without a
   *  hardcoded table. */
  leafMasks?: Map<string, Uint8Array>;
}

export function evaluateTab(
  tab: Tab, games: EvalGame[], opts?: { trace?: boolean; now?: number },
): EvalResult;
```

`opts.trace` is `false` on the hot render path, `true` only while the editor
is open. `now` is injected so relative-date tests are deterministic.

Budget: 2000 games × 8 leaves ≈ 16 k allocation-free predicate calls, well
under 2 ms — live counts on every keystroke are fine. Leave-one-out adds
O(n·k), still <20 ms. Pairwise mask intersection is O(k²·n/8) byte ops.

## The Steam Collection mirror

`addAppToCollection` (`steam-client.ts:464`) is an additive name-keyed merge
with no removal and one `SaveCollection` per app. Mirroring is set
reconciliation. New file, new namespace; leave the existing method untouched
(`recomp` depends on it).

```ts
// packages/steam-cdp/src/collections.ts
export interface SteamCollection {
  id: string; name: string; appIds: number[];
  isDynamic: boolean;   // tag/filter-driven — NOT writable, must be skipped
  isEditable: boolean;
}
class CollectionsApi {
  list(): Promise<SteamCollection[]>;
  create(name: string, appIds: number[]): Promise<string>;
  /** Replace-set: one RemoveApps + one AddApps + one SaveCollection. */
  setApps(collectionId: string, appIds: number[]): Promise<void>;
  rename(collectionId: string, name: string): Promise<void>;
  remove(collectionId: string): Promise<void>;
}
// Exposed as `sc.collections`, alongside `sc.url`.
```

Identity comes from a **ledger**, never a name prefix — names stay clean so
the collections look native.

```ts
// plugins/library-tabs/lib/mirror-ledger.ts  [backend]
export interface MirrorLedgerEntry {
  tabId: string; collectionId: string; collectionName: string;
  /** Last set we successfully wrote. Diff base — lets us detect user
   *  edits to OUR collection and warn rather than silently clobber. */
  appIds: string[];
  lastSyncedAt: number;
}
```

```ts
// plugins/library-tabs/lib/mirror.ts  [iso] — PURE, no CDP
export interface MirrorPlan {
  creates: Array<{ tabId: string; name: string; appIds: number[] }>;
  updates: Array<{ tabId: string; collectionId: string; add: number[]; remove: number[] }>;
  renames: Array<{ collectionId: string; from: string; to: string }>;
  deletes: Array<{ collectionId: string; name: string; reason: "tab-deleted" | "mirror-disabled" }>;
  /** Our target name exists and is NOT ours. Needs explicit consent. */
  conflicts: Array<{ tabId: string; name: string; existingCollectionId: string; existingCount: number }>;
  /** Our collection was edited in Steam since we last wrote it. */
  drifted: Array<{ tabId: string; collectionId: string; unexpectedAdds: number[]; unexpectedRemoves: number[] }>;
  /** Ledger points at a collection Steam no longer has → re-create. */
  orphaned: Array<{ tabId: string; collectionId: string }>;
  noops: string[];
}
export function planMirror(args: {
  tabs: Tab[];
  evaluated: ReadonlyMap<string, string[]>;   // tabId -> appIds, post-cap
  ledger: MirrorLedger;
  steamCollections: SteamCollection[];
}): MirrorPlan;
```

Purity is the point: 100 % unit-testable with zero CDP, and the UI renders
the plan as a **dry run** — *"Sync will create 2, update 3, delete 1 —
Review"* — before anything is written.

- **When sync fires:** explicit "Sync now"; on tab save, debounced 2 s; on
  `libraryChanged`; on load if `autoSync && pendingSync`. Never on a timer,
  never on `metadataChanged` (would thrash on every provider landing).
  Hard floor of one automatic sync per 60 s.
- **Deletions** execute only for ids present in our ledger. A collection we
  never created is never deleted, full stop.
- **Renames** update the ledgered id rather than create-new + delete-old, so
  the user's Steam sidebar ordering survives.
- **Not clobbering user collections:** `conflicts` → *"A Steam collection
  named 'Backlog' already exists with 14 games. Rename this tab, or take it
  over (its contents will be replaced)."* `drifted` → *"You changed
  'Backlog' in Steam. Overwrite with the tab's rules, or stop mirroring?"*
  Never silent.
- **Steam not running:** set `pendingSync`, show *"2 tabs waiting to sync —
  Steam isn't reachable"* with Retry. Retried opportunistically on the next
  `handleGameLaunch` (proof Steam is up). No retry loop, no backoff timer.
- **Uninstall-clean:** `unmirrorAll()` walks the ledger, deletes exactly
  those ids, clears the ledger. Explicit destructive button with typed
  confirmation. **Not** called from `onUnload` — disabling a plugin must
  not silently destroy Steam-side user data.
- Non-Steam shortcuts mirror fine — `collectionStore` accepts shortcut
  appids (`recomp` already relies on this).

## The filter-builder UX

Design axiom: **the builder never shows you a number you didn't ask for, and
never hides the number that matters.** Every rule row shows its own count;
the tab header shows the tab count; the palette shows the count each
candidate rule *would* produce before you add it.

All components live in-plugin — no `@loadout/ui` additions, so no overlay
rebuild. Precedent: `plugins/fan-control/components/FanCurveGraph.tsx`.

**Row anatomy** (`RuleNodeRow.tsx`), left to right: drag handle (mouse) /
`⋮⋮` menu button (gamepad+keyboard), rule icon, **plain-English summary**
from `summarize.ts`, right-aligned count badge, invert toggle, overflow menu
(Edit · Invert · Wrap in group · Move up · Move down · Duplicate · Delete).

**Combinator is a sentence, not a toggle.** `RuleGroupNode` renders
`Show a game when [ALL ▾] of these are true`, and below it a live
consequence line: `ALL → 0 games · ANY → 340 games`. **The AND/OR confusion
that produces TabMaster's empty tabs is impossible when both outcomes are
on screen simultaneously.**

**Visible nesting:** 20 px indent step per depth plus a left vertical rule
in `border-base-300`, and a depth-tinted `bg-base-200`/`bg-base-300`
backplate on the group header. Max depth 4, enforced.

**Palette preview** — the highest-leverage detail. For each candidate rule
at its default params, `RulePalette` computes
`evaluateTab({...tab, root: withCandidate}, games).total`. ~30 candidates ×
2 ms = 60 ms, run in a `useDeferredValue`. Zero-match candidates are still
listed but dimmed with `→ 0 games` and sorted last, so users learn the shape
of their library while building.

**The smart empty state:**

```ts
// plugins/library-tabs/lib/diagnose.ts  [iso]
export interface Fix { label: string; apply: (tab: Tab) => Tab }
export type Diagnosis =
  | { kind: "ok" }
  | { kind: "empty-library"; message: string }
  | { kind: "blocked-facts"; facts: FactKey[]; message: string; fixes: Fix[] }
  | { kind: "contradiction"; ruleIds: [string, string]; message: string; fixes: Fix[] }
  | { kind: "single-culprit"; ruleId: string; wouldMatch: number; message: string; fixes: Fix[] }
  | { kind: "combinator"; anyWouldMatch: number; message: string; fixes: Fix[] }
  | { kind: "over-capped"; limit: number; total: number; message: string; fixes: Fix[] }
  | { kind: "genuinely-empty"; message: string };
export function diagnoseTab(tab: Tab, result: EvalResult, librarySize: number): Diagnosis;
```

Order, first match wins:

1. `librarySize === 0` → *"Your library hasn't been scanned yet."*
2. `blockedFacts` → *"3 rules couldn't be checked: Friends Playing needs
   Steam running."* Fixes: `Ignore unchecked rules for now` (flips
   `indeterminatePolicy` to `pass`), `Retry data sources`.
3. **Contradiction, detected empirically not from a table** — intersect
   `leafMasks` pairwise; any two leaves in the same `all` group whose masks
   intersect to zero → *"`Installed` and `Not owned` can never both be true
   for the same game."* Fixes: remove either, or switch the group to ANY.
4. **Single culprit** from `trace.withoutThis` — exactly one child whose
   removal takes the group from 0 to N → *"Remove `Release date before 2015`
   and 214 games match."* One-tap fix.
5. **Combinator** — `ALL → 0` but `ANY → N`. Fix: `Switch to ANY (340 games)`.
6. `limit` is 0, or the whole match set was capped out.
7. `genuinely-empty` → *"Your rules are valid — no game in your library
   matches. Try relaxing a range."*

Every `Fix` is a pure `Tab → Tab`, so it is trivially testable and the UI is
`<Button onClick={() => setDraft(fix.apply(draft))}>`.

**Gamepad** — Pattern 5 for the tab strip, Pattern 4 for the grid
(`docs/gamepad-navigation-guide.md`). Tab strip: D-pad L/R between tabs,
Down into the grid, A launches, Y opens the tab menu, X opens the editor.
Rule tree: Up/Down between rows (each row one `useFocusable`), A opens
`RuleEditorSheet`. `Sheet.tsx` pushes a `pushBackInterceptor` returning
`true` so B closes the sheet and does *not* pop the plugin page; it
`setFocus`es the first control on open and restores focus on close.
Reordering always available via `Move up`/`Move down` — never drag-only.

**Mouse + keyboard (docked)** — TabMaster's broken path, so a first-class
constraint: every interactive element is a real `<button>`/`<input>` with a
visible `:focus-visible` ring so native Tab order works without spatial nav;
Escape closes sheets (as well as B); backdrop click closes; the combinator
is a `role="radiogroup"` operable with arrow keys; drag-to-reorder is an
*alternative* to the menu items, never the only path; 44 px minimum height
per `DESIGN.md`.

## Config durability

All of this lives in `backend.ts` + `lib/`, because `useConfigValue` is
unavailable to plugins.

```ts
// plugins/library-tabs/lib/config.ts  [iso]
export const LIBRARY_TABS_SCHEMA_VERSION = 1;
export interface LibraryTabsConfig {
  schemaVersion: number;
  tabs: Tab[];
  tabOrder: string[];            // ids not present are appended
  /** null = no override → first visible tab. Never requires hiding
   *  All Games (a declined TabMaster ask). */
  defaultTabId: string | null;
  hiddenBuiltinTabs: string[];
  gameOverrides: Record<string, { sortAs?: string; displayName?: string; hidden?: boolean }>;
  profiles: Array<{ id: string; label: string; appIds: string[]; tabIds: string[] }>;
  mirror: { autoSync: boolean; pendingSync: boolean; ledger: MirrorLedger };
  settings: {
    defaultTileWidth: number; showCounts: boolean;
    indeterminatePolicy: "pass" | "fail"; maxBackups: number;
    mirrorPrefix: string;        // "" by default — see open questions
  };
}
export function defaultConfig(): LibraryTabsConfig;
/** Returns [] when valid. Every message is user-facing. */
export function validateConfig(raw: unknown): string[];
/** Drops unparseable tabs rather than failing the whole load, and reports
 *  what it dropped so the UI can offer a restore. */
export function coerceConfig(raw: unknown): { config: LibraryTabsConfig; dropped: string[] };
```

- **Atomic writes only, always via
  `mutatePluginStorage("library-tabs", …)`** — it already does
  tmp + `randomUUID()` + `rename` and serialises concurrent
  read-modify-write per plugin id. Never call `writePluginStorage` from more
  than one path.
- **Never persist an invalid config.** `saveConfig` runs `validateConfig` and
  throws before writing. A validation failure is a bug we want loudly, not a
  corrupted file.
- **Migrations** (`lib/migrations.ts`): `MIGRATIONS: Record<number, Migration>`
  keyed by the version being migrated *from*; `migrate(raw)` returns
  `{config, fromVersion, applied, warnings}`. Ship v1 with an **empty** map
  and a test asserting `migrate(defaultConfig())` is a no-op, so the
  machinery is exercised from day one instead of written under pressure at v2.
- **Backups** (`lib/backups.ts`) in
  `~/.config/loadout/plugins/library-tabs.backups/`. Reasons:
  `pre-migration` · `pre-restore` · `pre-import` · `pre-unmirror` ·
  `manual` · `periodic`. Triggered before any migration, restore, import or
  `unmirrorAll`, plus on first successful load each calendar day.
  `maxBackups` default 20, oldest-first pruning that **always keeps the
  oldest `pre-migration` backup** regardless of age. Filenames sort
  lexically: `2026-07-30T09-14-22Z-v1-pre-migration.json`.
- **Restore is undoable** — restoring first writes a `pre-restore` backup.
  `BackupsPanel.tsx` lists each backup with timestamp, tab count, reason and
  an expandable tab-name preview, so users can identify the right one
  *without* restoring.
- **Export/import** (`lib/share.ts`): a `ShareEnvelope` with
  `kind: "loadout.library-tabs"`, base64url-encoded. Import runs through
  `migrate` + `validateConfig` first, **always adds rather than replaces**,
  always suffixes id and label collisions, always writes a `pre-import`
  backup, and lands imported tabs with `mirror.enabled: false`
  unconditionally — a shared tab must never silently rewrite the importer's
  Steam collections.

No new dependency for validation: the repo has no zod, and hand-rolled
narrowing keeps the bundle small and the messages user-facing.

## File layout

**Gate changes, as the first commit of Phase 1:** add
`plugins/library-tabs/lib` to `SPEC_SCOPED_LIB_DIRS` and
`packages/steam-appinfo/src` + `packages/game-metadata/src` to
`SPEC_SCOPED_PACKAGES` in `scripts/check-plugin-specs.sh`; add
`plugins/library-tabs` to `knip.ts` with
`entry: ["app.tsx","backend.ts","scripts/*.ts","**/*.{test,spec}.{ts,tsx}"]`
(the probe script would otherwise read as dead code — the same treatment
`plugins/recomp` gets).

**Hard constraint:** `app.tsx` is bundled for the CEF webview, so any `lib/`
module it imports must be **isomorphic** — no `node:*`, no
`@loadout/plugin-storage`, no `@loadout/steam-cdp`. Marked `[iso]` vs
`[backend]`. Every module is decomposed to stay individually testable, so
the ≥100 LOC ⇒ spec gate holds by construction.

```
plugins/library-tabs/
  package.json     # id "library-tabs", category "Steam", target overlay
                   # permissions.network ["localhost"]   (CDP via steam-cdp)
                   # permissions.filesystem
                   #   ["read:~/.local/share/Steam",
                   #    "write:~/.config/loadout/plugins",
                   #    "write:~/.cache/loadout/library-tabs"]
  backend.ts  + backend.test.ts
  app.tsx     + app.spec.tsx
  lib/
    types.ts        [iso] type-only, no spec required
    rules.ts        [iso] registry: kind -> {label, category, params, defaults, facts, predicate}
    evaluate.ts     [iso] Kleene logic, trace, leaf masks
    facts.ts        [iso] requiredFacts, buildEvalGames
    sort.ts         [iso] multi-key + sortAs/manual + overrides
    group.ts        [iso] GroupSpec -> groups
    summarize.ts    [iso] Rule -> plain English; Tab -> sentence
    diagnose.ts     [iso] Diagnosis + Fix
    templates.ts    [iso] builtin tabs + template gallery (TabMaster's Quick Tabs)
    mirror.ts       [iso] planMirror (pure)
    share.ts        [iso] export/import envelopes
    config.ts       [iso] types, defaults, validate, coerce
    migrations.ts   [iso]
    backups.ts      [backend]
    mirror-ledger.ts[backend]
    async-facts.ts  [backend]
    storage.ts      [backend] load/save orchestration + backup triggers
  components/
    TabStrip.tsx  TabGrid.tsx  SubTabStrip.tsx
    TabEditor.tsx  RuleBuilder.tsx  RuleGroupNode.tsx  RuleNodeRow.tsx
    RuleEditorSheet.tsx  RulePalette.tsx  ParamEditors.tsx
    TabDiagnostics.tsx  TabTemplates.tsx
    MirrorPanel.tsx  BackupsPanel.tsx  Sheet.tsx
  hooks/
    useLibraryData.ts    # snapshot + facts + libraryChanged/metadataChanged
    useEvaluatedTab.ts   # memoised evaluateTab + deferred trace
    useVisibleRows.ts    # row windowing for 1000+ tiles
  scripts/probe-steam-metadata.ts    # maintainer tool, Phase 1
  test/fixtures/library.ts           # ~40 GameMetadata records, shared

packages/steam-appinfo/src/       # NOT serverOnly
  reader.ts     ByteReader over Buffer: u8/u32/u64/cstr/seek/bounds
  framing.ts    magic v28/v29, universe, string-table offset + decode
  inner-kv.ts   inner binary KV, keyMode "inline" | "table"
  sections.ts   streaming section index + single-section read
  project.ts    raw section -> AppInfoRecord
  errors.ts     AppInfoFormatError w/ offset + hexdump context
  ../test/fixtures/build-fixture.ts   synthetic v28/v29 writer

packages/game-metadata/src/       # loadout.serverOnly: true
  providers/manifest.ts  providers/appstore.ts  providers/appinfo.ts
  merge.ts   cache.ts

apps/loadout/src/loader/services/game-metadata.ts
packages/types/src/game-metadata.ts
packages/steam-cdp/src/collections.ts
packages/game-library/src/index.ts       # additive: getCollectionDetails, honour `removed`
packages/game-library/src/index.test.ts  # NEW — currently untested
```

Every `lib/*.ts` gets a sibling `*.test.ts`; every non-trivial component a
`*.spec.tsx`.

## Test strategy

One shared fixture library (`test/fixtures/library.ts`, ~40 records covering
every sentinel, both `source` values, and a game in 3 collections) so counts
in assertions are stable and reviewable.

**Phase 1** — `evaluate.test.ts`: Kleene truth tables across all 3×3
combinations; `invert` preserves `indeterminate`; nesting to depth 4;
`withoutThis` matches a hand-computed removal; `leafMasks` align to input
order; empty `children` on `all` → true and on `any` → false (documented,
not accidental); `limit` applies after sort. `rules.test.ts`: every
predicate, `NumericRange` boundary inclusivity, `includeUnknown` gating the
`-1` sentinel, invalid regex → `indeterminate` not throw, `anyOf` vs `allOf`
on empty sets. `diagnose.test.ts`: each `Diagnosis.kind`; contradiction found
purely from disjoint leaf masks with no table entry; **every `Fix.apply`
produces a tab whose re-evaluation is non-empty**. Plus
`sort`/`summarize`/`config`/`migrations`/`backups`/`share`/`templates`
specs, `backend.test.ts` (RPC shape, `_`-prefixed helpers absent from the
surface, storage failure surfaces as a rejection not silent loss), and
component specs — notably `Sheet.spec.tsx` (Escape closes, backdrop closes,
`pushBackInterceptor` registered on open and disposed on close, focus
restored) and `RuleBuilder.spec.tsx` (combinator shows both `ALL → n` and
`ANY → m`).

**Phase 2** — `providers/appstore.test.ts`: snapshot written on success,
restored as `stale` on failure, `unavailable` with no prior snapshot, and a
garbage overview degrades one app rather than the whole read.
`merge.test.ts`: precedence per field, `contributors` accuracy, union
semantics. `services/game-metadata.test.ts`: manifest-only snapshot within
one tick with others `loading`; `metadataChanged` once per provider;
signature-compare suppresses no-op re-emits (mirroring
`game-library.test.ts`). Every new rule spec asserts **`indeterminate` when
the owning provider is unavailable, not `false`**.

**Phase 3** — `framing.test.ts` (v28/v29 magic, wrong magic →
`AppInfoFormatError` with observed bytes, string-table decode incl.
non-ASCII, truncated table); `inner-kv.test.ts` (both key modes, every type
byte, `0x09` alt terminator, unknown byte throws with offset);
`sections.test.ts` (chain validation detects a deliberately corrupted
`size`; resync recovers remaining sections); `project.test.ts`;
`providers/appinfo.test.ts` (cache hit skips both passes; unchanged
`changeNumber` re-projects nothing; a corrupt file yields `unavailable` and
never throws out of the service). All against synthetic fixtures, plus a
**hardware smoke test documented in the README** asserting the chain
validates for 100 % of sections in a real `appinfo.vdf`.

**Phase 4** — `mirror.test.ts`: table-driven over `planMirror` — create,
no-op, add-only, remove-only, rename, delete on tab removal, delete on
mirror-disable, conflict on an unledgered same-name collection, drift,
orphan, dynamic/non-editable collections never targeted, and no plan for a
collection absent from the ledger unless it's a `create` or `conflict`.
`collections.test.ts` mocks `_evaluateAsync` and asserts the emitted JS,
`SteamClientUnreachableError` on no-store, and exactly one `SaveCollection`
per `setApps`. `MirrorPanel.spec.tsx`: dry-run renders before any write;
conflict requires explicit consent; `unmirrorAll` requires typed confirmation.

**Phase 5** — `group.test.ts` (each `GroupFieldKey`; `maxGroups` collapses
the tail; overlapping `{kind:"rules"}` groups place a game in the **first**
match only, documented). `async-facts.test.ts`: a rejecting `callPlugin`
yields `unavailable` for every appId and never throws; TTL respected;
batching issues one call per resolver not one per game. Plus a perf
assertion: `evaluateTab` over 2000 games × 8 rules in <25 ms with
`trace: true`.

**Phase 6** — `handleGameLaunch` activates the matching profile,
`handleGameExit` restores; a profile referencing a deleted tab id is ignored,
not fatal.

## Verification

- `bun run test:backend` and `bun run test:ui` — both green.
- `bun run check:specs`, `bun run check:dead-code`, `bun run lint`,
  `bun run typecheck` — the gate change in Phase 1 commit 1 means specs are
  enforced from the start.
- `bun run dev:overlay`, open the plugin page, attach Chromium to
  `http://localhost:9222`. Verify: tab strip renders with counts; switching
  tabs is instant with no RPC; the builder's `ALL → n · ANY → m` line
  updates live; a deliberately contradictory tab (`Installed` +
  `Not owned` under ALL) renders `TabDiagnostics` with a one-tap fix, **not**
  a blank grid; Escape and backdrop-click both close a sheet.
- **On real hardware (Steam Deck, Gaming Mode)** — this is where the
  genuine unknowns are, and none of them can be checked on this dev machine:
  1. ~~Run `scripts/probe-steam-metadata.ts`, commit
     `docs/steam-metadata-probe.md`.~~ **Done 2026-07-30** — see the preamble
     for the four results that change the plan.
  2. Confirm `pushBackInterceptor` from a plugin React root — B closes the
     sheet without popping the plugin page. ~~**Gates the sheet-based editor
     UX.**~~ No longer a gate: `Select` already does this from five shipped
     plugins. Worth one look on hardware, not a blocker.
  3. Verify the mirror end to end: enable on one tab, "Sync now", confirm
     the collection appears in Steam's library with the right games; hand-edit
     it in Steam and confirm `drifted` is surfaced rather than clobbered;
     `unmirrorAll` removes exactly our collections.
  4. Load a 1000+ game library and confirm tab switching stays smooth and
     `useVisibleRows` caps mounted `GameCard`s.

## Risks and open questions

**appinfo.vdf format variance — highest risk.** The trailing 20-byte
`sha1Binary` in the per-section header is the field implementations most
often disagree on across v28/v29, and getting it wrong shifts every
subsequent section by 20 bytes.

> **Measured 2026-07-30 (v29): the header is 68 bytes and `sha1Binary` is
> present.** And the mitigation described next **does not work** — chain
> validation is blind to header size, because the next section sits at
> `offset + 8 + size` however many header fields follow `size`. It passes
> under every candidate layout, so it turns a format guess into false
> confidence rather than a measurement. `sections.ts` must validate **body
> framing**: the byte at `offset + headerSize` must be `0x00` (a nested object
> opens every body) and the section's last two bytes must be `0x08 0x08`. That
> distinguished 68 (1247/1247 sections) from 48, 60 and 40 (8, 5 and 2). Retry
> the alternate layout on *that* mismatch, not on a chain mismatch.

Original mitigation, retained for context: `sections.ts` **chain-validates**
(`offset + size` must land exactly on the next section's first byte) and, on
mismatch, retries with the alternate header layout — turning a format guess
into a runtime measurement. v29's string table means a v29 file read with
`keyMode:"inline"` produces garbage keys rather than an error, so
`project.ts` must assert `common` is present per section and fail the
provider loudly if not. A future v30 is inevitable: `framing.ts` returns
`{supported: false, magic}` for unknown magics and the provider goes
`unavailable` with *"Your Steam client uses a newer appinfo format (0x…)
that Loadout doesn't read yet."* Never crash, never guess.

**~~`appStore` overview field names are unverified.~~ Verified 2026-07-30.**
Every name in the Phase-2 list resolves. Four of them
(`steam_deck_compat_category`, `review_percentage`, `store_tag`,
`store_category`) are **prototype getters rather than own keys**, so they are
absent from `Object.keys` while reading perfectly — that absence, not a wrong
name, is what made them look unverified.

Keep the `pick(obj, key, fallback)` helper: it still earns its place against a
future Steam refactor, and `pick` must use `key in obj` / direct read rather
than an own-key check, or it will report every getter missing.

The live risk moved from *names* to **population**. `size_on_disk` carries a
value on 3% of the library, `rt_original_release_date` 3%,
`rt_steam_release_date` 15%. A field that reads without error and is unset for
most games is more dangerous than a wrong name, because nothing looks broken.
Source `sizeOnDisk` from `appmanifest_*.acf` and `releaseDate` from
`GetCanonicalReleaseDate()`.

**Collection-write reliability.** `collectionStore` is undocumented.
**`RemoveApps` exists** (measured 2026-07-30, alongside `AddApps`, `SetApps`,
`UpdateApps`, `Delete`), so `setApps` does a real replace-set and the
create-then-delete fallback — which would have lost the user's Steam sidebar
position — is not needed. Steam collections also sync to Steam Cloud, so
rewriting a 500-app
collection on every `libraryChanged` could hit rate limits or conflict
across machines; the debounce, the add/remove diff, and the 60 s floor are
the mitigation. Two machines mirroring the same tab will fight — the ledger
is per-machine; out of scope for v1, document it, detect it via `drifted`.

**Library-scale performance.** Evaluation is not the bottleneck (<25 ms
target); **rendering is**. 2000 `GameCard`s with 2000 image requests will
stall CEF and `GameCardGrid` has no virtualisation. Mitigation:
`hooks/useVisibleRows.ts` (row windowing, no new dependency) plus the
existing intersection-gated art loading. Assert a render budget in
`app.spec.tsx` by counting mounted `GameCard`s for a 2000-game fixture. A
3000-game snapshot is ~1.2 MB of JSON per `getSnapshot()` — within Bun's
16 MB WS default, but it must be fetched **once** per snapshot and
invalidated by event, never polled; `useLibraryData` owns that discipline.
*Open question:* check `apps/loadout/src/loader/rpc-handler.ts` before
Phase 2 for anything pathological with a 1.2 MB response (e.g. structured
logging of the payload).

**Cross-plugin fact sources.** Facts from `hltb` / `protondb-badges` mean
tab contents silently change when those plugins are disabled. `callPlugin`
is optional (`packages/types/src/plugin.ts:155`), so a disabled target must
resolve to `{state:"unavailable", reason:"The How Long To Beat plugin is
disabled."}` — which diagnostics then surface. Test this explicitly; it is
the exact bug class that made TabMaster's tabs mysteriously empty.

**Open question — should mirrored collections carry a name prefix?** The
plan says no (ledger-based identity, clean native names), but a prefix makes
"which of these did Loadout make?" answerable inside Steam's own UI. Shipping
`mirrorPrefix: ""` as an exposed setting, to revisit after the first bug
report about a mystery collection.
