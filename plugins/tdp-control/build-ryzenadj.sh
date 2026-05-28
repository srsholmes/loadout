#!/bin/sh
# Build the bundled ryzenadj binary for this plugin.
#
# Why bundled: stock SteamOS doesn't ship ryzenadj and `/usr` is read-only,
# so the user can't `pacman -S` it. We ship it inside the plugin per the
# `bundled_bins` convention (see docs/plugin-development.md and this
# plugin's package.json). ~104 KB.
#
# Why build in a pinned arch container: SteamOS 3.7.x ships glibc 2.41.
# Building against a newer glibc would produce a binary that fails on the
# Deck with "GLIBC_X.Y not found". archlinux:base-20250727 is glibc 2.41 —
# matches the Deck and runs forward on Bazzite (2.42+), CachyOS, etc.
#
# Why source-build (not pacman): ryzenadj is in AUR, not the main Arch
# repos. Building it ourselves also lets us pin the upstream tag.
#
# Output (next to this script): bin/linux-x64/{ryzenadj,LICENSE-ryzenadj,SOURCE.txt}.
#
# Requires: podman (or docker — set LOADOUT_BUNDLE_CONTAINER=docker).
# Idempotent.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/bin/linux-x64"

RYZENADJ_TAG="${RYZENADJ_TAG:-v0.19.0}"
ARCH_IMAGE="${LOADOUT_ARCH_IMAGE:-archlinux:base-20250727.0.390543}"
ARCH_DATE="${LOADOUT_ARCH_DATE:-2025/07/27}"

ENGINE="${LOADOUT_BUNDLE_CONTAINER:-}"
if [ -z "$ENGINE" ]; then
    if command -v podman >/dev/null 2>&1; then ENGINE="podman"
    elif command -v docker >/dev/null 2>&1; then ENGINE="docker"
    else
        echo "ERROR: need podman or docker. Set LOADOUT_BUNDLE_CONTAINER=skip to bypass." >&2
        exit 1
    fi
fi

if [ "$ENGINE" = "skip" ]; then
    echo "[build-ryzenadj] LOADOUT_BUNDLE_CONTAINER=skip — bypassed."
    exit 0
fi

mkdir -p "$OUT_DIR"

echo "[build-ryzenadj] building ryzenadj $RYZENADJ_TAG in $ARCH_IMAGE..."

"$ENGINE" run --rm \
    -v "$OUT_DIR:/work:Z" \
    -e RYZENADJ_TAG="$RYZENADJ_TAG" \
    -e ARCH_DATE="$ARCH_DATE" \
    "$ARCH_IMAGE" \
    sh -c '
        set -e
        echo "Server = https://archive.archlinux.org/repos/$ARCH_DATE/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist
        sed -i "s/^SigLevel.*/SigLevel = Never/" /etc/pacman.conf
        pacman -Sy --noconfirm git cmake gcc make pkgconf pciutils >/dev/null

        cd /tmp
        git clone --branch "$RYZENADJ_TAG" --depth 1 https://github.com/FlyGoat/RyzenAdj.git
        cd RyzenAdj
        HEAD_SHA="$(git rev-parse --short HEAD)"

        mkdir build && cd build
        # BUILD_SHARED_LIBS=OFF folds libryzenadj into the CLI binary so we
        # ship a single file (no sidecar .so).
        cmake -DBUILD_SHARED_LIBS=OFF .. >/dev/null
        make ryzenadj -j"$(nproc)" >/dev/null

        install -m 0755 ryzenadj /work/ryzenadj
        cp ../LICENSE /work/LICENSE-ryzenadj
        cat > /work/SOURCE.txt <<EOF
ryzenadj
upstream: https://github.com/FlyGoat/RyzenAdj
tag:      $RYZENADJ_TAG
commit:   $HEAD_SHA
built in: archlinux:base-20250727.0.390543 (glibc 2.41)

Rebuild with: plugins/tdp-control/build-ryzenadj.sh
EOF
    '

echo "[build-ryzenadj] done:"
ls -lh "$OUT_DIR"
