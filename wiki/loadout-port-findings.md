# Loadout port — findings & reference

Notes from porting every plugin to the Loadout design system, adding
the `mountHeader` export pattern, and tracking down the crash that
broke the screenshot run.

## What shipped

### Plugins ported (16)

All ported in parallel by sub-agents against the Loadout handoff
(`/tmp/loadout-handoff/loadout/project/`). Each plugin's body was
rewrapped to `<div className="p-7 h-full overflow-y-auto"><div
className="page-content">` with `.card` / `.subsection` /
`.subsection-label` / `.chip` / `.segmented` / `.metric-value mono` /
`.row` / `.row-label` / `.row-value` / `.rail` per the shared token
style (see `plugins/tdp-control/app.tsx` as the benchmark).

`sound-loader`, `browser`, `handy-dictation`,
`flatpak-manager`, `hltb`, `launch-options`, `lsfg-vk`, `mangohud-tweaks`,
`music-player`, `network-info`, `playtime`, `protondb-badges`,
`steam-gamescope-ipc`, `steamgriddb`, `storage-cleaner`.

`volume-swap` deliberately excluded by the user.

Plugins already DONE before this round: `sound-loader` (partially),
`battery-tracker`, `bluetooth`, `theme-loader`, `display-settings`,
`fan-control`, `rgb-control`, `tdp-control`.

Not ported: `game-browser` — Steam-injected panels, no `app.tsx`, not in
the Loadout sidebar.

### New plugin export: `mountHeader`

Duplicate page titles (one in the overlay topbar, one inside the
plugin body) became obvious once every plugin used the same centered
card rhythm. The fix: the topbar no longer owns the header text —
each plugin exports its own header React component, mounted by the
shell via a new `mountHeader` function that mirrors the existing
`mount` / `mountHomeWidget` pattern.

**Plugin side** (every plugin with `app.tsx` now does this):

```tsx
function Header() {
  return (
    <div className="flex items-baseline gap-3 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] whitespace-nowrap m-0 truncate">
        TDP Control
      </h1>
      <span className="text-xs text-base-content/50 tracking-[0.02em] truncate">
        OneXPlayer APEX · CPU/GPU power limits
      </span>
    </div>
  );
}

export function mountHeader(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <Header />
    </PluginProvider>,
  );
  return () => root.unmount();
}
```

**Shell side**:
- `packages/overlay/src/components/PluginHeaderHost.tsx` — host that
  dynamically imports the plugin bundle and calls `mountHeader`.
  Falls back to a simple `<title> · <subtitle>` row from plugin
  metadata when a plugin doesn't opt in.
- `packages/overlay/src/App.tsx` — topbar now renders
  `<PluginHeaderHost key={plugin.id} plugin={plugin} />` for plugin
  views, and `<DefaultHeader>` for Home / Settings.

This keeps each plugin the single source of truth for its own chrome
and lets plugins surface live state (battery %, fan RPM, etc.) in the
topbar if they want to later.

### Bundle cache

`packages/overlay/src/lib/backend.ts` — `importPluginBundle` now
caches the resolved module promise by plugin id.

Three independent call sites import plugin bundles:

- `hooks/usePluginIcons.ts` — at sidebar mount, loads every plugin
  bundle once to read its `icon` export. ~26 imports at boot.
  Intentional trade-off: plugins are needed eventually anyway and
  pre-loading primes the cache for the first nav.
- `components/PluginHost.tsx` — on every plugin-view activation, to
  call `mount(container)`.
- `components/PluginHeaderHost.tsx` — on every plugin-view
  activation, to call `mountHeader(container)`. **New in this
  branch.**
- `components/WidgetPicker.tsx` — on open, probes every plugin for a
  `mountHomeWidget` export.
- `lib/pluginInit.ts` — at boot, calls `init()` on plugins that
  declare `startupInit: true`.

**Before the cache**: every navigation re-fetched and re-`import`-ed
the bundle, and the header host doubled that to two fetches per nav.
8 themes × 26 nav × 2 fetches = ~416 permanent blob-module graphs
sitting in the JS engine on top of the boot-time ~26. The renderer
ran out of memory around nav #145.

