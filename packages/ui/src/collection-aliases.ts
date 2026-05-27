/**
 * Friendly short names for the long emulation-collection labels Steam
 * shortcuts end up tagged with. EmuDeck (and similar tooling) names
 * collections after the full platform — "Nintendo 64", "Sega Mega
 * Drive - Genesis", "Sony PlayStation 2" — which doesn't fit the
 * small collection pill on a 2:3 library tile. We map the long name
 * to the short one most players actually use ("N64", "Genesis",
 * "PS2").
 *
 * Lookup is case-insensitive and falls back to the original name when
 * there's no entry, so unknown collections still render cleanly.
 * Fuzzy search includes BOTH names as keys (see
 * `collectionSearchTokens`) so the user can type either "n64" or
 * "nintendo 64" and hit the same tiles.
 */
const ALIASES: Record<string, string> = {
  // Nintendo
  "nintendo entertainment system": "NES",
  "super nintendo entertainment system": "SNES",
  "super nintendo": "SNES",
  // EmuDeck-style label seen on real shortcuts.vdf libraries.
  "nintendo snes (super nintendo)": "SNES",
  "nintendo 64": "N64",
  "nintendo gamecube": "Gamecube",
  "nintendo wii": "Wii",
  "nintendo wii u": "Wii U",
  "nintendo ds": "DS",
  "nintendo 3ds": "3DS",
  "nintendo switch": "Switch",
  "nintendo switch - eden": "Switch",
  "nintendo switch - ryujinx": "Switch",
  "nintendo switch - yuzu": "Switch",
  "nintendo game boy": "Game Boy",
  "nintendo game boy color": "GBC",
  "nintendo game boy advance": "GBA",
  "nintendo virtual boy": "Virtual Boy",

  // Sega
  "sega master system": "Master System",
  "sega genesis": "Genesis",
  "sega mega drive": "Genesis",
  "sega mega drive - genesis": "Genesis",
  // EmuDeck-style combined label seen on real libraries.
  "sega genesis/mega drive": "Genesis",
  "sega cd": "Sega CD",
  "sega 32x": "32X",
  "sega saturn": "Saturn",
  "sega dreamcast": "Dreamcast",
  "sega game gear": "Game Gear",

  // Sony
  "sony playstation": "PS1",
  "sony playstation 2": "PS2",
  "sony playstation 3": "PS3",
  "sony playstation portable": "PSP",
  "sony playstation vita": "PS Vita",

  // Microsoft
  "microsoft xbox": "Xbox",
  "microsoft xbox 360": "Xbox 360",

  // Other / retro
  "atari 2600": "Atari 2600",
  "atari 5200": "Atari 5200",
  "atari 7800": "Atari 7800",
  "atari jaguar": "Jaguar",
  "atari lynx": "Lynx",
  "nec turbografx-16": "TG-16",
  "nec pc engine": "PC Engine",
  "snk neo geo pocket color": "Neo Geo Pocket",
  "3do interactive multiplayer": "3DO",
  "arcade - mame": "Arcade",
  "commodore amiga": "Amiga",
  "commodore 64": "C64",
  "msx": "MSX",
  "scummvm": "ScummVM",
};

/**
 * Resolve a collection name to its display-friendly short form, or
 * return the original name unchanged when no alias exists.
 */
export function friendlyCollectionName(name: string): string {
  return ALIASES[name.toLowerCase()] ?? name;
}

/**
 * Return the array of search tokens for a collection name — the
 * original label plus the friendly alias (when distinct). Fuzzy
 * search across collection tags should match on either form so a
 * user typing "n64" or "Nintendo 64" hits the same tiles.
 */
export function collectionSearchTokens(name: string): string[] {
  const friendly = friendlyCollectionName(name);
  return friendly === name ? [name] : [name, friendly];
}
