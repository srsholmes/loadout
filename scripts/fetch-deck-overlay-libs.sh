#!/bin/sh
# Fetch the libwebkit2gtk-4.1 + transitive closure SteamOS doesn't ship.
#
# Why: the Electrobun overlay's native wrapper (libNativeWrapper.so) dlopens
# libwebkit2gtk-4.1.so.0 + libjavascriptcoregtk-4.1.so.0 + libayatana-
# appindicator3.so.1 at startup. Bazzite, CachyOS, and Fedora-ostree all
# ship these in the base image — SteamOS Holo does not. Without them, the
# overlay crashes immediately on every `loadout-overlay.service` start.
#
# Strategy: spin up a Fedora 42 container (matches SteamOS Holo 3.7's glibc
# 2.41), let dnf resolve weak-but-relevant deps, ldd-walk the closure from
# the three top-level SOs we need, filter out always-present system libs
# (libc, libm, ld-linux, etc. — would overshadow the deck's own and break
# everything else if shipped), and tar up the rest. Cache the result so we
# only pay the container spin-up once.
#
# Usage:   fetch-deck-overlay-libs.sh <target-bin-dir>
# Example: fetch-deck-overlay-libs.sh ~/.local/share/loadout-overlay/bin
#
# On non-SteamOS hosts this is a no-op (Bazzite/CachyOS/Fedora ship the libs
# system-wide). On SteamOS without podman it warns and exits non-zero — the
# user needs to install podman (or build their own closure) before the
# overlay will run.
set -eu

TARGET_DIR="${1:-}"
if [ -z "$TARGET_DIR" ]; then
    echo "usage: $0 <target-bin-dir>" >&2
    echo "  e.g. $0 ~/.local/share/loadout-overlay/bin" >&2
    exit 2
fi

# Capability gate, not distro-ID. Earlier versions of this script checked
# `ID=steamos` from /etc/os-release and skipped on anything else — that was
# wrong for Bazzite-Deck, custom Arch-on-Deck, and any future SteamOS variant
# that drops webkit2gtk-4.1: the overlay would crash with the original
# DLOPEN error this script is meant to prevent, with no breadcrumb. The
# actual invariant we care about is "the system already provides
# libwebkit2gtk-4.1.so.0" — Bazzite/CachyOS/Fedora-ostree ship it and short-
# circuit here; SteamOS Holo doesn't and falls through to the fetch path.
if ldconfig -p 2>/dev/null | grep -q "libwebkit2gtk-4.1.so.0"; then
    echo "[fetch-deck-libs] libwebkit2gtk-4.1.so.0 already on system — nothing to do."
    exit 0
fi

if ! command -v podman >/dev/null 2>&1; then
    echo "[fetch-deck-libs] ERROR: podman is not installed." >&2
    echo "  SteamOS Holo 3.7+ ships podman in the base image. If it's missing," >&2
    echo "  install it via your package manager (or your usual SteamOS escape" >&2
    echo "  hatch) before re-running install-local." >&2
    exit 1
fi

# Cache key is a hash over the inputs that actually shape the output —
# Fedora image tag + the dnf package list. A contributor editing the
# package list (below) automatically invalidates stale caches; manual
# CLOSURE_REV bumps that used to be required (and forgettable) are gone.
# The tag itself is intentionally part of the hash too, so flipping
# LOADOUT_DECK_FEDORA_IMAGE forces a rebuild on next run.
FEDORA_IMAGE="${LOADOUT_DECK_FEDORA_IMAGE:-fedora:42}"
CLOSURE_PACKAGES="webkit2gtk4.1 libayatana-appindicator-gtk3 gstreamer1-plugins-base gstreamer1-plugins-good"
CLOSURE_INPUTS_HASH="$(printf '%s\n%s\n' "$FEDORA_IMAGE" "$CLOSURE_PACKAGES" | sha256sum | cut -c1-12)"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/loadout/deck-overlay-libs"
CACHE_TAR="$CACHE_DIR/closure-${CLOSURE_INPUTS_HASH}.tar.zst"
mkdir -p "$CACHE_DIR"

if [ ! -f "$CACHE_TAR" ]; then
    echo "[fetch-deck-libs] Building closure (this runs once — cached at $CACHE_TAR)…"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    # The container script: install packages, ldd-walk the three roots,
    # filter, copy survivors into /out/lib.
    #
    # The "always present on a vanilla SteamOS" denylist below comes from
    # `ldconfig -p` on a stock Holo 3.7 + ldd on Bazzite's webkit. These
    # are libs the deck's runtime owns — shadowing them would break ld.so
    # itself or every other process the launcher inherits env from.
    # `libgcc_s` / `libstdc++` are tricky (an older Bazzite C++ ABI on a
    # newer Deck glibc is fine; the other direction is not) — we keep them
    # OUT of the closure and rely on the system's, since SteamOS Holo's
    # gcc is recent enough.
    cat > "$TMP_DIR/build-closure.sh" <<'CONTAINER_EOF'
