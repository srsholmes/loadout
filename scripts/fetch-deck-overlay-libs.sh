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

DISTRO_ID=""
[ -r /etc/os-release ] && DISTRO_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
if [ "$DISTRO_ID" != "steamos" ]; then
    # Non-SteamOS hosts already have webkit2gtk-4.1 from their base image.
    # `ldconfig -p` cross-checks below would do the same — but skipping
    # the check entirely on non-Deck distros is cheaper and clearer.
    echo "[fetch-deck-libs] Not SteamOS (ID=$DISTRO_ID) — overlay libs come from the system. Skipping."
    exit 0
fi

# Already-installed bail-out: if a future SteamOS image ships webkit2gtk-4.1
# we should NOT shadow it with our closure.
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

# Cache the produced closure tarball — `podman pull` + `dnf install` runs
# in 60-120s on first call; subsequent installs reuse the tarball for free.
# Bump CLOSURE_REV when the package list / Fedora version changes so old
# caches get rebuilt automatically.
CLOSURE_REV="1"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/loadout/deck-overlay-libs"
CACHE_TAR="$CACHE_DIR/closure-rev$CLOSURE_REV.tar.zst"
mkdir -p "$CACHE_DIR"

if [ ! -f "$CACHE_TAR" ]; then
    echo "[fetch-deck-libs] Building closure (this runs once — cached at $CACHE_TAR)…"
    # Use a tag we can pin; `42` resolves to the latest 42 image which is
    # acceptable churn for now (the closure shape is stable across point
    # releases). Future hardening: pin a digest.
    FEDORA_IMAGE="${LOADOUT_DECK_FEDORA_IMAGE:-fedora:42}"
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
dnf install -y --setopt=install_weak_deps=False --quiet \
    webkit2gtk4.1 \
    libayatana-appindicator-gtk3 \
    gstreamer1-plugins-base \
    gstreamer1-plugins-good

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

# Strip out anything the deck definitely already has at a compatible ABI.
# This list is the second filter — same shape as DENY_REGEX but catches
# libs that snuck past via SONAME rather than basename.
SYSTEM_OWNED='^/lib/(libc|libm|libpthread|libdl|librt|libgcc_s|libstdc\+\+|ld-linux-x86-64)\.so'

count=$(find /out/lib -maxdepth 1 -type f | wc -l)
links=$(find /out/lib -maxdepth 1 -type l | wc -l)
echo "[container] closure: $count files + $links soname symlinks"
CONTAINER_EOF
    chmod +x "$TMP_DIR/build-closure.sh"

    podman run --rm \
        -v "$TMP_DIR:/script:Z" \
        -v "$TMP_DIR:/out:Z" \
        "$FEDORA_IMAGE" \
        bash /script/build-closure.sh

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
mkdir -p "$TARGET_DIR"
EXTRACT_TMP="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_TMP"' EXIT
bsdtar -C "$EXTRACT_TMP" -xf "$CACHE_TAR"

# Electrobun's launcher sets LD_LIBRARY_PATH=./ (its bin/ cwd) — it does
# NOT add `./lib`. So the closure must sit alongside the launcher itself,
# not in a lib/ subdir. Move every closure entry into $TARGET_DIR — but
# skip files that already exist (Electrobun's own libEGL.so / libGLESv2.so
# are kept; webkit's copies stay in the source tree as ignored).
moved=0
skipped=0
for entry in "$EXTRACT_TMP/lib/"*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    if [ -e "$TARGET_DIR/$base" ]; then
        skipped=$((skipped + 1))
        continue
    fi
    # Use cp + rm so we move symlinks correctly (mv -L would dereference).
    cp -a "$entry" "$TARGET_DIR/$base"
    moved=$((moved + 1))
done
if [ "$skipped" -gt 0 ]; then
    echo "[fetch-deck-libs] kept $skipped existing libs (Electrobun's own bundle)"
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
