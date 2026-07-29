#!/bin/sh
# Build + publish a Loadout versioned GitHub release from this machine, using
# the gh CLI. An emergency/offline mirror of .github/workflows/release.yml for
# when CI is unavailable and you must cut a release by hand.
#
# The normal path is `bun run release <minor|patch>` (scripts/release.sh), which
# tags and lets CI build. Use this only as a fallback — and check out the tag
# first (`git checkout vX.Y.Z`) so the binary reports the right version.
#
# Produces the exact assets scripts/install.sh expects, for the host arch:
#   loadout-<arch>                  the compiled loader binary
#   loadout-overlay-<arch>.tar.xz   the Electrobun/CEF overlay tree
#   loadout-plugins-<arch>.tar.xz   plugins/ + one hoisted node_modules/
#   SHA256SUMS                      checksums install.sh verifies against
#
# Publishes a release tagged vX.Y.Z, marked GitHub-"latest" so `releases/latest`
# — which install.sh fetches — points at it.
#
# Prereqs: bun, gh (authenticated: `gh auth login`), xz, tar, sha256sum.
#
# Usage:
#   sh scripts/release-local.sh vX.Y.Z            # build + publish the tag
#   sh scripts/release-local.sh vX.Y.Z --dry-run  # build + package, skip upload
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="srsholmes/loadout"
TAG=""
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        v[0-9]*.[0-9]*.[0-9]*) TAG="$arg" ;;
        *) echo "usage: sh scripts/release-local.sh vX.Y.Z [--dry-run]" >&2; exit 1 ;;
    esac
done
[ -n "$TAG" ] || { echo "missing release tag (vX.Y.Z). usage: sh scripts/release-local.sh vX.Y.Z [--dry-run]" >&2; exit 1; }

case "$(uname -m)" in
    x86_64) ARCH="x86_64" ;;
    aarch64) ARCH="aarch64" ;;
    *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/dist/release"
OVERLAY_TREE="$ROOT/apps/loadout-overlay/build/dev-linux-x64/loadout-overlay-dev"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need bun; need tar; need xz; need sha256sum
[ "$DRY_RUN" = "1" ] || need gh

echo "==> Building (bun run build) ..."
( cd "$ROOT" && bun run build )

if [ ! -f "$ROOT/dist/loadout" ]; then
    echo "build did not produce dist/loadout" >&2; exit 1
fi
if [ ! -d "$OVERLAY_TREE" ]; then
    echo "overlay tree not found at $OVERLAY_TREE (electrobun build may have failed)" >&2; exit 1
fi

rm -rf "$OUT"; mkdir -p "$OUT"

echo "==> Packaging assets for $ARCH ..."
# 1. Loader binary.
cp "$ROOT/dist/loadout" "$OUT/loadout-${ARCH}"

# 2. Overlay tree (strip-components=1 on the install side expects the
#    top-level loadout-overlay-dev/ dir).
tar -C "$(dirname "$OVERLAY_TREE")" -cJf "$OUT/loadout-overlay-${ARCH}.tar.xz" loadout-overlay-dev

# 3. Plugins + hoisted node_modules.
STAGE="$(mktemp -d)"
sh "$ROOT/scripts/prepare-plugins.sh" "$STAGE"
tar -C "$STAGE" -cJf "$OUT/loadout-plugins-${ARCH}.tar.xz" plugins node_modules
rm -rf "$STAGE"

# 4. Checksums (computed from inside $OUT so the file lists bare names,
#    which is what install.sh greps for).
( cd "$OUT" && sha256sum \
    "loadout-${ARCH}" \
    "loadout-overlay-${ARCH}.tar.xz" \
    "loadout-plugins-${ARCH}.tar.xz" \
    > SHA256SUMS )

echo "==> Assets:"
( cd "$OUT" && ls -lh loadout-${ARCH} loadout-overlay-${ARCH}.tar.xz loadout-plugins-${ARCH}.tar.xz SHA256SUMS )

if [ "$DRY_RUN" = "1" ]; then
    echo "==> --dry-run: skipping upload. Assets are in $OUT"
    exit 0
fi

echo "==> Publishing release '$TAG' to $REPO ..."
ASSETS="$OUT/loadout-${ARCH} $OUT/loadout-overlay-${ARCH}.tar.xz $OUT/loadout-plugins-${ARCH}.tar.xz $OUT/SHA256SUMS"
NOTES="Loadout $TAG. Install: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh
Pin this version: LOADOUT_VERSION=$TAG curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    # Re-upload the per-arch assets (and SHA256SUMS) over the existing
    # release. --clobber replaces same-named assets so re-running for the
    # same arch is idempotent; other arches' assets are untouched.
    # shellcheck disable=SC2086
    gh release upload "$TAG" $ASSETS --clobber --repo "$REPO"
    gh release edit "$TAG" --latest --repo "$REPO" >/dev/null
else
    # shellcheck disable=SC2086
    gh release create "$TAG" $ASSETS \
        --repo "$REPO" \
        --title "$TAG" \
        --notes "$NOTES" \
        --latest
fi

echo "==> Done. install.sh will pull this via releases/latest."
