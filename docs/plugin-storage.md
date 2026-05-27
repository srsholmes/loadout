# Per-plugin JSON storage

Plugins persist their own state (bookmarks, history, preferences, caches)
through the shared `@loadout/plugin-storage` helper rather than
inventing their own directory layout.

## Where it lives

```
$XDG_CONFIG_HOME/loadout/plugins/<plugin-id>.json
```

(typically `~/.config/loadout/plugins/<plugin-id>.json`)

One JSON file per plugin, keyed by the plugin's manifest `id`. This
sits alongside the overlay's own `config.json` so everything the user
cares about lives in one place:

```
~/.config/loadout/
├── config.json                 # overlay UI prefs (theme, layout, …)
└── plugins/
    ├── browser.json
    ├── playtime.json
    └── ...
```

Why this instead of `~/.local/share/loadout/plugins/<id>/`?

- **Discoverable.** Users who go looking for their data find it next
  to the settings they already know.
- **Backup-friendly.** One dir, one backup target. No split between
  "config" and "state."
- **Reinstall-safe.** Lives outside the install prefix so
  `install-local.sh` / `uninstall.sh` don't wipe it by default.
- **Not leaked into the overlay's config file.** User history and
  plugin-owned data should NEVER mix into `config.json` — that file
  is the overlay shell's home for UI prefs and would bloat fast if
  we piled plugin data in.

## Helper API

```ts
import {
  pluginStoragePath,
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";

interface MyState {
  items: string[];
  lastSeen: number;
}

// Read — returns Partial<T>; missing / unparseable file → {}.
const state = await readPluginStorage<MyState>("my-plugin");
const items = state.items ?? [];

// Write — atomic (tmp + rename), creates `plugins/` on first write.
await writePluginStorage<MyState>("my-plugin", {
  items: [...items, "new"],
  lastSeen: Date.now(),
});

// Path — exposed for tests / tooling that needs to know where the
// file is without invoking the read/write helpers.
const path = pluginStoragePath("my-plugin");
```

## Contract for plugin backends

1. **Own one file.** Do not spread state across multiple files under
   `plugins/`. If you need structure, nest inside your JSON object.
2. **Read once at `onLoad()`**, keep in memory, write on every
   mutation. Writes are atomic — losing one doesn't corrupt the file.
3. **Treat an empty file the same as missing.** `readPluginStorage`
   returns `{}` in both cases. Seed defaults, then persist.
4. **Validate on read.** The file is user-editable and can be edited
   or corrupted between runs. Use `Array.isArray`, `typeof`, etc. and
   fall back to defaults when a field's shape is wrong.
5. **Version your schema** (optional but recommended) by including a
   `"version": N` field you bump when the shape changes.

## When NOT to use plugin storage

- **Ephemeral session state** — tabs, open modals, cursor positions.
  Those belong in React state; they don't survive (and shouldn't try
  to survive) an overlay restart.
- **Large binary data** — images, audio caches, model weights. Those
  go in `$XDG_DATA_HOME/loadout/plugins/<id>/` (traditional
  user-data dir) so the config file stays small and readable.
- **User preferences the overlay shell owns** — theme, sidebar
  collapse state, startup view. Those already live in `config.json`
  and the overlay exposes `useConfigValue()` for them.