**After the cache**: ~26 fetches at boot (`usePluginIcons`), zero
additional fetches for any subsequent host — everything hits the
cache. Cache drops on page reload (which is how dev / reinstall
refreshes bundles anyway).

### React unmount fix

Both `PluginHost` and `PluginHeaderHost` previously followed
`root.unmount()` with `container.innerHTML = ""`. Racing a raw wipe
against React's own effect-cleanup throws `NotFoundError: Failed to
execute 'removeChild' on 'Node': The node to be removed is not a
child of this node`. Removed — `root.unmount()` already detaches
everything it placed.

## Crash investigation

### Symptom
`python3 scripts/capture-screenshots.py` consistently crashed
~5 themes in (around nav #145 of ~232). CDP WebSocket dropped with
"no close frame received or sent".

### What the logs showed
After forwarding webview `console.*` via CDP to a file
(`/tmp/overlay-logs/capture.log`), two distinct issues:

1. **Bundle memory pressure** — dozens of `[bundle] fetching: …` lines
   with no cache hits meant every single navigation was re-importing
   modules. At the crash boundary, the renderer ran out of memory.
   **Fix**: per-plugin promise cache in `importPluginBundle`.
2. **`NotFoundError` on every unmount** (pre-existing, pre-my-changes
   but amplified to two-per-nav by the new header root).
   **Fix**: stop wiping `innerHTML` after `root.unmount()`.

After both fixes, the full run (8 themes × 29 views = 232 captures)
completes without a single exception beyond the expected-and-benign
pre-auth `HTTP 401 /plugins` race on boot.

## How to capture logs from the overlay after a crash

### Bun-side and CEF startup logs (always)

```
journalctl --user -u loadout-overlay.service --since "5 minutes ago" --no-pager
```

Captures:
- `src/bun/index.ts` output (input-intercept, display-detect, etc.)
- CEF startup flags (`[CEF] Applying user chromium flag: …`)
- Helper-process sandbox / DBus warnings
- Anything written to stderr by the launcher process

### Webview `console.*` logs (during a run)

CEF's `enable-logging=stderr` with `log-severity=info` does **not**
forward JavaScript `console.*` output to the helper's stderr — only
Chromium-internal log messages. Webview logs have to come out via
CDP.

The script at `scripts/capture-screenshots.py` uses CDP for
navigation. Pair it with a passive log watcher on a second CDP
connection (multiple clients on :9222 work fine):

```bash
# In one terminal — persistent log drain
python3 /tmp/cdp-watch.py > /tmp/overlay-logs/capture.log &

# Normal workflow
python3 scripts/capture-screenshots.py
```

`cdp-watch.py` subscribes to `Runtime.consoleAPICalled` and
`Runtime.exceptionThrown`, reconnects on target crashes, and prefixes
every line with a timestamp. Source for the script:
`/tmp/cdp-watch.py` (can be checked in if it proves useful beyond a
one-off).

### Triage breadcrumbs added in-tree

Three lifecycle logs land in the CDP stream on every plugin
navigation — useful as the reference clock when correlating against a
crash:

- `[host] mount: <id>` / `[host] unmount: <id>`
- `[header] mount: <id>` / `[header] unmount: <id>`
- `[bundle] fetching: <id>` / `[bundle] loaded: <id> (Xms, YB, exports=…)` / `[bundle] cache hit: <id>`

Plus a global trap in `main.tsx`:

- `[window.error] …` for anything uncaught that reaches `window`
- `[unhandledrejection] …` for uncaught promise rejections

If the overlay dies mid-run and nothing in the CDP log points to a
specific plugin, check the journal for CEF-side crash reports — the
CEF helpers route those through `--enable-crash-reporter`.

## Build + verify workflow

```bash
bun run build-and-install   # rebuild bundle + reinstall + restart services
sleep 5                      # let overlay boot past splash
python3 scripts/capture-screenshots.py   # 8 themes × 29 views
```

Screenshots land under `screenshots/<theme>/NN-<plugin>.png`. Per
memory, `build-and-install` is preferred over dev mode for accuracy
when validating the actual overlay that ships.