#!/bin/bash
set -euo pipefail
# Package list comes in via $1 so it stays the single source of truth that
# also feeds the cache-key hash on the host side. Without that linkage,
# editing the list and forgetting to bump CLOSURE_REV used to silently
# leave every install on the stale closure.
read -ra PKGS <<<"$1"
dnf install -y --setopt=install_weak_deps=False --quiet "${PKGS[@]}"

mkdir -p /out/lib

# Denylist — never copy these out of the container; the host owns them.
DENY_REGEX='^(libc|libm|libpthread|libdl|librt|libresolv|libnsl|libutil|libcrypt|libgcc_s|libstdc\+\+|ld-linux-x86-64|linux-vdso|libanl|libBrokenLocale|libmvec|libthread_db)\.so'

# Walk transitively from the three top-level SOs we care about, plus the
# gstreamer plugin loaders (webkit invokes them at runtime via gst's
# plugin discovery, not via dlopen of named-soname plugins — gst-inspect
# would be authoritative but pulling the whole gstreamer1-plugins-* set
# is the simpler / more-correct choice).
ROOTS=(
    /usr/lib64/libwebkit2gtk-4.1.so.0
    /usr/lib64/libjavascriptcoregtk-4.1.so.0
    /usr/lib64/libayatana-appindicator3.so.1
)

declare -A SEEN=()
declare -a QUEUE=()
for r in "${ROOTS[@]}"; do
    [ -e "$r" ] || { echo "missing root: $r" >&2; exit 1; }
    QUEUE+=("$r")
done

