# Collections

Custom, filter-driven tabs for your Steam library — a successor to the
Decky plugin [TabMaster](https://github.com/Tormak9970/TabMaster), built on
Loadout's overlay rather than by patching Steam's library UI.

## What it does

Build tabs from a rule tree in Loadout's overlay; each tab is kept in step
with a real Steam collection, so it shows up in Steam's own library too.

Shipped: the tabbed browser with live match counts and a windowed tile grid
that stays responsive on a 4000-game library; the rule builder, reached from
"Edit rules" on any non-builtin tab; tab management (rename, reorder, hide,
delete, template gallery); and Steam collection sync, which Settings turns on
once and which then follows every later edit. The dry run stays reachable,
because it is the only way to see a deletion before it happens.

The library is the full one, not just what is installed — reading Steam's own
`appTypeCollectionMap` and `appStore` getters took this from ~2000 games to
4358 on the development device. ROMs are classified from Steam ROM Manager's
`srm-` collections so they can be excluded rather than clogging every tab.

Not built: a backups panel and a share-code import/export UI (both backend
surfaces exist and are tested; nothing renders them), profiles, and a home
widget. Deliberately absent: drag-to-reorder — Move left / Move right cover it
and always will, since drag is unusable with a gamepad.

## Why not patch Steam's library, like TabMaster does?

TabMaster's `patchLibrary` hot-swaps React's internal `useMemo` dispatcher
inside Steam's own bundle and mines the surrounding closure by positional
dependency index (`deps[7]`). It works, and it is the reason the plugin
breaks every time Valve reshuffles that component.

The failure mode is what makes this disqualifying rather than merely
annoying: when the patch throws, **Steam's library becomes unreachable**.
Users report rebooting ~19 times, and being locked out of Decky itself so
they cannot even uninstall the plugin that broke them. Fixes then lag the
Decky store by 5–44 days, so the standing advice is "sideload a zip" or
"switch to the Testing channel" — which the affected users can't follow.

Loadout's overlay is its own X11/CEF window layered over Gamescope. Nothing
we render can take Steam's library down. We get the single biggest
robustness win for free, by construction, and pay for it only in that our
tabs live in the overlay rather than in Steam's own tab strip.

Mirroring closes most of that gap: each tab is kept in a **real Steam
collection** over CDP, so it appears in Steam's own library with no patching.

We did try the other half, and reverted it. Steam builds its library tab bar
inline in a `useMemo` and returns it as `rgTabs` — no store, no extension
point — so the only way in is to patch that module. It was implemented via
source patching (sturdier than TabMaster's render-time dispatcher swap: a
failed patch leaves Steam rendering stock rather than dying mid-render) and
verified applying on-device. The tabs still never rendered, most likely
webpack's module cache, though that was never proven. Three separate injector
defects sat between a correct patch and a rendered tab. The injector fixes
were kept; collections is the sturdier half and is what ships.

## Architecture

```
lib/types.ts      the data model — Rule, Tab, EvalGame, Verdict (type-only)
lib/facts.ts      GameMetadata[] + prefetched facts -> EvalGame[]
lib/rules.ts      the registry: one entry per rule kind, with its predicate
lib/rule-tree.ts  pure structural edits — insert, move, wrap, duplicate
lib/rule-params.ts  per-kind defaults + the descriptors the editors render
lib/sort.ts       multi-key sort, unknown-last, stable total order
lib/group.ts      GroupSpec -> sub-tabs / sections
lib/evaluate.ts   Kleene tree walk, trace, leaf masks, cap
lib/summarize.ts  rules -> plain English
lib/diagnose.ts   why is this tab empty, and what one tap fixes it
lib/templates.ts  builtin tabs + the template gallery
lib/adapt.ts      manifest + playtime sources -> GameMetadata
lib/merge-appstore.ts  merges Steam's live library over the manifest scan
lib/windowing.ts  which rows of the tile grid are worth mounting
lib/mirror.ts     pure planner: what a Steam sync *would* do
lib/mirror-apply.ts  executes a plan against injected effects
lib/config.ts     schema, defaults, validation, salvage
lib/migrations.ts versioned upgrades (empty at v1, deliberately)
lib/share.ts      export/import as a paste-anywhere code
lib/backups.ts    [backend] timestamped history
lib/storage.ts    [backend] load/save sequencing
```

Three ideas carry the whole design.

### 1. Three-valued logic

A rule returns `true | false | "indeterminate"`, not `boolean`.
`"indeterminate"` means *this rule's data source could not answer* — a cold
cache, a disabled plugin, a field Steam never filled in — which is a
genuinely different thing from "no".

TabMaster conflates them, and that is the direct cause of its most-reported
UX bug: its achievements filter returns `false` when Steam's achievement
cache is cold, so games silently vanish with nothing to distinguish a wrong
rule from a missing data source. Here, combination follows Kleene's strong
logic, inversion **preserves** `"indeterminate"` (because "not
(couldn't check)" is still "couldn't check"), and `Tab.indeterminatePolicy`
defaults to `"pass"` so a broken source degrades a tab instead of emptying it.

### 2. Async facts, synchronous evaluation

TabMaster's filter signature is `(params, appOverview) => boolean`, with
nowhere to `await`. Its maintainers cite this to refuse essentially the
entire feature backlog: sub-tabs, live player counts, ProtonDB, HowLongToBeat,
install paths, friends-playing-now.

Here, anything needing I/O is a **fact**: batch-resolved over the whole
library outside the evaluator, cached, and materialised onto
`EvalGame.facts` before a synchronous pass. A tab renders immediately with
facts in `loading` state and refines when `factsUpdated` arrives. A slow
ProtonDB fetch delays nothing and empties nothing.

### 3. The trace is the product

`EvalResult.trace` is not diagnostics bolted on afterwards. One traced
evaluation yields:

- per-rule match counts, for the badge on every builder row;
- both combinator outcomes, for the `ALL → 0 · ANY → 340` consequence line
  that makes the AND/OR mistake unmakeable (TabMaster's #1 support burden —
  its maintainer conceded in #333 that "merge groups aren't the most
  intuitive way to do this");
- `withoutThis` leave-one-out counts, so an empty tab can say *"remove
  `Release date before 2015` and 214 games match"* with a one-tap fix;
- per-leaf bitmasks, so contradictory rule pairs are found **empirically**
  by intersecting masks rather than from a hardcoded table of combinations
  someone thought of in advance.

Tracing roughly triples evaluation cost, so it is off on the render path and
on only while the tab editor is open.

## Conventions worth knowing before editing

- **`lib/` must stay isomorphic.** `app.tsx` is bundled for the CEF webview,
  so no `node:*`, no `@loadout/plugin-storage`, no `@loadout/steam-cdp` in
  any module the UI imports. Backend-only modules will be marked as such.
- **Numeric `-1` always means unknown**, never `0` and never `undefined`.
  `lastPlayed`/`playtimeMinutes` additionally use `0` for *provably* never,
  which is a real answer and matches normally. Don't collapse the two.
- **Every `lib/*.ts` needs a sibling `*.test.ts`** — `plugins/collections/lib`
  is in `SPEC_SCOPED_LIB_DIRS` in `scripts/check-plugin-specs.sh`, on
  purpose, from the first commit.
- **Shared fixture.** `test/fixtures/library.ts` holds ten records covering
  every sentinel state, both sources, multi-genre and no-genre games. Use
  it rather than inventing inline literals, so asserted counts stay
  reviewable.
- **Only use Tailwind classes the shell's stylesheet already defines.** The
  overlay's CSS is generated at *its* build time from *its* sources; plugins
  are compiled at runtime, so a utility that no shell or existing-plugin file
  already uses simply does not exist and the class silently does nothing.
  Measured on hardware: `max-h-[85vh]`, `rounded-t-2xl`, `border-l-base-300`,
  `ring-primary` and every `focus-visible:*` variant were all absent, while
  `max-w-2xl`, `ring-2` and `ring-primary/60` were present. This is not
  theoretical — an uncapped `max-h` is what made the rule palette taller than
  a Steam Deck screen. For anything novel use an inline `style`, and check a
  suspect class on-device with
  `getComputedStyle(document.body.appendChild(Object.assign(document.createElement("div"), { className: "the-class" })))`.
- **No modals.** Loadout is already an overlay over Steam, so a dialog is a
  modal on top of a modal — and in desktop mode, where the overlay is an
  ordinary window, a centred sheet with its own scrim reads as a bug. Sub-views
  are pages (`components/BuilderPage.tsx`), which also inherit the plugin's
  scroll box instead of fighting it with `position: fixed` inside the shell's
  zoomed subtree.
- **Don't add `@loadout/ui` exports** for this plugin's components. A new
  SDK export requires a full overlay rebuild + reinstall; in-plugin
  components don't. Build `components/TabStrip.tsx` locally rather than
  extending the shared `TabBar` (which has no counts, overflow scroll, or
  reorder anyway).

## Testing

```sh
bun test plugins/collections --isolate     # this plugin
bun run typecheck && sh scripts/check-plugin-specs.sh && bun run check:dead-code
```

UI specs need the happy-dom preload, so use the repo scripts for those:

```sh
bun run test:backend    # *.test.ts
bun run test:ui         # *.spec.tsx
```

Three tiers, because unit tests over a fixture are exactly what hid this
plugin's worst bug — 545 of them passed while 22 of 32 rule kinds had no data
behind them.

```sh
bun run test             # CI: no hardware, no corpus
bun run test:corpus      # needs a captured library
bun run test:live        # needs Steam running
bun run test:live:write  # Tier C — writes to your real Steam collections
```

`bun run capture:corpus` writes a corpus to
`~/.cache/loadout/collections-corpus.ndjson` (override with
`COLLECTIONS_CORPUS`). It is a dump of a real library and is **never
committed**; `docs/library-corpus-profile.md` records aggregate population
stats only. Corpus tests assert on the evaluation *trace*, not the match list
— a rule with `indeterminate === N` matches everything under the `"pass"`
policy while looking perfectly healthy — and carry a ratchet of known-broken
rules with expiry dates, so entries can only shrink. A missing corpus throws
rather than skipping: it skipped silently once, and the ratchet sat dead and
green for two hours before anyone noticed.

`test:live:write` creates and deletes real collections on the signed-in
account, and Steam Cloud syncs them elsewhere before cleanup runs. Read the
risk register at the top of `live/mirror-roundtrip.live.spec.ts` first.

Only `bun run test` runs in CI. The other three are deliberate, on hardware.

## Where the Steam data comes from

`scripts/probe-steam-metadata.ts` dumps the real shapes to
`docs/steam-metadata-probe.md`; it has been run on hardware (2497 apps, Steam
CEF 126, `appinfo.vdf` v29) and the results are committed. Two things it
settled that had been guessed: `appStore`'s useful fields are prototype
getters, invisible to `Object.keys`, and `steam_deck_compat_category` returns a
decoded `1|2|3` where the own key returns a packed value.

`scripts/capture-library-corpus.ts` captures through the *same code path the
plugin uses*, so the corpus cannot drift from what the plugin sees.
