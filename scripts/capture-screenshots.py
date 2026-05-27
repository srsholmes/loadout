"""
Capture overlay screenshots in light + dark themes, across every plugin,
the homepage (sidebar expanded + collapsed), and the settings page.

Targets the overlay's own CDP session (filtered by title), drives the app
via `location.hash` for routing and flips the sidebar state by clicking
the toggle button. Theme is set via `document.documentElement`'s
`data-theme` attribute so we don't pollute the user's persisted
preference.
"""

import json, base64, time, os, re, sys, urllib.request
from pathlib import Path
from websockets.sync.client import connect

# Repo root, derived from this script's location so the capture
# script runs the same way for every contributor regardless of where
# they checked out the repo.
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "screenshots"

# Source of truth: every plugin directory under `plugins/` that has
# a `package.json` OR a `plugin.json` (the standalone loader
# manifest some plugins use). Skips stale `.cache`-only leftovers
# like the `browser/` dir post-quick-links-fold. Sorted
# alphabetically so the numbered output filenames are stable
# across runs.
#
# Keep this filter in sync with `loadPluginMeta` in
# `scripts/scaffold-plugin-readmes.ts` — both must agree on which
# directories are "real plugins" so the per-theme numbered shots
# and the per-plugin asset copies always cover the same set.
PLUGINS = sorted(
    p.name
    for p in (ROOT / "plugins").iterdir()
    if p.is_dir()
    and ((p / "package.json").exists() or (p / "plugin.json").exists())
)

def cdp_ws():
    targets = json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
    for t in targets:
        if t.get("title") == "Loadout Overlay":
            return t["webSocketDebuggerUrl"]
    print("overlay target not found", file=sys.stderr)
    sys.exit(1)

