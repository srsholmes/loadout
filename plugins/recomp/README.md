# RecompHub

> Browse, install, and play recompiled retro games natively

Browse, install, and launch community recompilations and native ports of classic games — you supply your own game files and it handles the rest, turning supported retro titles into properly native Linux builds.

## Game data & catalog policy

RecompHub ships **no copyrighted game data** and downloads none. Every
catalog entry links to a community recompilation/decompilation project;
the plugin fetches only that project's own release binary from its
GitHub releases. All game data (ROMs, disc images, XBLA packages) is
supplied by the user from their own legally owned copy, via the ROM
picker — nothing is bundled, downloaded, or auto-discovered from the
network. The disc-image / XBLA extractors (`lib/rom-source.ts`) are
plain unencrypted-filesystem readers: no keys, no decryption, no DRM
circumvention.

A catalog entry is a link to an upstream project, not a host for it. If
an upstream project receives a DMCA takedown or is pulled, remove its
entry from `games.json` promptly — the catalog's standing tracks the
health of the projects it points at.

## Screenshots

### Overview

![RecompHub — Overview](./assets/screenshot.png)

### Game detail

![RecompHub — Game detail](./assets/screenshot-detail.png)

### In Big Picture

Your recompiled titles, added to Steam with full artwork — a dedicated
RecompHub collection right in the Gaming Mode library:

![RecompHub — Big Picture library](./assets/screenshot-big-picture-library.png)

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
