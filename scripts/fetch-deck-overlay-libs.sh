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

# The top-level SONAMEs libNativeWrapper.so dlopens at startup. Any one of
# them missing kills the overlay before it draws a frame, so this list is
# both what the capability gate below tests and what the final smoke test
# at the bottom verifies. Keep it as one list: they drifted apart once and
# the result is the CachyOS bug described below.
TOP_LEVEL_SONAMES="libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 libayatana-appindicator3.so.1"

# Capability gate, not distro-ID. Earlier versions of this script checked
# `ID=steamos` from /etc/os-release and skipped on anything else — that was
# wrong for Bazzite-Deck, custom Arch-on-Deck, and any future SteamOS variant
# that drops webkit2gtk-4.1: the overlay would crash with the original
# DLOPEN error this script is meant to prevent, with no breadcrumb.
#
# It then over-corrected: the gate tested `libwebkit2gtk-4.1.so.0` ALONE and
# took a hit as proof that all three roots were present. They don't travel
# together. CachyOS ships webkit2gtk-4.1 but NOT libayatana-appindicator, so
# the gate short-circuited, nothing was bundled, and the overlay crash-looped
# on `libayatana-appindicator3.so.1: cannot open shared object file` — the
# exact failure this script exists to prevent, reintroduced by the check
# meant to detect it. Reported on CachyOS 2026-08-17 (restart counter 46).
#
# So: skip only when the system provides EVERY root. A partial hit falls
# through to the fetch path, which bundles the closure and defers whatever
# the host already has (see the SONAME skip test further down) — bundling a
# couple of libs CachyOS already owns is a trivially cheaper mistake than
# shipping an overlay that cannot start.
_missing_roots=""
for _soname in $TOP_LEVEL_SONAMES; do
    ldconfig -p 2>/dev/null | grep -q "$_soname" || _missing_roots="$_missing_roots $_soname"
done
if [ -z "$_missing_roots" ]; then
    echo "[fetch-deck-libs] all top-level libs already on system — nothing to do."
    exit 0
fi
echo "[fetch-deck-libs] system is missing:$_missing_roots"

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
# corrupted/replaced tar could in principle ship a path-traversed entry.
# bsdtar's default extraction (no -P) already rejects absolute paths and
# `..` traversal — that's the primary defense. `--no-same-owner` adds the
# defense-in-depth of discarding owner metadata. The per-entry sanity
# check after extraction is the third belt: assert the tree is exactly
# `lib/` and nothing else.
mkdir -p "$TARGET_DIR"
EXTRACT_TMP="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_TMP"' EXIT
bsdtar -C "$EXTRACT_TMP" --no-same-owner -xf "$CACHE_TAR"
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
#
# Match symlinks as well as regular files (`! -type d`, not `-type f`).
# The deck exposes most libraries under two names — the real
# `libfontconfig.so.1.17.0` and the SONAME link `libfontconfig.so.1` —
# and the skip test below needs to see both. Counting only real files
# let two distinct bugs through, both of which shipped:
#   - Fedora's `libfontconfig.so.1.15.0` didn't match the deck's
#     `libfontconfig.so.1.17.0` (different version suffix), so we bundled
#     it. With LD_LIBRARY_PATH=./ our stale copy won, and the deck's own
#     libpangoft2 then failed to relocate against it:
#     `undefined symbol: FcConfigSetDefaultSubstitute`.
#   - The container's `ldconfig -n` SONAME links didn't match either, so
#     they were copied while their real targets were (correctly) skipped
#     as deck-owned — planting dangling links like
#     `libicui18n.so.76 -> libicui18n.so.76.1`. A dangling link is skipped
#     by the loader, which silently falls through to the deck's copy, so
#     the bundle ends up pinned to whatever major the deck ships today.
#     Invisible until the deck moves: ICU 76 -> 78 in the Aug 2026 SteamOS
#     update left the overlay unable to dlopen libNativeWrapper.so at all.
DECK_LIBS_TMP="$EXTRACT_TMP/deck-libs.txt"
# `-printf '%f'` emits the basename in-process. The old `xargs -n1 basename`
# spawned one process PER .so (~4500 on SteamOS), which on the Deck's session
# took minutes (and looked like a hang) — find's own printf does it in <1s.
find /usr/lib /usr/lib64 -name '*.so*' ! -type d -printf '%f\n' 2>/dev/null \
    | sort -u > "$DECK_LIBS_TMP"

# Map each real closure file to the SONAME it is reachable by, so the skip
# test can compare SONAME-to-SONAME instead of comparing version-suffixed
# basenames that drift between distros. `ldconfig -n` already built exactly
# this relation in the container (`libfoo.so.1 -> libfoo.so.1.2.3`), so read
# it back off the symlinks rather than shelling out to objdump/readelf —
# binutils is not guaranteed to be installed on a stock deck.
SONAME_MAP="$EXTRACT_TMP/soname-map.txt"
: > "$SONAME_MAP"
for link in "$EXTRACT_TMP/lib/"*; do
    [ -L "$link" ] || continue
    printf '%s\t%s\n' \
        "$(basename "$(readlink "$link")")" "$(basename "$link")" >> "$SONAME_MAP"
