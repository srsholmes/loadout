# Library Tabs

Custom, filter-driven tabs for your Steam library — a successor to the
Decky plugin [TabMaster](https://github.com/Tormak9970/TabMaster), built on
Loadout's overlay rather than by patching Steam's library UI.

## Status

**Phase 1 in progress.** The rule engine (`lib/`) is complete and fully
specced. The UI (`app.tsx`, `components/`), the backend (`backend.ts`) and
the config layer are not yet written.

| Phase | Scope | State |
|---|---|---|
| 1 | Tabbed browser, Phase-1 rules, config durability, hardware probe | engine done, UI pending |
| 2 | Ownership + `appStore` metadata over CDP | not started |
| 3 | `appinfo.vdf` offline metadata (`packages/steam-appinfo`) | not started |
| 4 | Steam Collection mirror | not started |
| 5 | Sub-tabs, async facts, presentation | types in place, resolvers pending |
| 6 | Profiles, sharing, home widget | not started |

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
tabs live in the overlay rather than in Steam's own tab strip. Phase 4
closes most of that gap by mirroring each tab into a **real Steam
collection** over CDP — native-looking organisation, still zero patching.

## Architecture

```
lib/types.ts      the data model — Rule, Tab, EvalGame, Verdict (type-only)
lib/facts.ts      GameMetadata[] + prefetched facts -> EvalGame[]
lib/rules.ts      the registry: one entry per rule kind, with its predicate
lib/sort.ts       multi-key sort, unknown-last, stable total order
lib/group.ts      GroupSpec -> sub-tabs / sections
lib/evaluate.ts   Kleene tree walk, trace, leaf masks, cap
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
- **Every `lib/*.ts` needs a sibling `*.test.ts`** — `plugins/library-tabs/lib`
  is in `SPEC_SCOPED_LIB_DIRS` in `scripts/check-plugin-specs.sh`, on
  purpose, from the first commit.
- **Shared fixture.** `test/fixtures/library.ts` holds ten records covering
  every sentinel state, both sources, multi-genre and no-genre games. Use
  it rather than inventing inline literals, so asserted counts stay
  reviewable.
- **Don't add `@loadout/ui` exports** for this plugin's components. A new
  SDK export requires a full overlay rebuild + reinstall; in-plugin
  components don't. Build `components/TabStrip.tsx` locally rather than
  extending the shared `TabBar` (which has no counts, overflow scroll, or
  reorder anyway).

## Testing

```sh
bun test plugins/library-tabs --isolate     # this plugin
bun run typecheck && sh scripts/check-plugin-specs.sh && bun run check:dead-code
```

Note that `bun run test:backend` reports ~423 failures on macOS across the
whole repo. Those are pre-existing and unrelated — Loadout targets Linux and
many plugin specs touch sysfs, `/run/media` and systemd. Verify against that
baseline rather than expecting zero.

## Hardware gate

`scripts/probe-steam-metadata.ts` (Phase 1, not yet written) must be run on
a real Steam Deck before Phases 2–4 begin. There is no Steam install on a
macOS dev machine, so the `appStore` overview field names and
`appinfo.vdf`'s byte layout are currently **inferred from TabMaster's
source, not verified**. The probe dumps the real shapes to
`docs/steam-metadata-probe.md`.