while [ ${#QUEUE[@]} -gt 0 ]; do
    cur="${QUEUE[0]}"
    QUEUE=("${QUEUE[@]:1}")
    real="$(readlink -f "$cur")"
    [ -n "${SEEN[$real]:-}" ] && continue
    SEEN[$real]=1
    base="$(basename "$real")"
    if [[ "$base" =~ $DENY_REGEX ]]; then
        continue
    fi
    cp -L "$real" "/out/lib/$base"
    # Walk transitive deps via ldd. Filter to paths inside /usr/lib64 so
    # we don't chase /lib64 (symlinks to the same) twice.
    ldd "$real" 2>/dev/null | awk '/=> \// {print $3}' | while read -r dep; do
        [ -n "$dep" ] || continue
        case "$dep" in
            /usr/lib64/*|/lib64/*) ;;
            *) continue ;;
        esac
        echo "$dep"
    done | sort -u > /tmp/cur-deps
    while IFS= read -r dep; do
        depBase="$(basename "$dep")"
        if [[ "$depBase" =~ $DENY_REGEX ]]; then
            continue
        fi
        depReal="$(readlink -f "$dep")"
        if [ -z "${SEEN[$depReal]:-}" ]; then
            QUEUE+=("$dep")
        fi
    done < /tmp/cur-deps
done

# Re-create the soname symlinks ldd would follow on the deck — many libs
# present here as `libfoo.so.1.2.3` are dlopen'd by SONAME `libfoo.so.1`.
# `ldconfig -n /out/lib` builds those links for us without polluting the
# system cache.
ldconfig -n /out/lib

# Anything the deck already owns is filtered host-side (the `/usr/lib*`
# basename walk in the extract step below), not here — the in-container
# DENY_REGEX above is the only build-time filter.

count=$(find /out/lib -maxdepth 1 -type f | wc -l)
links=$(find /out/lib -maxdepth 1 -type l | wc -l)
echo "[container] closure: $count files + $links soname symlinks"
CONTAINER_EOF
    chmod +x "$TMP_DIR/build-closure.sh"

    # The image tag (default `fedora:42`) floats with whatever the registry
    # publishes — fine for now, but the tag will eventually retire at EOL
    # and `podman run` then returns "manifest unknown" with no breadcrumb
    # back to this script. Surface the env-var escape hatch on any failure
    # so the operator knows where to point at a newer image.
    PODMAN_RC=0
    podman run --rm \
        -v "$TMP_DIR:/script:Z" \
        -v "$TMP_DIR:/out:Z" \
        "$FEDORA_IMAGE" \
        bash /script/build-closure.sh "$CLOSURE_PACKAGES" || PODMAN_RC=$?
    if [ "$PODMAN_RC" -ne 0 ]; then
        echo "[fetch-deck-libs] ERROR: 'podman run $FEDORA_IMAGE' exited $PODMAN_RC." >&2
        echo "  Common causes:" >&2
        echo "  - The image tag '$FEDORA_IMAGE' has been retired from the registry." >&2
        echo "    Override with LOADOUT_DECK_FEDORA_IMAGE=<a current image>:" >&2
        echo "      LOADOUT_DECK_FEDORA_IMAGE=quay.io/fedora/fedora:42 bun run install-local" >&2
        echo "  - Rootless podman storage is misconfigured (\`podman info\` to inspect)." >&2
        echo "  - The container had no network and couldn't reach the dnf mirrors." >&2
        exit 1
    fi

    # Tar up the populated lib dir for the cache.
    if [ ! -d "$TMP_DIR/lib" ] || [ -z "$(ls -A "$TMP_DIR/lib")" ]; then
        echo "[fetch-deck-libs] ERROR: container produced an empty closure." >&2
        exit 1
    fi
    tar -C "$TMP_DIR" -cf - lib | zstd -q -o "$CACHE_TAR"
    echo "[fetch-deck-libs] Cached $CACHE_TAR ($(du -h "$CACHE_TAR" | cut -f1))"
fi

# Extract into target. Use bsdtar (libarchive) since it handles zstd in
# one shot; tar+zstd works too but is a two-pipe dance.
#
# Cache safety: the tarball lives under the user's writable cache, so a
# corrupted/replaced tar could in principle ship a path-traversed entry or
# a symlink pointing outside EXTRACT_TMP. `--no-same-owner` discards owner
# metadata; `--secure-symlinks` makes bsdtar reject symlinks whose targets
# escape the extract root. The per-entry sanity check after extraction is
# the second belt — assert the tree is exactly `lib/` and nothing else.
mkdir -p "$TARGET_DIR"
EXTRACT_TMP="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_TMP"' EXIT
bsdtar -C "$EXTRACT_TMP" --no-same-owner --secure-symlinks -xf "$CACHE_TAR"
if [ ! -d "$EXTRACT_TMP/lib" ] || \
   [ -n "$(find "$EXTRACT_TMP" -maxdepth 1 -mindepth 1 ! -name lib -print -quit)" ]; then
    echo "[fetch-deck-libs] ERROR: cache tarball has unexpected structure." >&2
    echo "  Expected exactly $EXTRACT_TMP/lib/, got: $(ls -A "$EXTRACT_TMP")" >&2
    echo "  Delete $CACHE_TAR and re-run to rebuild from scratch." >&2
    exit 1
fi

# Build the set of .so basenames the Deck already owns. Public sonames
# (`ldconfig -p`) aren't enough — many libraries the deck has are loaded
# privately by basename from `/usr/lib/<subdir>/`, e.g.
# `/usr/lib/pulseaudio/libpulsecommon-17.0.so`. If we ship Fedora's copy
# of one of those, LD_LIBRARY_PATH=./ means our copy wins, the deck's
# own loader (libpulse, libcanberra, etc.) gets the WRONG private dep,
# and the overlay crashes at dlopen time with `undefined symbol:
# pa_in_valgrind` and the like. Walk the whole `/usr/lib*` tree so we
# catch those too.
DECK_LIBS_TMP="$EXTRACT_TMP/deck-libs.txt"
find /usr/lib /usr/lib64 -name '*.so*' -type f 2>/dev/null \
    | xargs -n1 basename 2>/dev/null \
    | sort -u > "$DECK_LIBS_TMP"

# Electrobun's launcher sets LD_LIBRARY_PATH=./ (its bin/ cwd) — it does
# NOT add `./lib`. So the closure must sit alongside the launcher itself,
# not in a lib/ subdir. Move every closure entry into $TARGET_DIR — but
# - skip files that already exist (Electrobun's own libEGL.so / libGLESv2.so
#   are kept; we never shadow the bundle).
# - skip files the deck owns (`/usr/lib*/<basename>` exists). Letting the
#   deck's loader resolve via system paths preserves CEF/Chromium's
#   carefully-matched ABI with the deck's libgtk/libcairo/libglib/etc.
moved=0
skipped_existing=0
skipped_deck=0
for entry in "$EXTRACT_TMP/lib/"*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    if [ -e "$TARGET_DIR/$base" ]; then
        skipped_existing=$((skipped_existing + 1))
        continue
    fi
    if grep -qxF "$base" "$DECK_LIBS_TMP"; then
        skipped_deck=$((skipped_deck + 1))
        continue
    fi
    # Use cp -a so we keep symlinks as symlinks (mv -L would dereference).
    cp -a "$entry" "$TARGET_DIR/$base"
    moved=$((moved + 1))
done
if [ "$skipped_existing" -gt 0 ]; then
    echo "[fetch-deck-libs] kept $skipped_existing existing bundled libs (Electrobun's own)"
fi
if [ "$skipped_deck" -gt 0 ]; then
    echo "[fetch-deck-libs] skipped $skipped_deck libs the deck owns (deck's loader will resolve them)"
fi

# Final smoke: the three top-level sonames must resolve in the target dir.
TEST_LIBS="libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 libayatana-appindicator3.so.1"
for lib in $TEST_LIBS; do
    if [ ! -e "$TARGET_DIR/$lib" ]; then
        echo "[fetch-deck-libs] ERROR: $lib missing in $TARGET_DIR — closure build is broken." >&2
        exit 1
    fi
done

echo "[fetch-deck-libs] Closure installed into $TARGET_DIR ($(find "$TARGET_DIR" -maxdepth 1 -name '*.so*' | wc -l) so files)"
