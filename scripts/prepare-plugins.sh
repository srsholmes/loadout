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

# Strip per-plugin node_modules. Bun creates one for every workspace
# package on `bun install` and the symlinks inside point at
# ../../../node_modules/.bun/<pkg>@<ver>/... (the source repo's .bun
# store) or at ../../../../packages/<pkg> (the workspace packages).
# Neither path resolves in the install layout — the .bun store and the
# packages/ dir aren't staged, so every symlink is a dangling pointer.
# Bun's runtime resolver hits these broken symlinks first and fails
# inconsistently (sometimes walks past, sometimes errors with "File not
# found" before reaching the hoisted node_modules at $NM_DST). Removing
# them lets resolution walk straight up from plugins/<id>/<file> to
# $TARGET/node_modules/, which is populated correctly below.
find "$PLUGINS_DST" -mindepth 2 -maxdepth 2 -name node_modules -type d -exec rm -rf {} +

# Shared node_modules. Wipe and re-stage so deleted deps don't linger.
rm -rf "$NM_DST"
mkdir -p "$NM_DST/@loadout"

# Why `cp -RL` (dereference) instead of `cp -r` everywhere below:
# `bun install` puts every node_modules entry as a symlink into the
# repo-local `.bun/` content store (e.g. `node_modules/react ->
# .bun/react@18.3.1/node_modules/react`). A bare `cp -r` copies the
# *symlink*, not the target — so the install root ended up with
# `node_modules/react-icons -> .bun/react-icons@5.6.0/...` which is
# dangling because we don't stage `.bun/`. Plugin frontend bundling
# (`Bun.build` with target:"browser") then failed with
# "Could not resolve: react-icons/fa6" because the subpath literally
# didn't exist at the install root. -L follows the link and copies
# real content. Same trap applies to the workspace packages — they
# have their own `node_modules/` with `.bun/`-store symlinks (e.g.
# packages/ui depending on fuzzysort), so we strip those after copy
# and rely on the shared root instead.

# Workspace packages used by plugins — AUTO-DISCOVERED from packages/* so a
# new package never needs hand-adding here. (This used to be a hardcoded list
# that silently broke plugin bundling every time a plugin started importing a
# fresh @loadout/* package — e.g. @loadout/devices.) We key off each
# package.json's real `name` so the staged path matches the import specifier
# even if the folder name ever diverges; non-@loadout dirs are skipped.
for pkg_dir in "$PROJECT_ROOT"/packages/*/; do
    pkg_dir="${pkg_dir%/}"
    [ -f "$pkg_dir/package.json" ] || continue
    name=$(bun -e "process.stdout.write(require('$pkg_dir/package.json').name||'')" 2>/dev/null)
    case "$name" in
        @loadout/*) ;;
        *) continue ;;
    esac
    dst="$NM_DST/$name"
    mkdir -p "$(dirname "$dst")"
    cp -RL "$pkg_dir" "$dst"
    # Drop the workspace's own node_modules — its entries are `.bun/`-store
    # symlinks that resolve in the source repo but not here. Transitive deps
    # are hoisted to $NM_DST below.
    rm -rf "$dst/node_modules"
done

# react/react-dom/scheduler for the runtime vendor bundle build;
# react-icons so plugins can export an icon component without declaring
# it as a dep themselves.
for dep in react react-dom scheduler react-icons; do
    if [ -d "$PROJECT_ROOT/node_modules/$dep" ]; then
        cp -RL "$PROJECT_ROOT/node_modules/$dep" "$NM_DST/$dep"
    else
        echo "WARN: $PROJECT_ROOT/node_modules/$dep not found — run 'bun install' first" >&2
    fi
done

# Catch-all for non-workspace, non-react deps declared by either
# plugins or workspace packages. Plugins pull in their own deps;
# workspace packages (e.g. packages/ui -> fuzzysort, @noriginmedia/*)
# need theirs hoisted too so the stripped per-package node_modules
# resolve via walk-up from $NM_DST/@loadout/<pkg> to $NM_DST.
hoist_deps_from() {
    pj="$1"
    [ -f "$pj" ] || return 0
    bun -e "const p=require('$pj').dependencies||{};for(const k of Object.keys(p))if(!k.startsWith('@loadout/')&&!['react','react-dom','scheduler','react-icons'].includes(k))console.log(k)" 2>/dev/null | while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        [ -d "$NM_DST/$dep" ] && continue
        if [ -d "$PROJECT_ROOT/node_modules/$dep" ] || [ -L "$PROJECT_ROOT/node_modules/$dep" ]; then
            case "$dep" in
                @*/*) mkdir -p "$NM_DST/${dep%/*}" ;;
            esac
            cp -RL "$PROJECT_ROOT/node_modules/$dep" "$NM_DST/$dep"
        fi
    done
}

for plugin_dir in "$PLUGINS_DST"/*/; do
    [ -d "$plugin_dir" ] || continue
    hoist_deps_from "$plugin_dir/package.json"
done

# Hoist transitive deps for EVERY workspace package (not a hand-picked
# subset) — any package staged above may declare non-@loadout deps that its
# stripped node_modules can no longer resolve.
for pkg_dir in "$PROJECT_ROOT"/packages/*/; do
    hoist_deps_from "${pkg_dir%/}/package.json"
done

PLUGIN_COUNT=$(find "$PLUGINS_DST" -mindepth 1 -maxdepth 1 -type d | wc -l)
NM_COUNT=$(find "$NM_DST" -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | wc -l)
# Only sum the two dirs we actually staged — $TARGET may already contain
# runtime caches (sound-packs/, css-themes/, plugin storage JSON) and the
# overlay tree from previous installs.
STAGED_SIZE=$(du -ch "$PLUGINS_DST" "$NM_DST" 2>/dev/null | awk '/total$/ {print $1; exit}')
echo "Staged $PLUGIN_COUNT plugins + $NM_COUNT hoisted modules into $TARGET ($STAGED_SIZE)"