class CDP:
    def __init__(self, url):
        self.ws = connect(url, max_size=20*1024*1024)
        self.id = 0
    def call(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.id:
                return msg
    def eval(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate",
                      expression=expr,
                      returnByValue=True,
                      awaitPromise=await_promise)
        return r.get("result", {}).get("result", {}).get("value")
    def screenshot(self, path):
        r = self.call("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        data = r.get("result", {}).get("data")
        if not data:
            raise RuntimeError(f"no data: {r}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(data))
        print(f"  → {path.relative_to(ROOT)}")

CURRENT_THEME = {"value": "midnight"}

def set_theme(cdp, theme):
    CURRENT_THEME["value"] = theme
    cdp.eval(f"document.documentElement.setAttribute('data-theme','{theme}')")

def navigate(cdp, hash_path):
    cdp.eval(f"location.hash='{hash_path}'; void 0")
    time.sleep(0.6)  # let plugin mount + fetch data
    # Re-apply the theme after navigation — Settings.tsx syncs theme
    # from the persisted config on every mount, which would otherwise
    # revert a capture-time theme swap.
    cdp.eval(
        f"document.documentElement.setAttribute('data-theme','{CURRENT_THEME['value']}')"
    )
    time.sleep(0.1)

def set_sidebar_collapsed(cdp, collapsed):
    # The toggle is a Focusable button; flipping the checkbox directly
    # updates the drawer classes but not React state. Instead click the
    # actual button so React's onClick runs.
    expr = f"""
    (function(){{
      const input = document.getElementById('sl-drawer');
      if (input.checked === {'false' if collapsed else 'true'}) return 'already';
      const btn = document.querySelector('[aria-label="Toggle sidebar"]');
      btn && btn.click();
      return 'clicked';
    }})()
    """
    cdp.eval(expr)
    time.sleep(0.25)

def copy_to_plugin_assets():
    """After capture, copy each plugin's `midnight` shot into the
    per-plugin `assets/` dir so the plugin's README (and the root
    README's plugin gallery) can reference a stable path that lives
    next to the source.

    Per-theme dumps stay under top-level `screenshots/<theme>/` for
    development diff-checking; per-plugin assets are the single
    "default" shot the docs link to.
    """
    import shutil
    src_dir = OUT / "midnight"
    if not src_dir.exists():
        print(f"[copy] {src_dir} missing — run a capture first", file=sys.stderr)
        return
    for i, pid in enumerate(PLUGINS, start=3):
        src = src_dir / f"{i:02d}-{pid}.png"
        if not src.exists():
            print(f"[copy] skip {pid}: {src.name} not captured")
            continue
        dest_dir = ROOT / "plugins" / pid / "assets"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / "screenshot.png"
        shutil.copy2(src, dest)
        print(f"[copy] {pid} → {dest.relative_to(ROOT)}")

def expected_filenames() -> set[str]:
    """The set of filenames every per-theme directory SHOULD have
    after a capture pass. Anything else is stale (plugin renamed,
    dropped, or replaced) and should be culled so the screenshots/
    tree doesn't accrete dead shots from the alphabetical-renumber
    that lands when a new plugin is added in the middle of the list.
    """
    files = {"00-home.png", "01-settings.png", "02-home-sidebar-collapsed.png"}
    for i, pid in enumerate(PLUGINS, start=3):
        files.add(f"{i:02d}-{pid}.png")
    return files

# Filename shape this script owns. Anything matching `NN-name.png`
# is potentially-stale capture output; anything NOT matching is left
# alone (e.g. a contributor's debug `notes.png` dropped in a theme
# dir won't be culled).
_CAPTURE_FILENAME = re.compile(r"^\d{2}-.*\.png$")

def cull_stale_screenshots():
    """Remove screenshots/<theme>/<num>-<old-name>.png entries that
    don't match the current expected filename set. Idempotent on a
    freshly-captured tree.

    Only touches files matching the `NN-name.png` shape this script
    generates — unrelated PNGs dropped into a theme dir for any
    reason (debugging, hand-edits) are left alone."""
    expected = expected_filenames()
    for theme_dir in OUT.glob("*"):
        if not theme_dir.is_dir():
            continue
        for png in theme_dir.glob("*.png"):
            if not _CAPTURE_FILENAME.match(png.name):
                continue
            if png.name not in expected:
                print(f"[cull] removed {png.relative_to(ROOT)} (stale)")
                png.unlink()

def main():
    # `--copy-only` and `--cull-only` skip the capture pass entirely.
    # They COMPOSE — running `--cull-only --copy-only` does both in
    # sensible order (cull first so any newly-orphaned shots don't
    # get propagated into the per-plugin assets dir). Without either
    # flag, the full pass runs: capture → cull → copy.
    only_flags = {"--copy-only", "--cull-only"}.intersection(sys.argv)
    if only_flags:
        if "--cull-only" in only_flags:
            cull_stale_screenshots()
        if "--copy-only" in only_flags:
            copy_to_plugin_assets()
        return

    cdp = CDP(cdp_ws())
    for theme in ["midnight", "paper", "synth", "terminal", "nord", "dracula", "gruvbox", "tokyo"]:
        print(f"[{theme}]")
        set_theme(cdp, theme)
        # sidebar expanded
        set_sidebar_collapsed(cdp, False)
        # home
        navigate(cdp, "#/")
        cdp.screenshot(OUT / theme / "00-home.png")
        # settings
        navigate(cdp, "#/settings")
        cdp.screenshot(OUT / theme / "01-settings.png")
        # sidebar collapsed (on home)
        navigate(cdp, "#/")
        set_sidebar_collapsed(cdp, True)
        cdp.screenshot(OUT / theme / "02-home-sidebar-collapsed.png")
        set_sidebar_collapsed(cdp, False)
        # each plugin
        for i, pid in enumerate(PLUGINS, start=3):
            navigate(cdp, f"#/plugin/{pid}")
            cdp.screenshot(OUT / theme / f"{i:02d}-{pid}.png")

    cull_stale_screenshots()
    copy_to_plugin_assets()

if __name__ == "__main__":
    main()