done

# The SONAME an entry is reached by. A soname symlink IS its own soname, so
# it never appears in field 1 and correctly falls through to itself. A real
# file's soname is whatever `ldconfig -n` pointed at it. An entry with no
# link at all also falls back to its own basename, which is right for the
# privately-loaded libs the deck-list walk exists to protect (e.g.
# `libpulsecommon-17.0.so`, where the file name IS the soname).
soname_of() {
    _sn="$(awk -F'\t' -v f="$1" '$1 == f { print $2; exit }' "$SONAME_MAP")"
    [ -n "$_sn" ] || _sn="$1"
    printf '%s\n' "$_sn"
}

# True when the deck provides the SONAME this entry is reached by.
#
# Testing the SONAME and *only* the SONAME is the whole point. Consumers
# link against the SONAME, so the deck owning some other alias — or even
# owning the real versioned file — does not mean the deck can satisfy the
# link. Matching the entry's own basename as well (an earlier version of
# this fix did) reintroduces the librav1e bug: SteamOS ships
# `librav1e.so`, `librav1e.so.0.8` and `librav1e.so.0.8.1` but NOT
# `librav1e.so.0`, which is what the bundled libavif actually needs. The
# basename arm matched `librav1e.so.0.8.1` and skipped the real file,
# while its `librav1e.so.0` link — absent from the deck list — was
# bundled, leaving exactly the dangling link this was meant to eliminate.
#
# Because a link and its target now resolve to the same SONAME, they always
# get the same answer, so a bundled link can never lose its target.
deck_owns() {
    grep -qxF "$(soname_of "$1")" "$DECK_LIBS_TMP"
}

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
    if deck_owns "$base"; then
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

# Belt to the SONAME rule's braces: with link and target now always decided
# together, this should find nothing. It stays as a cheap invariant check
# against a closure whose links don't come from `ldconfig -n`, since a
# dangling link resolves to nothing and only hides which copy the loader
# actually ends up using.
#
# Note this cannot repair an existing broken install: both entry points
# `rm -rf` the overlay tree before calling us (install.sh, install-local.sh),
# so $TARGET_DIR is always a freshly extracted tree and the only links here
# are ones this run just copied.
pruned=0
for link in "$TARGET_DIR"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then
        rm -f "$link"
        pruned=$((pruned + 1))
    fi
done
if [ "$pruned" -gt 0 ]; then
    echo "[fetch-deck-libs] pruned $pruned dangling soname symlink(s)"
fi

# Final smoke: the top-level sonames must resolve in the target dir. Same
# list the capability gate uses — see TOP_LEVEL_SONAMES at the top.
for lib in $TOP_LEVEL_SONAMES; do
    if [ ! -e "$TARGET_DIR/$lib" ]; then
        echo "[fetch-deck-libs] ERROR: $lib missing in $TARGET_DIR — closure build is broken." >&2
        exit 1
    fi
done

# Being present is not the same as being loadable. Resolve each root the way
# the launcher will (LD_LIBRARY_PATH=./ from bin/) and fail loudly on anything
# broken. Every SONAME we defer to the deck is a bet that the deck keeps
# shipping a compatible one; this turns losing that bet into one actionable
# line at install time rather than a crash-loop weeks later, after an OS
# update, with only a dlopen failure to go on.
#
# `-r` (resolve ALL relocations), not a plain `ldd`. Plain `ldd` reports only
# missing DT_NEEDED *files* and is blind to the second failure mode this
# script can produce: a lib that IS present but whose symbols don't resolve.
# That is the fontconfig bug — the deck's own libpangoft2 failing with
# `undefined symbol: FcConfigSetDefaultSubstitute` against a stale bundled
# fontconfig. It matters more the more we defer, since every deferred lib is
# one more chance for the bundled Fedora webkit to meet an incompatible
# SteamOS library.
broken="$(cd "$TARGET_DIR" && LD_LIBRARY_PATH=. ldd -r $TEST_LIBS 2>/dev/null \
    | awk '/not found/ { print "  missing:    " $1 }
           /undefined symbol/ { sub(/^[[:space:]]*undefined symbol: /, "")
                                print "  unresolved: " $0 }' | sort -u)"
if [ -n "$broken" ]; then
    echo "[fetch-deck-libs] ERROR: the installed closure does not fully resolve:" >&2
    echo "$broken" >&2
    echo "  'missing' means no bundled or system library provides that SONAME." >&2
    echo "  'unresolved' means one was found but is the wrong version." >&2
    echo "  Both are decided against THIS system's libraries, so a plain re-run" >&2
    echo "  reproduces them. Either install the missing/newer library, or force" >&2
    echo "  the lib to be bundled instead of deferred (it is skipped only when" >&2
    echo "  /usr/lib* already offers its SONAME)." >&2
    exit 1
fi

echo "[fetch-deck-libs] Closure installed into $TARGET_DIR ($(find "$TARGET_DIR" -maxdepth 1 -name '*.so*' | wc -l) so files)"
