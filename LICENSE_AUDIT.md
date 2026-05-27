# Plugin License Audit

> **Status**: pre-release engineering due diligence. Not legal advice. A licensed
> attorney should clear any GPL question before public distribution.
>
> **Audit date**: 2026-04-29 (commit `3a7b30d`)
> **Last updated**: 2026-05-08 (re-run after PR #76 merged: `css-loader` renamed to `theme-loader` and bundled snapshot + scrape script removed; new `disable-controller-input` and `input-plumber` plugins folded into LOW; `input-plumber` LICENSE + NOTICE shipped this pass)

---

## 1. Executive summary

27 plugins under `plugins/` were audited against the licenses of the Decky
Loader plugins they replicate or were ported from. Provenance was established
from three independent sources: the source code itself (comments / structure /
data tables), commit messages, and PR descriptions (PR #13, #27, #44, #46, #58
were the key historical records).

After stage-1 remediation the working tree contained **25 plugins**
(was 27). `mangopeel` was renamed to `mangohud-tweaks`; `emudeck` and
`steam-tweaks` were removed.

The 2026-05-08 re-audit pass folded in three further changes:

- `css-loader` was renamed to `theme-loader` and the bundled
  community-themes snapshot was deleted in favour of a live
  `api.deckthemes.com` fetch (PR #76, merged into `main`). The
  CRITICAL row below points at the new path.
- Two new plugins, `disable-controller-input` (PR #72) and
  `input-plumber` (PR #74), are LOW-risk additions classified below.
  `input-plumber` had its `LICENSE` + `NOTICE` shipped during this
  re-audit; `disable-controller-input` already had `LICENSE` from PR
  #72 and is original code with no `NOTICE` requirement.

Working tree now contains **27 plugins** under `plugins/`.

### Risk distribution

| Risk | Plugins | Status |
|---|---|---|
| **CRITICAL** | ~~`css-loader`~~ → ~~`theme-loader`~~ | ✅ resolved — PR #76 merged. Plugin renamed to `theme-loader` to differentiate from upstream's CSS Loader. The community theme directory is no longer bundled at all: fetched live from `api.deckthemes.com/themes` and cached under `~/.cache/steam-loader/theme-loader/`. Class translations still fetched from `api.deckthemes.com/stable.json`. Thumbnails hotlinked, not bundled. `scripts/scrape-css-themes.ts` deleted. LICENSE + NOTICE shipped. |
| **HIGH (release-removed)** | `apex-fixes` (kernel artifacts only) | 🗑 **plugin will be removed from `plugins/` before the public release** — no GPL-2 obligations to handle in this repo, no extraction work. The plugin currently lives in tree for development convenience and is DMI-guarded so it's a no-op on non-APEX hardware. Replaces the prior "extract to its own repo" plan. |
| **MEDIUM** | ~~`audio-loader`~~ → `sound-loader`, `launch-options`, `mangohud-tweaks` (renamed from `mangopeel`) | ✅ done — LICENSE + NOTICE. `audio-loader` renamed to `sound-loader` and switched to live `api.deckthemes.com/themes/legacy/audio` consumption (parallel to PR #76 for theme-loader). |
| **MEDIUM** | `flatpak-manager`, `protondb-badges` | ✅ done — LICENSE + NOTICE |
| **MEDIUM** | `lsfg-vk` | ✅ done — LICENSE + NOTICE; PancakeTAS upstream verified GPL-3.0 (runtime fetch, not redistributed); NOTICE shipped on PR #60 |
| **MEDIUM (removed)** | ~~`emudeck`~~ | ✅ removed |
| **LOW** | `bluetooth`, `fan-control`, `battery-tracker`, `network-info`, `playtime`, `hltb`, `display-settings`, `game-browser`, `music-player`, `rgb-control`, `steamgriddb`, `storage-cleaner`, `tdp-control` | ✅ done — LICENSE added |
| **LOW** | `disable-controller-input` (added PR #72) | ✅ done — LICENSE; original code talking to InputPlumber's public DBus API. No upstream code reused; NOTICE not required. |
| **LOW** | `input-plumber` (added PR #74) | ✅ done — LICENSE + NOTICE shipped 2026-05-08. Original installer wrapper; downloads upstream InputPlumber GPL-3.0 release tarball at the user's request, does not bundle or redistribute. |
| **NONE** | `audio-mixer`, `steam-gamescope-ipc` | ✅ done — LICENSE added |
| **NONE** | `browser` | ✅ done — LICENSE + NOTICE; Electrobun MIT seeded into `THIRD_PARTY_LICENSES.md` |
| **NONE** | `handy-dictation` | ✅ done — LICENSE + NOTICE; Handy verified MIT (CJ Pais 2025), runtime-fetched not redistributed |
| **NONE (removed)** | ~~`steam-tweaks`~~ | ✅ removed |

### Top three concerns

1. ~~**`css-loader` ships `plugins/css-loader/lib/css-translations.json`**~~ —
   ✅ resolved by PR #76. The plugin was renamed `theme-loader`, the
   bundled translations file was already removed in stage 5; PR #76
   then deleted the bundled `community-themes.json` snapshot and the
   `scripts/scrape-css-themes.ts` build-time scraper. Both the
   translations and the community theme directory are now fetched
   live from `api.deckthemes.com` at runtime, cached on the user's
   machine, and never redistributed. Provenance comments referencing
   upstream Python file names were rewritten in the prior stage.

2. ~~**`apex-fixes` ships kernel-space artifacts**~~ — 🗑 release-removed.
   `apex-fixes` will be deprecated and removed from this repository
   before the public release; the user has confirmed no release will
   ship with the plugin still in tree. The GPL-2 obligations the
   prior audit flagged (on `kernel-modules/*/oxpec.ko` and
   `kernel-patches/hid-oxp/*.patch`) therefore never trigger for this
   repo — no public distribution of those artifacts will occur from
   here. The plugin remains DMI-guarded and only active on APEX
   hardware in the meantime. Original analysis preserved in §3 below
   for posterity.

3. **No project-wide LICENSE file.** Without one, the project has no declared
   terms. Contributors and downstream users have no rights to copy, modify,
   or redistribute the source. This blocks open-source release entirely
   regardless of the per-plugin findings.

### Ship-blockers (must fix before release)

- [x] Add a top-level `LICENSE` to the repo. **Done — BSD-3-Clause.**
- [x] Seed `THIRD_PARTY_LICENSES.md` at repo root. **Done — Electrobun MIT +
      Handy MIT verbatim, plus a credit table for all NOTICE-bearing plugins.**
- [x] Add a root `NOTICE` index. **Done in stage 4.**
- [x] Resolve the `css-loader` `css-translations.json` bundling. **Done —
      removed from tree; fetched at runtime from `api.deckthemes.com` into
      `~/.cache/steam-loader/theme-loader/`. PR #76 then deleted the
      bundled `community-themes.json` and the
      `scripts/scrape-css-themes.ts` scraper, switching the community
      directory to a live API fetch as well. Bundled `screenshots/`
      removed; UI hotlinks thumbnails from the upstream CDN. Plugin
      renamed `css-loader` → `theme-loader` in the same PR.**
- [x] ~~Add a `COPYING` and source-offer for the kernel artifacts in
      `apex-fixes`.~~ **Removed from the ship-blocker list — `apex-fixes`
      will be deprecated and deleted from this repo before the public
      release, so no kernel artifacts ever ship from here. Nothing to
      land in this repository for compliance purposes.**

---

## 1.5 Progress

Tracking what's shipped vs outstanding.

### ✅ Done — stage 1 (commit `087b0e6`)

| Plugin | Action |
|---|---|
| `audio-loader` (now `sound-loader`) | Added BSD-3-Clause `LICENSE` + `NOTICE` crediting SDH-AudioLoader. Plugin later renamed to `sound-loader` and switched from a bundled `community-packs.json` snapshot to live consumption of `api.deckthemes.com/themes/legacy/audio` (parallel to PR #76 for theme-loader). |
| `launch-options` | Added BSD-3-Clause `LICENSE` + `NOTICE` crediting Wurielle/decky-launch-options. |
| `mangohud-tweaks` | Renamed from `mangopeel` (avoids collision with Gawah/MangoPeel). Added BSD-3-Clause `LICENSE` + `NOTICE`. Inline courtesy attribution in `backend.ts`. |
| `emudeck` | **Removed** — upstream EmuDecky is AGPL-3.0; reimplement later if needed. |
| `steam-tweaks` | **Removed** — was an internal demo plugin per `plugin.json`. |

### ✅ Done — stage 2 (project-wide BSD-3 rollout)

| Scope | Action |
|---|---|
| repo root | Added `LICENSE` (BSD-3-Clause, Copyright © 2026 Simon Holmes). |
| 20 plugins | Added BSD-3-Clause `LICENSE` to: `audio-mixer`, `battery-tracker`, `bluetooth`, `browser`, `handy-dictation`, `display-settings`, `fan-control`, `flatpak-manager`, `game-browser`, `hltb`, `lsfg-vk`, `music-player`, `network-info`, `playtime`, `protondb-badges`, `rgb-control`, `steam-gamescope-ipc`, `steamgriddb`, `storage-cleaner`, `tdp-control`. |

After stage 2: 23 of 25 plugins have a `LICENSE` file. The two without
(`css-loader`, `apex-fixes`) are intentionally held back — their license
choice depends on the deferred remediation paths (see §3). _2026-05-08
update_: `css-loader` resolved on stage 6 (renamed to `theme-loader` with
LICENSE + NOTICE shipped via PR #76). `apex-fixes` is now scheduled
for **deprecation and removal from this repo before public release**
— the prior "extract to its own repo" plan is dropped. No GPL-2
kernel artifacts will ship from this repository.

### ✅ Done — stage 3 (deferred-NOTICE follow-ups)

| Scope | Action |
|---|---|
| `flatpak-manager` | Added `NOTICE` crediting jurassicplayer/decky-autoflatpaks (BSD-3). |
| `protondb-badges` | Added `NOTICE` crediting OMGDuke/protondb-decky (dual GPL-3 / BSD-3, electing BSD-3 arm). |
| `browser` | Added `NOTICE` for the Electrobun multitab-browser template (MIT). |
| repo root | Seeded `THIRD_PARTY_LICENSES.md` with Electrobun MIT verbatim + credit table for all NOTICE-bearing plugins. |

### ✅ Done — stage 4 (root index + Handy + apex-fixes extraction plan)

| Scope | Action |
|---|---|
| `handy-dictation` | Verified Handy is MIT (CJ Pais, 2025). Added `NOTICE` clarifying that Handy is fetched at runtime from the upstream's GitHub Releases and is not redistributed by this repo. Added Handy MIT verbatim to `THIRD_PARTY_LICENSES.md`. |
| repo root | Added `NOTICE` — one-page pointer index of per-plugin NOTICE files + open-attribution items, with reference to `THIRD_PARTY_LICENSES.md`. |
| `apex-fixes` | Added `plugins/apex-fixes/TODO.md` recording the plan to extract this plugin to its own repository (`srsholmes/steam-loader-apex-fixes` or similar). The GPL-2 kernel-module / kernel-patch handling moves to that repo's lifecycle, not this one's. |

### ✅ Done — stage 5 (lsfg-vk; landing on PR #60)

| Scope | Action |
|---|---|
| `lsfg-vk` | Added `NOTICE` crediting both upstreams: ported install/configure flow from xXJSONDeruloXx/decky-lsfg-vk (BSD-3-Clause), plus runtime download of `lsfg-vk_noui.zip` from PancakeTAS/lsfg-vk (verified GPL-3.0; runtime fetch, not redistributed). Added decky-lsfg-vk BSD-3 verbatim and the PancakeTAS GPL-3 link to `THIRD_PARTY_LICENSES.md`. **Correction vs. original audit**: the upstream lsfg-vk runtime is GPL-3.0, not MIT (the decky-lsfg-vk LICENSE file's third-party section is stale on this point). |
| repo root | Updated `NOTICE` index and `THIRD_PARTY_LICENSES.md` to reflect lsfg-vk's two-upstream story. |

### ✅ Done — stage 6 (theme-loader rename + new-plugin re-audit, 2026-05-08)

| Scope | Action |
|---|---|
| `theme-loader` (was `css-loader`) | Plugin renamed end-to-end (id, dir, package name, RPC namespace, log prefixes, cache dirs, CSS `<style>` element IDs, cross-repo refs in `THIRD_PARTY_LICENSES.md`, `docs/architecture.md`, `packages/loader/src/auth.spec.ts`, `site/src/data/plugins.ts`, `scripts/capture-screenshots.py`, `tools/css-theme-verifier`). Plugin `LICENSE` + `NOTICE` carried across the rename. Landed via PR #76. |
| `theme-loader` registry | The bundled `community-themes.json` (~4 MB) was deleted along with `scripts/scrape-css-themes.ts`. The Community tab now consumes `api.deckthemes.com/themes` live, with a 24h stale-while-revalidate cache mirroring the existing translations cache. `NOTICE` rewritten to describe the live-API path; `THIRD_PARTY_LICENSES.md` updated likewise. |
| `disable-controller-input` (added PR #72) | Verified original work — `LICENSE` (BSD-3) shipped on PR #72; communicates with InputPlumber over its public DBus surface only. No upstream code reused; `NOTICE` not required. Risk classification: **LOW**. |
| `input-plumber` (added PR #74) | Verified original installer wrapper. Added `LICENSE` (BSD-3) and `NOTICE` in this re-audit pass. The plugin downloads upstream InputPlumber (GPL-3.0-or-later by ShadowBlip) directly from its GitHub release on the user's machine at the user's request — InputPlumber is not bundled, vendored, or redistributed. The `NOTICE` documents the libiio runtime stage (BSD-3 by Analog Devices) for completeness. Risk classification: **LOW**. |

### ⏸ Deferred — to be tackled in a later stage

| Plugin | Risk | What's left | Reason |
|---|---|---|---|
| ~~`css-loader`~~ → `theme-loader` | ✅ resolved on stage 6 (PR #76). | — | — |
| `apex-fixes` | HIGH (release-removed) | delete the plugin before release | The plugin will be deprecated and removed from this repo before any public release ships; the prior "extract to own repo" plan is dropped. No GPL-2 artifacts ever distribute from here, so nothing to land in this repo for compliance. `plugins/apex-fixes/TODO.md` should be updated to reflect the deprecation outcome rather than the extraction plan. |

### ⏳ Outstanding — project-root files

- [x] `LICENSE` at repo root (BSD-3-Clause). **Done in stage 2.**
- [x] `THIRD_PARTY_LICENSES.md` — seeded in stage 3 (Electrobun MIT),
      extended in stage 4 (Handy MIT), stage 5 (decky-lsfg-vk BSD-3 +
      PancakeTAS/lsfg-vk GPL-3 reference), and stage 6 (path retargeted
      from `plugins/css-loader` to `plugins/theme-loader` and the
      interop note rewritten for live-API consumption).
- [x] `NOTICE` at repo root — one-page pointer index. **Done in stage 4.**
- [ ] Separate runtime/build dependency licensing audit (Bun, Electrobun/CEF,
      daisyUI, all npm + Cargo deps) — out of scope for this report.

---

## 2. Methodology

For every plugin we asked four questions:

1. **Is there a Decky upstream this plugin replicates or was ported from?**
   Established from PR descriptions, commit messages, code comments, and
   repository naming.
2. **What license does that upstream carry?** Verified against the LICENSE
   file on the upstream's default branch (URLs in §6).
3. **What artifacts (code, data, identifiers, structures) appear in our tree
   that demonstrably came from that upstream?** Established by `grep` for
   distinctive identifiers, by reading the relevant files, and by examining
   any vendored content (`kernel-modules/`, `kernel-patches/`,
   `css-translations.json`).
4. **Given the answers above, what would a reasonable engineer recommend?**
   Risk classified per the rubric in the original plan; remediation drafted
   per finding.

We did **not** clone upstream repositories for line-level diffs. The provenance
signals already in our codebase — explicit attribution comments, PR descriptions
that name the plugin being replaced, and bundled artifacts — were sufficient
to classify each plugin without a verbatim diff. Any uncertain case is flagged
as MEDIUM rather than guessed at.

We are not lawyers. The risk classifications express engineering judgment
about how copyright likely applies; they are not opinions on litigation
exposure. Edge cases (e.g. whether obfuscated CSS class-name maps are
"copyrightable as a compilation") are flagged as Open Questions in §6.

### What we relied on

- `git log --all` for plugin introduction history
- `gh pr view` for PR descriptions: #6, #13, #27, #28, #37, #44, #46, #54, #56,
  #57, #58, #59 (key ones quoted below)
- Code reads of `plugins/*/backend.ts`, `plugins/*/app.tsx`, `plugins/*/lib/`,
  `plugins/css-loader/lib/css-translations.json`,
  `plugins/apex-fixes/kernel-modules/README.md`,
  `plugins/apex-fixes/kernel-patches/hid-oxp/`,
  `scripts/refresh-css-translations.sh`
- WebFetch of LICENSE files from each upstream's `main` (or `master`) branch
- `grep -rEn -i 'decky|deckthemes|SDH|...'` across `plugins/` and `packages/`
  for fingerprint identifiers — full results captured during audit
- Confirmed: **no plugin imports `decky-frontend-lib` or `@decky/*`** (negative
  result from grep across the tree)

---

## 3. Per-plugin findings

Findings ordered by risk (CRITICAL first). Each block follows the evidence-record
shape from the audit plan.

---

### CRITICAL

#### `plugins/css-loader` → `plugins/theme-loader` ✅ resolved

**Resolution (2026-05-08, finalised on PR #76)**: Applied option 1
(don't bundle, fetch at runtime) plus per-theme attribution, then
renamed the plugin end-to-end to `theme-loader` to differentiate
from upstream's CSS Loader. Four artifacts addressed:

- `lib/css-translations.json` — **deleted from tree**. Fetched at
  runtime from `api.deckthemes.com/stable.json` by
  `lib/translations-cache.ts` and cached under
  `~/.cache/steam-loader/theme-loader/`. Pack-kind theme apply blocks
  until the first sync succeeds.
- `screenshots/` — **deleted from tree** (was 6.6 MB of author-uploaded
  artwork). The UI hotlinks `https://api.deckthemes.com/blobs/{id}`
  directly the way any browser viewing deckthemes.com does.
- `community-themes.json` — **deleted from tree** (PR #76); the registry
  is fetched live from `https://api.deckthemes.com/themes`, cached for
  24h under `~/.cache/steam-loader/theme-loader/community-themes.json`
  (per-user, not redistributed). Stale-while-revalidate so the UI
  renders the cached list while the background refresh is in flight.
  `scripts/scrape-css-themes.ts` (the build-time scraper) was deleted
  in the same PR.
- `LICENSE` (BSD-3-Clause) and `NOTICE` ship at
  `plugins/theme-loader/LICENSE` and `plugins/theme-loader/NOTICE`. The
  `NOTICE` was rewritten on PR #76 to describe live-API consumption
  (replacing the bundled-snapshot description).

Plugin rename ripple (PR #76):

- Directory `plugins/css-loader/` → `plugins/theme-loader/`.
- Plugin id, package name, RPC namespace (`useBackend("theme-loader")`),
  log prefixes, CSS `<style>` element IDs / dataset attribute, cache
  dir paths.
- Cross-repo refs in `THIRD_PARTY_LICENSES.md`,
  `docs/architecture.md`, `packages/loader/src/auth.spec.ts`,
  `site/src/data/plugins.ts`, `scripts/capture-screenshots.py`, and
  `tools/css-theme-verifier/`.

Per-theme attribution kept: install path preserves any upstream
LICENSE/COPYING file into a per-theme `theme-meta.json` sidecar; the
theme card surfaces author / source URL / license filename. Provenance
comments in `backend.ts`, `theme-pack.ts`, and `types.ts` were rewritten
in stage 5 to describe behavior without citing upstream Python files.

Two unrelated trims that landed in the same PR cycle (worth noting
for license posture, since they removed any residual derivative
exposure):

- The in-tree GUI theme editor (`components/ThemeEditor.tsx`,
  `lib/{default-theme,presets,theme-engine}.ts` and the corresponding
  backend RPC surface) was removed entirely.
- The two ship-with-source built-in themes (`themes/dark-qam.css`,
  `themes/rounded-corners.css` + `lib/builtin-themes.ts`) were removed.
  Themes are now exclusively community packs consumed via the
  deckthemes.com pipeline.

The original audit findings below are preserved for posterity.

---

- **Path**: `plugins/css-loader/`
- **Our LICENSE**: BSD-3-Clause (added)
- **Upstream candidate**: [DeckThemes/SDH-CssLoader](https://github.com/DeckThemes/SDH-CssLoader)
- **Upstream license**: **GPL-3.0** (verified — file at
  `https://raw.githubusercontent.com/DeckThemes/SDH-CssLoader/main/LICENSE`)
- **Provenance signals — code**:
  - `plugins/css-loader/backend.ts:35-37` — comment: *"**pack**: Decky CSS
    Loader 'ThemeDB' directories (manifest + CSS files + optional patch
    variants) installed from deckthemes.com"*
  - `plugins/css-loader/backend.ts:78-80` — comment: *"Upstream SDH-CSSLoader
    resolves 'MainMenu' to 'MainMenu.*' regex via legacy mappings
    (css_inject.py: 'MainMenu' → ['MainMenu.*'])."* This is a direct citation
    to upstream code structure.
  - `plugins/css-loader/lib/css-translations.json` — committed binary blob
    (2.3 MB), populated by `scripts/refresh-css-translations.sh`, which
    fetches `https://api.deckthemes.com/stable.json` — *"the canonical source
    the upstream SDH-CSSLoader backend pulls at runtime (main.py: stable.json
    or beta.json)"* (per the script's own header comment).
  - `plugins/css-loader/lib/types.ts:64` — *"Decky CSS Loader 'ThemeDB'
    manifest (theme.json)"* — we replicate the upstream manifest format.
  - `plugins/css-loader/app.tsx:353` — UI text: *"Themes from the Decky Loader
    community · deckthemes.com"*.
- **Provenance signals — history**:
  - PR [#11](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/11)
    "Add CSS GUI Theme Editor to css-loader plugin" (the plugin pre-dates this).
  - PR [#58](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/58)
    body: *"Aligns with upstream SDH-CSSLoader's `css_inject.py` mapping...
    `scripts/refresh-css-translations.sh` pulls the canonical class-name map
    from `api.deckthemes.com` (same source SDH-CSSLoader uses at runtime)."*
- **Code-overlap analysis**: We do not import or transliterate SDH-CssLoader
  Python source, but we do bundle a snapshot of its runtime data feed and
  replicate its theme-pack manifest format. The `css-translations.json` file
  is the most concerning single artifact — it is large, committed, and
  shipped, and it originates from a service operated by the GPL-3.0 project.
- **Copyrightability assessment**:
  - The *theme-pack manifest format* (`theme.json` shape) — likely a
    functional/interoperability format, weakly copyrightable; reusing it for
    interop is well-established practice.
  - The *css-translations.json* — a compilation of Steam internal class-name
    hashes mapped to stable identifiers. Two competing readings:
    1. *Facts (Feist v. Rural)* — Steam's compiled CSS class names are
       mechanically generated; a mapping to readable names is largely a
       record of fact, not creative selection or arrangement.
    2. *Compilation copyright* — DeckThemes maintains, curates, and updates
       the mapping; the selection (which classes to expose, which to omit)
       and the readable names assigned arguably reflect creative choices.
  - The *MainMenu → MainMenu.\* regex behaviour* — clearly functional, not
    copyrightable (scènes à faire / merger).
  - On balance: shipping the bundled translations file is the riskiest
    element. The structural references and manifest interop are defensible.
- **Risk classification**: **CRITICAL**
- **Remediation** (recommended; pick one or combine):
  1. **Stop bundling `css-translations.json`**. Move the file out of git;
     fetch on demand from `api.deckthemes.com` at runtime (we already query
     that API for community theme metadata). This sidesteps the redistribution
     question entirely. ← preferred.
  2. Replace `css-translations.json` with a clean-room generated map produced
     by parsing Steam's own compiled CSS at the user's machine (the upstream
     does this server-side; we'd do it client-side). Significant work.
  3. Relicense the `css-loader` plugin only — and any code that links its
     types — to GPL-3.0. Compatible with the rest of the project under BSD,
     since combining GPL with BSD code is permitted (the combined work
     ships GPL).
  4. Drop the css-loader plugin from the release.

---

### HIGH

#### `plugins/apex-fixes` 🗑 release-removed — will be deprecated and deleted before public release (supersedes the earlier extraction plan; see `plugins/apex-fixes/TODO.md`)

- **Path**: `plugins/apex-fixes/`
- **Our LICENSE**: none
- **Upstream candidate (TypeScript wrapper)**:
  [srsholmes/onexplayer-apex-bazzite-fixes](https://github.com/srsholmes/onexplayer-apex-bazzite-fixes)
  — **owned by the user**, **MIT** licensed.
- **Upstream candidate (kernel modules)**: out-of-tree
  [`oxpec` driver](https://github.com/Samsagax/oxp-sensors) — Linux kernel
  module, **GPL-2.0** (Linux kernel licensing mandate; LICENSE could not be
  fetched directly during this audit but kernel-symbol exports require GPL).
- **Upstream candidate (kernel patches)**: `hid-oxp` patches authored by
  Derek J. Clark (DeckThemes/Bazzite developer) — Linux kernel patches,
  **GPL-2.0** by inheritance.
- **Provenance signals — code**:
  - `plugins/apex-fixes/backend.ts:15` — *"the Decky behaviour that unloaded
    oxpec on every shutdown"*
  - `plugins/apex-fixes/src/oxpec.ts:4-10` — *"Ports the Decky plugin's
    `oxpec_loader.py`. ... the bundled build we vendored from Decky"*
  - `plugins/apex-fixes/src/light-sleep.ts:4` — *"Port of the Decky plugin's
    `sleep_fix.py`"*
  - `plugins/apex-fixes/src/inputplumber-migrate.ts:5` — *"ported from the
    `onexplayer-apex-bazzite-fixes` Decky plugin"*
  - `plugins/apex-fixes/kernel-modules/README.md:16-17` — *"copied from the
    upstream Decky plugin [`OneXPlayer Apex Tools`][decky-plugin] and track
    Bazzite's kernel releases"*
  - `plugins/apex-fixes/kernel-modules/README.md:29` — link target:
    `https://github.com/srsholmes/onexplayer-apex-bazzite-fixes`
  - `plugins/apex-fixes/kernel-modules/README.md:28` — also references
    `Samsagax/oxpec` as the canonical source of the module.
- **Provenance signals — history**:
  - PR [#44](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/44):
    *"New `apex-fixes` plugin replicates the non-input fixes from the Decky
    'OneXPlayer Apex Tools' plugin... oxpec [...] Source port: oxpec_loader.py
    [...] light-sleep [...] Source port: sleep_fix.py [...] xhci-recovery [...]
    Source port: xhci_recovery.py + resume_fix.py [...] kernel-modules/ —
    bundled oxpec.ko per kernel (vendored from Decky)"*
  - PR [#46](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/46)
    "port HHD → InputPlumber migration"
- **Code-overlap analysis**:
  - The TypeScript backend (`src/oxpec.ts`, `src/light-sleep.ts`,
    `src/sleep-enable.ts`, `src/xhci-recovery.ts`,
    `src/inputplumber-migrate.ts`) is a port of Python source from the user's
    own MIT-licensed `srsholmes/onexplayer-apex-bazzite-fixes` repo. **The
    user is the copyright holder of both ends; relicensing is unrestricted.**
  - `kernel-modules/{6.17.7-baXX}/oxpec.ko` are compiled out-of-tree Linux
    kernel modules. The build originates from `Samsagax/oxpec`. Linux kernel
    modules using kernel `EXPORT_SYMBOL_GPL` exports must be GPL-2.0. The
    `.ko` binaries are GPL-2 derivative works.
  - `kernel-patches/hid-oxp/v2-*.patch` are Linux kernel patches by Derek J.
    Clark; patches against GPL-2 code are themselves GPL-2.
- **Copyrightability assessment**: kernel modules and patches are clearly
  copyrightable code; GPL-2 obligations attach to their distribution
  unambiguously.
- **Risk classification**: **HIGH** — risk is on the bundled binaries /
  patches, *not* on the TypeScript wrapper.
- **Remediation**:
  1. Move `kernel-modules/` and `kernel-patches/` out of the bundled plugin
     and into a separate distribution channel (e.g. a `dnf-copr` repo or a
     downloadable archive). The plugin would prompt the user to install them.
     Cleanest separation.
  2. If kept bundled: add `plugins/apex-fixes/kernel-modules/COPYING` (full
     GPL-2 text), and a `WRITTEN_OFFER.txt` with how to obtain corresponding
     source for the binary `.ko` files (per GPL-2 §3). Link to
     `Samsagax/oxpec` and pin the source revision used to build each `.ko`.
  3. The TypeScript layer can be MIT (matching `onexplayer-apex-bazzite-fixes`)
     or BSD-3 (matching the rest of the project) — either is fine.

---

### MEDIUM

#### `plugins/sound-loader` (renamed from `plugins/audio-loader`) ✅ done (commit `087b0e6`; renamed + live-API switch in this PR)

- **Our LICENSE**: BSD-3-Clause (`plugins/sound-loader/LICENSE`)
- **NOTICE**: `plugins/sound-loader/NOTICE` credits SDH-AudioLoader and
  notes that pack metadata is fetched live from `api.deckthemes.com`
  (no registry snapshot is bundled).
- **Upstream candidate**: [DeckThemes/SDH-AudioLoader](https://github.com/DeckThemes/SDH-AudioLoader)
- **Upstream license**: **MIT** (Copyright © 2022 EMERALD0874) and
  **BSD-3-Clause** (Copyright © 2022 Steam Deck Homebrew) — dual.
- **Provenance signals**:
  - `plugins/sound-loader/backend.ts` — `DECKY_TO_STEAM_LOADER` mapping:
    a hard-coded list of Decky AudioLoader sound filenames mapped to our
    abstract event names (`deck_ui_misc_10.wav` → `nav`, etc.).
  - `plugins/sound-loader/lib/sounds-cache.ts` — community pack
    registry consumed live from `api.deckthemes.com/themes/legacy/audio`
    (replaces the previously-bundled `community-packs.json` snapshot).
  - PR [#27](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/27)
    body: *"similar to SDH-AudioLoader for Decky"*.
- **Code-overlap analysis**: Backend implementation (CDP injection, pack
  scanning, Web Audio fallback) is original. The two artefacts that intersect
  upstream are (a) the filename → event map and (b) the manifest format
  expected in `pack.json`. Both are interoperability surfaces.
- **Copyrightability assessment**: Sound filenames are facts about Valve's
  Steam UI (not creative work of EMERALD0874 / SDH). The manifest field
  shape is functional. Low intrinsic copyright weight; a NOTICE
  attribution is the appropriate safe response.
- **Risk classification**: **MEDIUM** (only because the upstream is
  permissive but explicitly named in our PR description and code).
- **Remediation**:
  1. Added `plugins/sound-loader/NOTICE`: *"This plugin's sound-pack format
     and Steam UI sound-event filename conventions are interoperable with
     the SDH-AudioLoader project (https://github.com/DeckThemes/SDH-AudioLoader,
     MIT / BSD-3-Clause). No source code is derived."*
  2. Added `plugins/sound-loader/LICENSE` — BSD-3-Clause.
  3. Renamed plugin from `audio-loader` to `sound-loader` to disambiguate
     from upstream's "Audio Loader" brand (parallel to the
     `css-loader` → `theme-loader` rename in PR #76).
  4. Replaced the bundled `community-packs.json` snapshot with live
     consumption of `api.deckthemes.com/themes/legacy/audio` (cached
     under `~/.cache/steam-loader/sound-loader/`); installs now
     download from the canonical `api.deckthemes.com/blobs/<id>` URL
     rather than reaching into per-pack GitHub repos.

---

#### `plugins/mangohud-tweaks` (renamed from `mangopeel`) ✅ done (commit `087b0e6`)

- **Our LICENSE**: BSD-3-Clause (`plugins/mangohud-tweaks/LICENSE`)
- **NOTICE**: `plugins/mangohud-tweaks/NOTICE` credits Gawah/MangoPeel
- **Rename**: directory + plugin id + package name + React component name
  + log prefixes + tests all updated. The trademark/name-collision concern
  raised below is now resolved.
- **Upstream candidate**: [Gawah/MangoPeel](https://github.com/Gawah/MangoPeel)
- **Upstream license**: **BSD-3-Clause** (Copyright © 2023 Gawah)
- **Provenance signals**:
  - PR [#13](https://github.com/srsholmes/linux-gaming-plugin-manager/pull/13)
    body explicitly lists `mangopeel` → "Replaces MangoPeel".
  - Same plugin name; same feature set (MangoHud preset management).
- **Code-overlap analysis**: `plugins/mangopeel/backend.ts` reads/writes
  `~/.config/MangoHud/MangoHud.conf` directly. The `PRESETS` array is original
  (different preset names + values from upstream). No code identifiers,
  comments, or structural signals copied.
- **Copyrightability assessment**: feature parity is not a copyright issue.
  The plugin name "MangoPeel" reuses an upstream name (potential trademark
  question, not copyright — see Open Questions).
- **Risk classification**: **MEDIUM** (purely from name reuse).
- **Remediation**:
  1. Add `plugins/mangopeel/LICENSE` — BSD-3-Clause.
  2. Consider renaming to e.g. `mangohud-control` or contacting the upstream
     author to confirm name reuse is acceptable.
  3. Add a courtesy line in the plugin description: *"Inspired by the
     MangoPeel Decky plugin (Gawah, BSD-3-Clause)"*.

---

#### `plugins/launch-options` ✅ done (commit `087b0e6`)

- **Our LICENSE**: BSD-3-Clause (`plugins/launch-options/LICENSE`)
- **NOTICE**: `plugins/launch-options/NOTICE` credits Wurielle/decky-launch-options
- **Upstream candidate**: [Wurielle/decky-launch-options](https://github.com/Wurielle/decky-launch-options)
- **Upstream license**: **MIT** (Copyright © 2026 Wurielle) and
  **BSD-3-Clause** (Copyright © Steam Deck Homebrew) — dual.
- **Provenance signals**:
  - PR #13 — *"`launch-options` Replaces decky-launch-options — Steam launch
    options + VDF parser"*
- **Code-overlap analysis**: `plugins/launch-options/backend.ts` parses
  Steam's `localconfig.vdf` via our own `@loadout/vdf` package. Default
  preset list (`MangoHud`, `gamemoderun`, etc.) is generic command strings.
  No identifiers, comments, or structural signals copied.
- **Risk classification**: **MEDIUM** (named upstream replacement).
- **Remediation**:
  1. Add `plugins/launch-options/LICENSE` — BSD-3-Clause.
  2. Add NOTICE crediting Wurielle/decky-launch-options as inspiration.

---

#### `plugins/lsfg-vk` ✅ done (stage 5, on PR #60)

- **Our LICENSE**: BSD-3-Clause (`plugins/lsfg-vk/LICENSE`, stage 2)
- **NOTICE**: `plugins/lsfg-vk/NOTICE` credits both upstreams (stage 5)
- **Upstreams**:
  - [xXJSONDeruloXx/decky-lsfg-vk](https://github.com/xXJSONDeruloXx/decky-lsfg-vk)
    — **BSD-3-Clause** (Copyright © 2025 Kurt Himebauch / JSON Derulo;
    Original Copyright © 2022-2024 Steam Deck Homebrew). The install /
    configure / wrapper flow in our `backend.ts` is **ported from** this
    upstream — explicitly per PR #60 description: *"Port the install/configure
    flow from xXJSONDeruloXx/decky-lsfg-vk so the LSFG-VK plugin actually
    installs the Vulkan layer."*
  - [PancakeTAS/lsfg-vk](https://github.com/PancakeTAS/lsfg-vk) — **GPL-3.0**
    (verified, [LICENSE.md](https://github.com/PancakeTAS/lsfg-vk/blob/develop/LICENSE.md)).
    This is the actual frame-generation Vulkan layer; we **download**
    `lsfg-vk_noui.zip` from the upstream's GitHub Releases at user request,
    we do **not** redistribute it. (The decky-lsfg-vk LICENSE file claims
    lsfg-vk is MIT — that text is stale; the current lsfg-vk repo is GPL-3.)
- **Provenance signals**:
  - PR #60 body: explicit "Port the install/configure flow from decky-lsfg-vk"
  - `plugins/lsfg-vk/backend.ts` — `RELEASES_API` points at
    `api.github.com/repos/PancakeTAS/lsfg-vk/releases/latest`; install flow,
    `library_path` rewrite, TOML serialization, and `~/lsfg` wrapper script
    are the patterns ported from decky-lsfg-vk.
- **Code-overlap analysis**: this is a real port (BSD-3-Clause), not an
  independent reimplementation. UI surface and per-Steam-appId override
  shape remain original.
- **Copyrightability assessment**: BSD-3-Clause permits derivative works
  with attribution. Port-grade code copying is fine; we satisfy §1 / §2 by
  preserving the upstream copyright notice and disclaimer in NOTICE +
  `THIRD_PARTY_LICENSES.md`.
- **Risk classification**: **MEDIUM (compliant)** — derivative under a
  permissive license, attribution shipped.
- **Remediation status**: complete on PR #60.

---

#### `plugins/flatpak-manager` ✅ done (stage 3)

- **Our LICENSE**: BSD-3-Clause (`plugins/flatpak-manager/LICENSE`, stage 2)
- **NOTICE**: `plugins/flatpak-manager/NOTICE` credits jurassicplayer/decky-autoflatpaks (stage 3)
- **Upstream candidate**: [jurassicplayer/decky-autoflatpaks](https://github.com/jurassicplayer/decky-autoflatpaks)
- **Upstream license**: **BSD-3-Clause** (Copyright © 2022 Jurassicplayer;
  Original Copyright © 2022 Steam Deck Homebrew).
- **Provenance signals**:
  - PR #13 — *"`flatpak-manager` Replaces decky-autoflatpaks — List, update,
    cleanup Flatpak apps"*
- **Code-overlap analysis**: backend shells out to `flatpak` CLI. Original
  parsing of `flatpak list --columns=...` output. No structural overlap.
- **Risk classification**: **MEDIUM** (named upstream replacement).
- **Remediation**:
  1. Add `plugins/flatpak-manager/LICENSE` — BSD-3-Clause.
  2. Add NOTICE crediting decky-autoflatpaks as inspiration.

---

#### ~~`plugins/emudeck`~~ ✅ removed (commit `087b0e6`)

> Plugin deleted from the tree. Reimplement later as a clean-room project if
> needed. Original audit findings retained below for historical context.

- **Our LICENSE**: none (no longer applicable)
- **Upstream candidate (Decky port)**: [EmuDeck/emudecky](https://github.com/EmuDeck/emudecky)
- **Upstream license**: **AGPL-3.0** ⚠ — strongest copyleft of any upstream
  in this audit.
- **Provenance signals**:
  - PR #13 — *"`emudeck` Replaces EmuDecky — EmuDeck dashboard, emulator
    scanning, ROM counts"*
- **Code-overlap analysis**: `plugins/emudeck/backend.ts` is a clean
  reimplementation. `KNOWN_EMULATORS` table contains hard-coded flatpak IDs
  for popular emulators (`org.libretro.RetroArch`, `org.DolphinEmu.dolphin-emu`,
  etc.) — these are facts about third-party Flatpak packages, not
  EmuDecky's expression. No code identifiers, comments, or structural
  signals copied. The plugin reads files written by EmuDeck (the user-facing
  app) — interfacing with EmuDeck-the-app does not implicate the EmuDecky
  plugin's license at all.
- **Copyrightability assessment**: feature parity, no code derivation.
  AGPL only attaches to *derivative works of AGPL code*; we don't have any.
- **Risk classification**: **MEDIUM** — clean reimplementation, but the
  upstream license is AGPL-3.0 so the bar for accidental contamination is
  high. A reviewer who isn't familiar with the project may flag this; we
  should make the absence of derivation explicit.
- **Remediation**:
  1. Add `plugins/emudeck/LICENSE` — BSD-3-Clause.
  2. Add `plugins/emudeck/NOTICE`: *"This plugin is an independent
     reimplementation of the EmuDecky Decky-Loader plugin's user-facing
     functionality. No source code from EmuDecky (AGPL-3.0) was consulted or
     copied. The plugin interacts with EmuDeck (https://www.emudeck.com),
     which is a separate project."*
  3. Write a short engineering note documenting that the plugin was written
     fresh from feature requirements only — useful evidence if the
     reimplementation is ever challenged.

---

#### `plugins/protondb-badges` ✅ done (stage 3)

- **Our LICENSE**: BSD-3-Clause (`plugins/protondb-badges/LICENSE`, stage 2 — electing the BSD-3 arm of the dual upstream)
- **NOTICE**: `plugins/protondb-badges/NOTICE` credits OMGDuke/protondb-decky and explicitly elects the BSD-3-Clause arm (stage 3)
- **Upstream candidate**: [OMGDuke/protondb-decky](https://github.com/OMGDuke/protondb-decky)
- **Upstream license**: **GPL-3.0** AND **BSD-3-Clause** (dual; Copyright ©
  Steam Deck Homebrew). The user may elect either; we should elect BSD-3.
- **Provenance signals**: feature-parity with the Decky plugin (ProtonDB
  badge injection on library/store pages); no explicit attribution comments
  found in our code.
- **Code-overlap analysis**: `plugins/protondb-badges/backend.ts` injects
  badges via CDP into Steam tabs (matches our `css-loader` architectural
  pattern, not OMGDuke's Python pattern). Cache layout, settings shape, and
  ProtonDB API endpoint usage are original. The ProtonDB API endpoint
  (`api.protondb.com/api/v1/reports/summaries/...`) is a public third-party
  API — not licensed material.
- **Risk classification**: **MEDIUM** — feature parity with a dual-licensed
  upstream that *includes* GPL-3.0; we should explicitly document our choice
  of the BSD-3-Clause arm.
- **Remediation**:
  1. Add `plugins/protondb-badges/LICENSE` — BSD-3-Clause.
  2. Add NOTICE: *"This plugin is an independent reimplementation of the
     ProtonDB Badges concept (originally OMGDuke/protondb-decky, dual
     GPL-3.0/BSD-3-Clause). We elect the BSD-3-Clause arm. ProtonDB itself
     is a third-party service."*

---

### LOW

These plugins replicate widely-implemented features (battery info, fan curves,
RGB control, etc.) without code-level signals tying them to any specific
upstream. They are clean reimplementations of common functionality. The risk
is purely the absence of an own LICENSE.

| Plugin | Notes |
|---|---|
| `bluetooth` | bluetoothctl wrapper; no upstream signal. |
| `fan-control` | sysfs/hwmon reader; clean. |
| `battery-tracker` | sysfs `power_supply` reader; clean. |
| `network-info` | `nmcli` / `iw` wrapper + speedtest; clean. |
| `playtime` | watches running processes + Steam VDF; clean. |
| `hltb` | HowLongToBeat API client (PR #44 fixed an unrelated upstream API breakage). HLTB has Decky-Loader counterparts but no signal of code derivation in our tree. |
| `display-settings` | gamescope / xrandr config; clean. |
| `game-browser` | Steam library reader; clean. |
| `music-player` | independent ambient-music player (replaced earlier `music-control` plugin which was removed pre-release). |
| `rgb-control` | OpenRGB + sysfs LEDs + platform interfaces; clean. The Apex RGB protocol (V2 on 1A2C:B001) is hardware-fact, not derived from any upstream plugin. |
| `steamgriddb` | wraps the public SteamGridDB API; clean. |
| `storage-cleaner` | du / Steam shader cache analysis; clean. |
| `tdp-control` | uses `ryzenadj`, `intel-rapl`, sysfs `power_cap`. Grep confirmed no SimpleDeckyTDP / PowerTools fingerprints. Per-game TDP profiles + apply-queue are original. |
| `disable-controller-input` | Added in PR #72. Talks to InputPlumber over its public DBus surface (`org.shadowblip.InputPlumber.CompositeDevice.SetTargetDevices`) to drop a controller's virtual targets — no upstream code reused. LICENSE BSD-3 added in PR #72; no NOTICE required. |
| `input-plumber` | Added in PR #74. Original installer wrapper. Tries the user's package manager first (pacman / dnf); else downloads the latest InputPlumber release tarball directly from `github.com/ShadowBlip/InputPlumber/releases/latest` on the user's machine. InputPlumber (GPL-3.0-or-later, ShadowBlip) is **not bundled or redistributed** — the user receives it from upstream under upstream's terms. LICENSE + NOTICE shipped 2026-05-08; NOTICE explains the upstream relationship and the BSD-3 libiio runtime stage. |

**Remediation for all LOW**: add `plugins/<name>/LICENSE` — BSD-3-Clause.
No further action. **✅ done in stage 2 — LICENSE files shipped to all 13;
✅ done in stage 6 — `disable-controller-input` (PR #72) + `input-plumber`
(PR #74, NOTICE this pass).**

---

### NONE

| Plugin | Notes |
|---|---|
| `audio-mixer` | Per-app PipeWire mixer + output routing; original to this project (PR #59). No Decky equivalent. |
| `browser` | Ports the **Electrobun multitab-browser template** (commit `166be1b`) — Electrobun is **MIT** (Blackboard Technologies inc., 2024). Verbatim MIT text reproduced in `THIRD_PARTY_LICENSES.md` per the upstream's terms. Plugin NOTICE credits the template. |
| `handy-dictation` | Thin wrapper around [Handy](https://github.com/cjpais/Handy) — verified **MIT** (CJ Pais, 2025). Handy is **not redistributed**; the plugin downloads `Handy.AppImage` from Handy's GitHub Releases at runtime. Per-plugin NOTICE clarifies the relationship; Handy MIT verbatim text in `THIRD_PARTY_LICENSES.md`. |
| `steam-gamescope-ipc` | Original implementation of Steam Gaming Mode IPC (PR #28). |
| ~~`steam-tweaks`~~ | ✅ Removed (commit `087b0e6`). Was an internal demo plugin per `plugin.json`. |

**Remediation for NONE**:
- `audio-mixer`, `steam-gamescope-ipc`: add `LICENSE` — BSD-3-Clause. **✅ done in stage 2.**
- `browser`: confirm Electrobun template license, comply, add LICENSE.
  **✅ done across stage 2 (LICENSE) + stage 3 (NOTICE + Electrobun MIT seeded into `THIRD_PARTY_LICENSES.md`).**
- `handy-dictation`: confirm Handy's license — it's an Apache-2.0 / similar
  external dependency; we ship a wrapper, not the engine. Add LICENSE +
  attribution to Handy.
  **✅ done across stage 2 (LICENSE) + stage 4 (NOTICE + Handy MIT seeded into `THIRD_PARTY_LICENSES.md`). Handy is in fact MIT, not Apache; runtime-fetched not bundled.**
- ~~`steam-tweaks`~~: ✅ removed.

---

## 4. Recommended LICENSE per plugin

The cleanest path is **a single project-wide BSD-3-Clause LICENSE at the repo
root**, with per-plugin overrides only where the upstream forces our hand.

### Project root

- `LICENSE` (BSD-3-Clause, Copyright © 2026 Simon Holmes)
- `NOTICE` — root-level summary of third-party attribution
- `THIRD_PARTY_LICENSES.md` — verbatim licenses of every upstream we credit

### Per-plugin LICENSE overrides

| Plugin | License | Why |
|---|---|---|
| `css-loader` | depends on remediation choice for the translations file. If we **stop bundling translations**, BSD-3-Clause works. If we keep bundling, **GPL-3.0** is the safe answer. | See §3 CRITICAL. |
| `apex-fixes` | TypeScript wrapper: BSD-3-Clause (or MIT). `kernel-modules/` and `kernel-patches/`: subdirectory `COPYING` files → **GPL-2.0**. | Per-subdirectory split keeps the wrapper unencumbered. |
| All others | BSD-3-Clause | Matches the dominant license in the Decky ecosystem and the user's other projects. |

### Files to add at the project root

1. `LICENSE` — BSD-3-Clause text.
2. `NOTICE` — short list of third-party works we credit (sound-loader,
   mangopeel, launch-options, lsfg-vk, flatpak-manager, protondb-badges).
3. `THIRD_PARTY_LICENSES.md` — verbatim license text for every upstream
   listed in §6, plus oxpec, hid-oxp, Handy, Electrobun template, daisyUI,
   react-simple-keyboard, and any other build-time/runtime dep that requires
   binary attribution. (A separate dependency-licenses audit — out of scope
   for this report — is needed to make this exhaustive.)

---

## 5. Remediation plan

Ordered by ship-blocker priority. Status reflects work as of `087b0e6`.

| # | Action | Plugin / scope | Risk | Status |
|---|---|---|---|---|
| 1 | Add project-root `LICENSE` (BSD-3-Clause). | repo root | ship-blocker | ✅ done (stage 2) |
| 2 | Stop committing `plugins/css-loader/lib/css-translations.json`. Move the fetch to runtime via `api.deckthemes.com` (the same code path SDH-CssLoader uses). Update `.gitignore`. Add a fallback bundled minimal map of the ~10 most-targeted classes to keep first-launch usable. | `css-loader` → `theme-loader` | ship-blocker | ✅ done (stage 6, PR #76) — translations + the community-themes snapshot both fetched live now; plugin renamed to `theme-loader`. |
| 3 | ~~If task #2 is rejected: relicense `css-loader` plugin as **GPL-3.0**~~. | `css-loader` → `theme-loader` | ship-blocker | ✅ moot — task #2 landed (don't bundle, fetch at runtime); plugin stays BSD-3-Clause. |
| 4 | ~~Move `plugins/apex-fixes/kernel-modules/` and `kernel-patches/` into a separate distributable. If kept inline: add `COPYING` (GPL-2 verbatim) and `WRITTEN_OFFER.txt`~~. | `apex-fixes` | HIGH | 🗑 release-removed — `apex-fixes` will be deprecated and deleted from this repo before any public release. No GPL-2 artifacts ship from here, no `COPYING`/`WRITTEN_OFFER.txt` work needed. Supersedes the earlier extraction plan. |
| 5a | Add `LICENSE` (BSD-3) + `NOTICE` to `audio-loader` (now `sound-loader`), `launch-options`, `mangohud-tweaks` (renamed from `mangopeel`). | 3 plugins | MEDIUM | ✅ done (`087b0e6`); `audio-loader` later renamed to `sound-loader` and switched to live deckthemes API consumption. |
| 5b | Add `LICENSE` (BSD-3) + `NOTICE` to `lsfg-vk`, `flatpak-manager`, `protondb-badges`. | 3 plugins | MEDIUM | LICENSE ✅ (stage 2). NOTICE: `flatpak-manager` ✅ + `protondb-badges` ✅ (stage 3); `lsfg-vk` ✅ (stage 5, PR #60). |
| 5c | Decide on `emudeck` (AGPL-3.0 upstream). | `emudeck` | MEDIUM | ✅ done — removed (`087b0e6`) |
| 6 | Add `LICENSE` (BSD-3) to: `bluetooth`, `fan-control`, `battery-tracker`, `network-info`, `playtime`, `hltb`, `display-settings`, `game-browser`, `music-player`, `rgb-control`, `steamgriddb`, `storage-cleaner`, `tdp-control`. | 13 plugins | LOW | ✅ done (stage 2) |
| 7 | Add `LICENSE` (BSD-3) to `audio-mixer`, `steam-gamescope-ipc`. | 2 plugins | NONE | ✅ done (stage 2) |
| 8 | Confirm Electrobun multitab-browser template license; add LICENSE + attribution to `plugins/browser/`. | `browser` | NONE | ✅ done — Electrobun verified MIT; LICENSE (stage 2), NOTICE + verbatim MIT in `THIRD_PARTY_LICENSES.md` (stage 3) |
| 9 | Confirm Handy license; add LICENSE + attribution to `plugins/handy-dictation/`. | `handy-dictation` | NONE | ✅ done — Handy verified MIT (CJ Pais, 2025); LICENSE (stage 2), NOTICE + verbatim MIT in `THIRD_PARTY_LICENSES.md` (stage 4). Handy is not redistributed (runtime fetch from GitHub Releases). |
| 10 | Decide whether to keep `steam-tweaks` in the release. | `steam-tweaks` | NONE | ✅ done — removed (`087b0e6`) |
| 11 | Rename `mangopeel` plugin to avoid trademark/name collision, OR contact Gawah for permission. | `mangopeel` | trademark, not copyright | ✅ done — renamed to `mangohud-tweaks` (`087b0e6`) |
| 12 | Write `THIRD_PARTY_LICENSES.md` aggregating verbatim text of every upstream LICENSE referenced. | repo root | ship-blocker | ◐ seeded in stage 3 (Electrobun MIT) + extended in stage 4 (Handy MIT). Outstanding: kernel artifacts (deferred to extracted repo) and css-loader upstream (deferred). |
| 13 | Run a separate runtime/build dependency licensing audit (Bun, Electrobun/CEF, daisyUI, react-simple-keyboard, every npm dep, every Cargo crate). Out of scope for this report. | repo-wide | follow-up | ⏳ outstanding |

---

## 6. Open questions

These need user (or counsel) input before they can be closed.

1. **Is the bundled `css-translations.json` defensible as facts, or
   copyrightable as a compilation?** Resolving this either way shrinks the
   `css-loader` problem dramatically. Worst-case assume compilation copyright;
   stop bundling.
2. **Trademark on plugin names** — `MangoPeel` resolved by renaming our plugin
   to `mangohud-tweaks` (commit `087b0e6`). The `EmuDeck` concern is moot now
   that the `emudeck` plugin has been removed. Any future plugin that uses an
   external project's name (nominative use) should be re-evaluated. Trademark
   questions are distinct from copyright and remain out of this audit's scope.
3. **Is the project willing to ship under GPL-3.0** (so that `css-loader` can
   fully reuse SDH-CssLoader without restriction)? This shifts the entire
   project's license posture.
4. **Source provenance for `oxpec.ko`** — we vendored compiled binaries from
   the user's own MIT-licensed repo. The `.ko` files are still GPL-2 by virtue
   of being kernel modules. We need to record the exact `Samsagax/oxpec` (or
   wherever) source tag each `.ko` was built from, both for GPL-2 source-offer
   compliance and for reproducibility.
5. **Handy and Electrobun template licenses** — both are upstream wrappers our
   `handy-dictation` and `browser` plugins build on. Their licenses determine
   whether NOTICE attribution is sufficient or whether more is required.
6. **Pre-release: removed plugins.** PR #13 introduced `screenshots`,
   `controller-info`, `animation-changer`, `screen-recorder`, `music-control`
   — all five were removed before main (commits `e12d92e`, `7129617`,
   `dbc27d0`, `5baaaad`). They are not currently in the tree and not in this
   audit. If any of their code was copied into surviving plugins (e.g.
   `music-player` retaining ideas from `music-control`), a follow-up audit
   should confirm no carry-over from upstream-derived snippets.

---

## 7. Upstream license reference

Verified against `main`/`master` branch LICENSE on the audit date (2026-04-29).

| # | Upstream | License | Source |
|---|---|---|---|
| 1 | DeckThemes/SDH-CssLoader | **GPL-3.0** | https://raw.githubusercontent.com/DeckThemes/SDH-CssLoader/main/LICENSE |
| 2 | DeckThemes/SDH-AudioLoader | MIT + BSD-3-Clause (dual) | https://raw.githubusercontent.com/DeckThemes/SDH-AudioLoader/main/LICENSE |
| 3 | Gawah/MangoPeel | BSD-3-Clause | https://raw.githubusercontent.com/Gawah/MangoPeel/main/LICENSE |
| 4 | jurassicplayer/decky-autoflatpaks | BSD-3-Clause | https://raw.githubusercontent.com/jurassicplayer/decky-autoflatpaks/main/LICENSE |
| 5 | aarron-lee/SimpleDeckyTDP | BSD-3-Clause | https://raw.githubusercontent.com/aarron-lee/SimpleDeckyTDP/main/LICENSE |
| 6 | NGnius/PowerTools | **GPL-3.0** | https://github.com/NGnius/PowerTools (archived; moved to git.ngni.us) |
| 7 | Wurielle/decky-launch-options | MIT + BSD-3-Clause (dual) | https://raw.githubusercontent.com/Wurielle/decky-launch-options/main/LICENSE |
| 8 | xXJSONDeruloXx/decky-lsfg-vk | BSD-3-Clause | https://raw.githubusercontent.com/xXJSONDeruloXx/decky-lsfg-vk/main/LICENSE |
| 8b | PancakeTAS/lsfg-vk (runtime layer; downloaded, not redistributed) | **GPL-3.0** (verified stage 5 — supersedes earlier "MIT" claim from decky-lsfg-vk's stale third-party section) | https://github.com/PancakeTAS/lsfg-vk/blob/develop/LICENSE.md |
| 9 | EmuDeck/emudecky | **AGPL-3.0** | https://raw.githubusercontent.com/EmuDeck/emudecky/main/LICENSE |
| 10 | OMGDuke/protondb-decky | GPL-3.0 + BSD-3-Clause (dual) | https://raw.githubusercontent.com/OMGDuke/protondb-decky/main/LICENSE |
| 11 | hhd-dev/hhd | LGPL-2.1 | https://raw.githubusercontent.com/hhd-dev/hhd/master/LICENSE |
| 12 | hhd-dev/hhd-decky | BSD-3-Clause | https://raw.githubusercontent.com/hhd-dev/hhd-decky/main/LICENSE |
| 13 | mirobouma/MusicControl | MIT | https://raw.githubusercontent.com/mirobouma/MusicControl/main/LICENSE *(upstream of removed `music-control`)* |
| 14 | jfernandez/ControllerTools | GPL-3.0 + BSD-3-Clause (dual) | https://raw.githubusercontent.com/jfernandez/ControllerTools/main/LICENSE.md *(upstream of removed `controller-info`)* |
| 15 | safijari/Shotty | BSD-3-Clause | https://raw.githubusercontent.com/safijari/Shotty/main/LICENSE *(upstream of removed `screenshots`)* |
| 16 | SteamDeckHomebrew/decky-loader | **GPL-2.0** | https://github.com/SteamDeckHomebrew/decky-loader/blob/main/LICENSE *(reference only — we do not link decky-loader)* |
| 17 | srsholmes/onexplayer-apex-bazzite-fixes | MIT | https://github.com/srsholmes/onexplayer-apex-bazzite-fixes — **owned by user**; relicensable |
| 18 | Samsagax/oxpec (oxp-sensors) | GPL-2.0 (Linux kernel module) | source: https://gitlab.com/Samsagax/oxp-platform-dkms |

Negative result confirmed by repo-wide grep:
**no plugin imports `decky-frontend-lib`, `@decky/*`, or any other Decky
SDK package.** This is a meaningful finding — it means there is no LGPL-2.1
runtime contamination from the Decky ecosystem, regardless of feature parity.

---

*End of audit.*
