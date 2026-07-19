# Game Tabs

> Build custom filtered tabs over your library and a play-through backlog

A TabMaster-style library browser for Loadout. Organise your whole on-device
library — installed Steam games **and** non-Steam / emulator shortcuts — into
custom tabs, and keep a backlog of games you want to play through.

## Features

### Custom tabs

Create as many tabs as you like. A tab can be built two ways (and you can mix
both in one tab):

- **Hand-picked** — make a tab and add whatever games you want to it, one at a
  time, from the full-library picker (or from any game tile's "Add to tab"
  action). Backed by a whitelist.
- **Rule-based** — define filters so the tab fills itself automatically.

Tabs can be renamed, duplicated, reordered, hidden, and set to auto-hide when
empty. Each tab has an AND/OR combine mode and a sort override.

### Filters

Every filter can be inverted. Available filters:

- **Collection / tag** — Steam collections and emulator/shortcut tags, matching
  any or all of the selected values.
- **Title** — substring or regular-expression match on the game name.
- **Platform** — Steam, non-Steam, or a specific emulator.
- **Size on disk** — above / below a threshold (installed Steam games).
- **Whitelist / blacklist** — explicit lists of games to include or exclude.
- **Merge** — a nested group of filters with its own AND/OR mode, for arbitrary
  boolean logic.

### Backlog

A hand-picked, ordered list of games to play through. Each game carries a
status — **To Play**, **Playing**, **Beaten**, or **Dropped** — and can be
reordered, launched in one tap, and moved through its statuses. A "Now / Up
Next" view keeps the game you're on and what's next front-and-centre.

## Data & storage

Games come from the shared `__core:game-library` service (the same source every
Loadout picker uses). Tabs and backlog live in
`~/.config/loadout/plugins/game-tabs.json`. Launching routes through Steam
(`steam://rungameid/…`) so Steam owns playtime and the overlay attaches, exactly
like every other launcher in Loadout.

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
