# Quick Links — unified browser picker + inline first-run setup

**Date:** 2026-06-04
**Plugin:** `plugins/quick-links`
**Status:** Approved design, pending implementation plan

## Problem

Quick Links opens per-game links through a browser registered as a non-Steam
game shortcut. Today the only place to set that up is the **settings** page:

- The browser setup (detect + install) lives in `BrowserShortcutCard`, gated
  behind an "Install a browser" / "Add another browser" button.
- Which installed browser opens links is a separate `<select>` dropdown
  ("Open links in"), with a "Default (most-recent install)" entry.
- The landing page (per-game link chips) only shows a `NoBrowserBanner` that
  tells the user to go to settings — a dead-end on the main screen.

So a first-run user with no registered browser hits a wall on the main screen
and has to dig into settings. And selection vs. installation are two disjoint
UIs (a dropdown and a radio list) for what is really one decision: "which
browser opens my links, and is it set up?"

## Goal

Merge selection and installation into one radio-based control, and surface it
inline on the main screen for first-run setup.

## Decisions (locked)

1. **Approach A** — one unified component used in both settings and the landing
   page (not two separate components).
2. **Surface:** landing page (+ settings). The compact home widget is
   unchanged (it shows link chips only and has no browser banner today).
3. **Show/hide on the landing page:** show the picker inline only when **zero**
   browsers have a registered shortcut (`installedBrowsers.length === 0`); hide
   it as soon as one is installed.
4. **Radios, explicit browsers only** — no "Default (most-recent install)"
   entry. The `<select>` dropdown is removed.

## Data model (confirmed, no backend changes)

- `detectBrowsers()` → `BrowserCandidate[]` (`id`, `name`, `kind`,
  `exe`/`flatpakAppId`). Uses `which`/`flatpak` only — does **not** require
  Steam.
- `installedBrowsers: InstalledShortcut[]` — browsers with a registered Steam
  shortcut (`browserId`, `appId`, …).
- A candidate is "installed" iff `installedBrowsers.some(s => s.browserId === candidate.id)`
  (verified: `installBrowserShortcut` resolves the candidate via
  `candidates.find(c => c.id === browserId)`).
- `selectedBrowserId: string | null` — which browser opens links.
- RPCs reused as-is: `detectBrowsers`, `installBrowserShortcut`,
  `uninstallBrowserShortcut`, `setSelectedBrowserId`, `isSteamReachable`,
  `launchUrl`.

This is a **presentation-only** refactor. No backend / RPC / storage changes.

## Component: `BrowserPicker` (replaces `BrowserShortcutCard`)

A single card with a radio group over detected browsers.

**Rendering**
- On mount, fetch `detectBrowsers()` + `isSteamReachable()`.
- Radio group (reuse existing `BrowserRadio`) — one radio per detected
  candidate. The checked radio reflects `selectedBrowserId`.
- Each radio shows the browser name + exe/flatpak id, and an "installed ✓"
  marker when that candidate has a registered shortcut.

**Selection**
- Selecting a radio calls `setSelectedBrowserId(candidate.id)` immediately,
  whether or not it has a shortcut yet.

**Install affordance (per current selection)**
- If the selected candidate has **no** shortcut → show an
  **"Install as non-Steam game"** button calling
  `installBrowserShortcut(selectedId)`.
  - Disabled with the existing "Steam isn't responding on its debug port…"
    message when `isSteamReachable` is false.
- If the selected candidate **is** installed → no install button; show a small
  "registered ✓" line and an **uninstall** control for that browser.

**Edge states (preserved)**
- `detectBrowsers` empty → "No supported browsers detected…" message.
- Loading → spinner.
- Install error → inline error text (as today).

**Removed:** the `Select` dropdown, the `pickerOptions` "Default
(most-recent install)" entry, and the `installerOpen` expand/collapse toggle
(the radios + install are always the control now).

## Surfacing

- **Settings page (`QuickLinksPanel`):** always render `BrowserPicker` (the
  place to switch/add/remove later).
- **Landing page (`QuickLinksLandingPage`):** render `BrowserPicker` inline
  **only when `installedBrowsers.length === 0`**. Once a browser is installed,
  the landing page hides it and shows only the link chips. This replaces the
  current `NoBrowserBanner` (used only here, at the two `showBanner` sites) —
  which becomes dead code and is removed.
- **Home widget (`QuickLinksHomeWidget`):** unchanged — shows link chips only;
  it has no browser banner today and gains none.

## Behavior when selected browser has no shortcut and a link is clicked

No new fallback logic. The install button is the call to action; `launchUrl`
already returns `{ launched: false, reason: "not-installed" }` and the UI
surfaces it (toast + clipboard copy).

## Testing (app.spec.tsx)

- Radios render one per detected browser; no dropdown, no "Default" entry.
- Selecting a radio calls `setSelectedBrowserId` with that candidate's id.
- Install button shows only when the selected candidate is uninstalled, and is
  hidden once it is installed.
- Install button disabled + reachability message when `isSteamReachable` is
  false.
- Landing page renders `BrowserPicker` when `installedBrowsers` is empty and
  hides it when non-empty.
- "No supported browsers detected" empty state preserved.

## Out of scope

- Backend / RPC / storage changes.
- Home-widget redesign.
- Flatpak-Steam userdata path handling (tracked separately).
