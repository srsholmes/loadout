#!/bin/sh
# Stage the plugins/ tree + a single shared node_modules/ into a target
# install root, ready to be loaded by the loadout daemon.
#
# Layout produced:
#   <target>/
#     plugins/
#       apex-fixes/{app.tsx,backend.ts,...}     # source only
#       audio-loader/{app.tsx,backend.ts,...}
#       ...
#     node_modules/
#       react/                                  # ONE shared copy
#       react-dom/
#       scheduler/
#       react-icons/                            # 84MB, was duplicated 22x before
#       @loadout/{types,exec,steam-paths,...}
#
# Why hoisted: this is the original plugin architecture — server (Bun
# embedded in the compiled binary) compiles each plugin's backend.ts at
# runtime via `Bun.build()`, which walks up the filesystem looking for
# node_modules. Putting deps once at the install root means
# `<root>/plugins/<plugin>/backend.ts` resolves to `<root>/node_modules`
# via standard Node resolution — no per-plugin duplication needed.
#
# A previous version of install-local.sh copied node_modules into every
# plugin (~89MB × N plugins = ~2GB raw, ~250MB compressed). That was a
# workaround that's no longer necessary; the runtime resolver handles
# upward traversal correctly.
#
# Used by:
#   - scripts/install-local.sh — stages into the user's live install dir
#   - .github/workflows/release.yml — stages into a temp dir which is
#     then tarred into the loadout-plugins-x86_64.tar.xz release
#     asset that the curl|sh installer pulls down.
#
# Usage:
#   sh scripts/prepare-plugins.sh <target-install-root>
#
# All plugin package.json declared dependencies (currently react,
# react-dom, scheduler, react-icons, plus @loadout/*) get hoisted
# into <target>/node_modules. If a future plugin pulls in a non-shared
# dep, this script copies it there too.
set -e

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    echo "usage: $0 <target-install-root>" >&2
    echo "stages plugin sources into <target>/plugins/ and shared deps into <target>/node_modules/" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -d "$PROJECT_ROOT/plugins" ]; then
    echo "ERROR: $PROJECT_ROOT/plugins not found" >&2
    exit 1
fi

PLUGINS_DST="$TARGET/plugins"
NM_DST="$TARGET/node_modules"

# Plugin sources. Clean first so deleted plugins don't linger.
rm -rf "$PLUGINS_DST"
mkdir -p "$PLUGINS_DST"
cp -r "$PROJECT_ROOT/plugins/"* "$PLUGINS_DST/" 2>/dev/null || true
# Stale backend bundle caches confuse the rebuild check (cp gives the
# cache the same mtime as the source). The server rebuilds on first run.
find "$PLUGINS_DST" -path '*/.cache/backend.bundle.js' -delete 2>/dev/null || true

# Shared node_modules. Wipe and re-stage so deleted deps don't linger.
rm -rf "$NM_DST"
mkdir -p "$NM_DST/@loadout"

# Workspace packages used by plugins. Add new packages here when a
# plugin starts importing them (e.g. plugin-storage for tdp-control /
# fan-control / playtime).
for pkg in types exec steam-paths ui plugin-storage vdf external-cache; do
for pkg in types exec steam-paths ui plugin-storage external-cache; do
    if [ -d "$PROJECT_ROOT/packages/$pkg" ]; then
        cp -r "$PROJECT_ROOT/packages/$pkg" "$NM_DST/@loadout/$pkg"
    fi
done

# react/react-dom/scheduler for the runtime vendor bundle build;
# react-icons so plugins can export an icon component without declaring
# it as a dep themselves.
for dep in react react-dom scheduler react-icons; do
    if [ -d "$PROJECT_ROOT/node_modules/$dep" ]; then
        cp -r "$PROJECT_ROOT/node_modules/$dep" "$NM_DST/$dep"
    else
        echo "WARN: $PROJECT_ROOT/node_modules/$dep not found — run 'bun install' first" >&2
    fi
done

# Catch-all for any per-plugin non-workspace, non-react dep. Today
# every plugin only declares the four shared react packages and
# @loadout/*, so this loop is a no-op — but it's here so a new
# plugin pulling in (say) react-hotkeys-hook just works without a
# script edit.
for plugin_dir in "$PLUGINS_DST"/*/; do
    [ -d "$plugin_dir" ] || continue
    [ -f "$plugin_dir/package.json" ] || continue
    bun -e "const p=require('$plugin_dir/package.json').dependencies||{};for(const k of Object.keys(p))if(!k.startsWith('@loadout/')&&!['react','react-dom','scheduler','react-icons'].includes(k))console.log(k)" 2>/dev/null | while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        [ -d "$NM_DST/$dep" ] && continue
        if [ -d "$PROJECT_ROOT/node_modules/$dep" ]; then
            case "$dep" in
                @*/*) mkdir -p "$NM_DST/${dep%/*}" ;;
            esac
            cp -r "$PROJECT_ROOT/node_modules/$dep" "$NM_DST/$dep"
        fi
    done
done

PLUGIN_COUNT=$(find "$PLUGINS_DST" -mindepth 1 -maxdepth 1 -type d | wc -l)
NM_COUNT=$(find "$NM_DST" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | wc -l)
# Only sum the two dirs we actually staged — $TARGET may already contain
# runtime caches (sound-packs/, css-themes/, plugin storage JSON) and the
# overlay tree from previous installs.
STAGED_SIZE=$(du -ch "$PLUGINS_DST" "$NM_DST" 2>/dev/null | awk '/total$/ {print $1; exit}')
echo "Staged $PLUGIN_COUNT plugins + $NM_COUNT hoisted modules into $TARGET ($STAGED_SIZE)"
