#!/bin/sh
# Loadout installer script
# Two-phase install: user-level (no sudo) + optional sudo for system dependencies
# Idempotent: safe to run multiple times
#
# Supports: SteamOS (Arch), Bazzite (Fedora/rpm-ostree), CachyOS/Arch, Ubuntu/Debian, Fedora, openSUSE
# Usage: curl -fsSL https://raw.githubusercontent.com/srsholmes/loadout/main/scripts/install.sh | sh

set -e

# Configuration
REPO="srsholmes/loadout"
INSTALL_DIR="$HOME/.local/share/loadout"
BINARY_NAME="loadout"
# Distro-dependent binary path — there is no single path that works on
# every supported distro. See docs/install-locations.md for the full
# rationale.
#   SteamOS: $INSTALL_DIR/$BINARY_NAME (under ~/.local/share). /usr is
#            read-only and would be wiped on the next A/B image update;
#            SteamOS doesn't enforce SELinux so a binary under
#            data_home_t execs fine from a root unit.
#   Otherwise (Bazzite / Fedora-ostree / Arch / CachyOS / Ubuntu / ...):
#            /usr/local/bin/$BINARY_NAME. Writable on ostree (→
#            /var/usrlocal), labelled bin_t — Bazzite's enforcing SELinux
#            denies init_t `execute` on data_home_t, so the binary MUST
#            be at a bin_t-labelled system path. Mirrors HHD's
#            /usr/bin/hhd. Non-SELinux distros: same path, just works.
case "$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")" in
    steamos)
        BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"
        BIN_NEEDS_SUDO=0
        ;;
    *)
        BINARY_PATH="/usr/local/bin/$BINARY_NAME"
        BIN_NEEDS_SUDO=1
        ;;
esac
BIN_LINK="$HOME/.local/bin/loadout"
SERVICE_DIR="$HOME/.config/systemd/user"
# Legacy per-user backend unit — removed on install now the backend is a
# root system service. The overlay stays a user unit (see below).
SERVICE_FILE="$SERVICE_DIR/loadout.service"
SYSTEM_SERVICE_FILE="/etc/systemd/system/loadout.service"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/loadout.desktop"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
OVERLAY_LAUNCHER="$OVERLAY_INSTALL_DIR/bin/launcher"
OVERLAY_SERVICE_FILE="$SERVICE_DIR/loadout-overlay.service"
OVERLAY_PORT="${LOADOUT_PORT:-33820}"

# Colors (only if terminal supports them)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    BOLD=''
    NC=''
fi

info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

success() {
    printf "${GREEN}[OK]${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1"
}

# If GITHUB_TOKEN is set we forward it on every GitHub HTTP call so the
# installer works against private repos (where raw.githubusercontent.com
# and release-asset URLs all return 404 unauthenticated). Unset on public
# installs — the unauthenticated path stays unchanged.
#
# The token needs `Contents: read` (fine-grained) or `repo` (classic) on
# this repository. `gh auth token` produces a working token if the gh
# CLI is logged in.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# Pin a specific release instead of the newest one. Set LOADOUT_VERSION to a
# release tag (e.g. v0.1.0) to install/downgrade to that exact version; unset,
# the installer resolves the GitHub "latest" release. The tag flows through to
# the binary, overlay, plugin, and SHA256SUMS asset URLs automatically.
LOADOUT_VERSION="${LOADOUT_VERSION:-}"

# curl/wget wrappers that add an Authorization header when GITHUB_TOKEN is
# set. Pass-through otherwise — public repos keep working with no token.
curl_gh() {
    if [ -n "$GITHUB_TOKEN" ]; then
        curl -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
    else
        curl "$@"
    fi
}

wget_gh() {
    if [ -n "$GITHUB_TOKEN" ]; then
        wget --header="Authorization: Bearer $GITHUB_TOKEN" "$@"
    else
        wget "$@"
    fi
}

# Look up an asset's API URL (https://api.github.com/.../releases/assets/N)
# by its filename in the cached RELEASE_JSON. Private-repo asset downloads
# go through this URL with `Accept: application/octet-stream`, because
# `browser_download_url` 404s for unauthenticated callers on private repos.
# Empty output on miss; caller falls back to browser_download_url.
asset_api_url() {
    asset_name="$1"
    [ -n "${RELEASE_JSON:-}" ] || return 0
    # GitHub returns pretty-printed JSON; flatten newlines first, then split
    # on `{` so each asset object lands on a single awk record. Match by
    # name and pick that asset's "url" field (the API URL — works on private
    # repos with auth + Accept: application/octet-stream).
    printf '%s' "$RELEASE_JSON" | tr -d '\n' | tr '{' '\n' | awk -v name="$asset_name" '
        $0 ~ "\"name\":[ ]*\"" name "\"" {
            if (match($0, /"url":[ ]*"https:\/\/api\.github\.com\/[^"]*\/releases\/assets\/[0-9]+"/)) {
                u = substr($0, RSTART, RLENGTH)
                gsub(/^"url":[ ]*"/, "", u)
                gsub(/"$/, "", u)
                print u
                exit
            }
        }
    '
}

# Cached path to the downloaded SHA256SUMS file (populated lazily by
# verify_sha256). Empty string means "not yet attempted"; "missing" means
# we tried and the release didn't ship one (older builds, manual upload).
SHA256SUMS_FILE=""

# Verify a downloaded file against the release's SHA256SUMS asset.
#
# Hard-fails when:
#   - the hash is present and does not match (tampering)
#   - SHA256SUMS isn't fetchable but sha256sum IS available (current
#     releases always ship one — a missing file means MITM or upload race)
#   - SHA256SUMS is present but has no entry for this asset
#
# Soft-fails (warn + continue) only when sha256sum itself isn't installed —
# uncommon, and Alpine / stripped-down distros are the main case.
#
# Set LOADOUT_INSECURE=1 to skip integrity checks entirely (e.g.
# local bring-up against a private repo without SHA256SUMS yet). Don't
# ship that. Ported from PR #48 section D.
verify_sha256() {
    local_file="$1"
    expected_basename="$2"

    if [ "${LOADOUT_INSECURE:-0}" = "1" ]; then
        warn "LOADOUT_INSECURE=1 — skipping integrity check for $expected_basename"
        return 0
    fi

    if ! command -v sha256sum >/dev/null 2>&1; then
        warn "sha256sum not found — skipping integrity check for $expected_basename"
        return 0
    fi

    if [ -z "$SHA256SUMS_FILE" ]; then
        SHA256SUMS_FILE="$(mktemp)"
        SUMS_URL=""
        SUMS_ACCEPT_HEADER=""
        # Prefer the asset API URL on private installs (token set) — the
        # public browser_download_url 404s without auth on private repos.
        if [ -n "$GITHUB_TOKEN" ]; then
            SUMS_URL="$(asset_api_url "SHA256SUMS")"
            [ -n "$SUMS_URL" ] && SUMS_ACCEPT_HEADER="Accept: application/octet-stream"
        fi
        if [ -z "$SUMS_URL" ] && [ -n "${RELEASE_JSON:-}" ]; then
            SUMS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*/SHA256SUMS"' | head -1 | sed 's/.*"browser_download_url": *"//;s/"$//')"
        fi
        if [ -z "$SUMS_URL" ]; then
            TAG_FROM_JSON=""
            if [ -n "${RELEASE_JSON:-}" ]; then
                TAG_FROM_JSON="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')"
            fi
            SUMS_URL="https://github.com/$REPO/releases/download/${TAG_FROM_JSON:-latest}/SHA256SUMS"
        fi
        if command -v curl >/dev/null 2>&1; then
            if [ -n "$SUMS_ACCEPT_HEADER" ]; then
                curl_gh -fsSL -H "$SUMS_ACCEPT_HEADER" -o "$SHA256SUMS_FILE" "$SUMS_URL" 2>/dev/null || rm -f "$SHA256SUMS_FILE"
            else
                curl_gh -fsSL -o "$SHA256SUMS_FILE" "$SUMS_URL" 2>/dev/null || rm -f "$SHA256SUMS_FILE"
            fi
        elif command -v wget >/dev/null 2>&1; then
            if [ -n "$SUMS_ACCEPT_HEADER" ]; then
                wget_gh --header="$SUMS_ACCEPT_HEADER" -q -O "$SHA256SUMS_FILE" "$SUMS_URL" 2>/dev/null || rm -f "$SHA256SUMS_FILE"
            else
                wget_gh -q -O "$SHA256SUMS_FILE" "$SUMS_URL" 2>/dev/null || rm -f "$SHA256SUMS_FILE"
            fi
        fi
        if [ ! -s "$SHA256SUMS_FILE" ]; then
            SHA256SUMS_FILE="missing"
            error "SHA256SUMS not available from $SUMS_URL"
            error "Refusing to install unverified binaries. Re-run with LOADOUT_INSECURE=1 to bypass (not recommended)."
            return 1
        fi
    fi

    if [ "$SHA256SUMS_FILE" = "missing" ]; then
        return 1
    fi

    expected_hash="$(grep -E "[ *]${expected_basename}\$" "$SHA256SUMS_FILE" | awk '{print $1}' | head -1)"
    if [ -z "$expected_hash" ]; then
        error "No SHA256 entry for $expected_basename in SHA256SUMS"
        error "Refusing to install unverified binaries. Re-run with LOADOUT_INSECURE=1 to bypass (not recommended)."
        return 1
    fi

    actual_hash="$(sha256sum "$local_file" | awk '{print $1}')"
    if [ "$actual_hash" != "$expected_hash" ]; then
        error "SHA256 mismatch for $expected_basename"
        error "  expected: $expected_hash"
        error "  actual:   $actual_hash"
        error "Refusing to install a tampered or corrupted file."
        return 1
    fi
    success "SHA256 verified for $expected_basename"
    return 0
}

# Where prompts read from. Under the documented `curl … | sh` install,
# stdin is the script text itself, so `[ -t 0 ]` is false and a bare
# `read` would eat the script rather than the user's answer — every
# prompt silently took its default (Phase 2 could never run). Read the
# controlling terminal instead, which exists in both the piped and the
# `sh install.sh` cases. Empty only when there's genuinely no terminal
# (CI, systemd, `docker run -d`), where prompts fall back to defaults.
PROMPT_TTY=""
if { true < /dev/tty; } 2>/dev/null; then
    PROMPT_TTY=/dev/tty
fi

# Prompt user for yes/no. y/Y accepts, anything else declines.
#   $1 — prompt text
#   $2 — default taken on a bare <enter> (default: n)
#   $3 — default taken when there is no terminal to ask on, e.g. CI or
#        systemd (default: $2). Kept separate from $2 so a prompt can
#        treat <enter> as consent while still refusing to take a
#        sudo/system-modifying action unattended.
prompt_yn() {
    if [ -z "$PROMPT_TTY" ]; then
        # No terminal to ask on: use the non-interactive default
        case "${3:-${2:-n}}" in
            [Yy]*) return 0 ;;
            *) return 1 ;;
        esac
    fi
    printf "%s " "$1" > "$PROMPT_TTY"
    # EOF on the terminal is treated as the default rather than hanging.
    read -r answer < "$PROMPT_TTY" || answer=""
    case "$answer" in
        [Yy]*) return 0 ;;
        "")
            case "${2:-n}" in
                [Yy]*) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        *) return 1 ;;
    esac
}

# Detect OS/distro
detect_os() {
    if [ -f /usr/share/steamos-atomupd ] || (command -v hostnamectl >/dev/null 2>&1 && hostnamectl 2>/dev/null | grep -qi "steamos"); then
        echo "steamos"
    elif command -v rpm-ostree >/dev/null 2>&1 && [ -d /etc/bazzite ]; then
        echo "bazzite"
    elif [ -f /etc/os-release ] && grep -qi "ubuntu\|debian\|pop" /etc/os-release 2>/dev/null; then
        echo "debian"
    elif [ -f /etc/os-release ] && grep -qi "opensuse" /etc/os-release 2>/dev/null; then
        echo "opensuse"
    elif [ -f /etc/os-release ] && grep -qi "fedora" /etc/os-release 2>/dev/null; then
        echo "fedora"
    elif command -v pacman >/dev/null 2>&1; then
        echo "arch"
    else
        echo "unknown"
    fi
}

# Detect architecture
detect_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac
}

# ============================================================
# Phase 1: User-level install (no sudo needed)
# ============================================================

phase1() {
    info "=== Phase 1: Installing Loadout (no sudo required) ==="
    echo ""

    ARCH="$(detect_arch)"
    info "Detected architecture: $ARCH"

    # --- Download or locate binary ---

    # LOADOUT_VERSION pins a specific tag; otherwise take the newest release.
    if [ -n "$LOADOUT_VERSION" ]; then
        info "Pinned to release $LOADOUT_VERSION"
        RELEASE_URL="https://api.github.com/repos/$REPO/releases/tags/$LOADOUT_VERSION"
    else
        RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"
    fi

    DOWNLOAD_URL=""
    DOWNLOAD_ACCEPT_HEADER=""
    if command -v curl >/dev/null 2>&1; then
        RELEASE_JSON="$(curl_gh -fsSL "$RELEASE_URL" 2>/dev/null)" || true
        if [ -n "$RELEASE_JSON" ]; then
            if [ -n "$GITHUB_TOKEN" ]; then
                DOWNLOAD_URL="$(asset_api_url "loadout-${ARCH}")"
                [ -n "$DOWNLOAD_URL" ] && DOWNLOAD_ACCEPT_HEADER="Accept: application/octet-stream"
            fi
            if [ -z "$DOWNLOAD_URL" ]; then
                # Match the bare server binary asset (loadout-${ARCH}), with
                # the closing quote anchoring it so we don't accidentally match
                # loadout-overlay-${ARCH}.tar.xz.
                DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*/loadout-${ARCH}\"" | head -1 | sed 's/.*"browser_download_url": *"//;s/"$//')"
            fi
        fi
    fi

    # A pinned version that doesn't resolve (typo, or a tag with no published
    # release) leaves RELEASE_JSON empty. Fail loudly here instead of falling
    # through to the "latest"-literal URL below, which 404s with a misleading
    # error and hides the real problem.
    if [ -n "$LOADOUT_VERSION" ] && [ -z "${RELEASE_JSON:-}" ]; then
        error "Pinned release $LOADOUT_VERSION not found (no such tag, or it has no published release). See https://github.com/$REPO/releases"
        exit 1
    fi

    if [ -z "$DOWNLOAD_URL" ]; then
        if [ -n "$GITHUB_TOKEN" ]; then
            error "Could not resolve a release asset URL. Check that GITHUB_TOKEN has Contents: read on $REPO and that a release with tag 'main' exists."
            exit 1
        fi
        TAG=""
        if [ -n "${RELEASE_JSON:-}" ]; then
            TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')"
        fi
        if [ -z "$TAG" ]; then
            TAG="latest"
        fi
        DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/loadout-${ARCH}"
    fi

    info "Download URL: $DOWNLOAD_URL"

    # Create directories
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR/plugins"
    mkdir -p "$HOME/.local/bin"

    # Check if the binary already exists. Keeping it skips only the binary
    # download/install below — the overlay, plugins and services further down
    # are still refreshed from the latest release. This lets a re-run pick up
    # new plugins (e.g. ones added since the last install) without forcing the
    # user to delete the binary first.
    INSTALL_BINARY=1
    if [ -f "$BINARY_PATH" ]; then
        # Default-yes everywhere: re-running the documented install one-liner
        # IS the upgrade path, so both a bare <enter> and a headless re-run
        # should refresh the binary. It lives in ~/.local/bin (no sudo), same
        # as the fresh-install path just below, which never asked.
        if prompt_yn "Loadout binary already exists. Overwrite? (Y/n)" "y"; then
            info "Overwriting existing binary..."
        else
            info "Keeping existing binary (overlay + plugins will still be refreshed)."
            INSTALL_BINARY=0
        fi
    fi

    if [ "$INSTALL_BINARY" = "1" ]; then
        # Stop existing service if running (backend is a root system service)
        if systemctl is-active loadout >/dev/null 2>&1; then
            info "Stopping existing Loadout service..."
            sudo systemctl stop loadout || true
        fi

        # Download the binary
        info "Downloading Loadout..."
        TEMP_FILE="$(mktemp)"
        if command -v curl >/dev/null 2>&1; then
            if [ -n "$DOWNLOAD_ACCEPT_HEADER" ]; then
                DOWNLOAD_OK=1
                curl_gh -fSL --progress-bar -H "$DOWNLOAD_ACCEPT_HEADER" -o "$TEMP_FILE" "$DOWNLOAD_URL" || DOWNLOAD_OK=0
            else
                DOWNLOAD_OK=1
                curl_gh -fSL --progress-bar -o "$TEMP_FILE" "$DOWNLOAD_URL" || DOWNLOAD_OK=0
            fi
            if [ "$DOWNLOAD_OK" = "0" ]; then
                rm -f "$TEMP_FILE"
                error "Download failed. Please check your internet connection and try again."
                error "URL: $DOWNLOAD_URL"
                exit 1
            fi
        elif command -v wget >/dev/null 2>&1; then
            if [ -n "$DOWNLOAD_ACCEPT_HEADER" ]; then
                DOWNLOAD_OK=1
                wget_gh --header="$DOWNLOAD_ACCEPT_HEADER" -q --show-progress -O "$TEMP_FILE" "$DOWNLOAD_URL" || DOWNLOAD_OK=0
            else
                DOWNLOAD_OK=1
                wget_gh -q --show-progress -O "$TEMP_FILE" "$DOWNLOAD_URL" || DOWNLOAD_OK=0
            fi
            if [ "$DOWNLOAD_OK" = "0" ]; then
                rm -f "$TEMP_FILE"
                error "Download failed. Please check your internet connection and try again."
                error "URL: $DOWNLOAD_URL"
                exit 1
            fi
        else
            rm -f "$TEMP_FILE"
            error "Neither curl nor wget found. Cannot download the binary."
            exit 1
        fi

        # Verify download is not empty
        DOWNLOADED_SIZE="$(wc -c < "$TEMP_FILE" | tr -d ' ')"
        if [ "$DOWNLOADED_SIZE" -lt 1024 ]; then
            rm -f "$TEMP_FILE"
            error "Downloaded file is too small ($DOWNLOADED_SIZE bytes). The download may have failed."
            error "URL: $DOWNLOAD_URL"
            exit 1
        fi
        info "Downloaded $DOWNLOADED_SIZE bytes."

        if ! verify_sha256 "$TEMP_FILE" "loadout-${ARCH}"; then
            rm -f "$TEMP_FILE"
            exit 1
        fi

        # Install the binary at the chosen path. On a system path
        # (/usr/local/bin) this needs sudo + restorecon to force bin_t so the
        # root service (init_t) can exec it under enforcing SELinux. On SteamOS
        # the binary lives in the user's home (BIN_NEEDS_SUDO=0) — plain user-
        # owned, no SELinux concern, no /usr write (the rootfs is read-only).
        if [ "$BIN_NEEDS_SUDO" = "1" ]; then
            info "Installing the binary to $BINARY_PATH (needs sudo)..."
            sudo install -m 0755 "$TEMP_FILE" "$BINARY_PATH"
            rm -f "$TEMP_FILE"
            command -v restorecon >/dev/null 2>&1 && sudo restorecon -F "$BINARY_PATH" 2>/dev/null || true
        else
            info "Installing the binary to $BINARY_PATH (user-writable on this distro)..."
            mkdir -p "$(dirname "$BINARY_PATH")"
            install -m 0755 "$TEMP_FILE" "$BINARY_PATH"
            rm -f "$TEMP_FILE"
        fi
        success "Binary installed to $BINARY_PATH"
    fi

    # Download the overlay binary
    download_overlay "$ARCH"

    # SteamOS-only: fetch the webkit2gtk closure the overlay's native wrapper
    # dlopens at startup. Kept OUT of the release archive on purpose — it's
    # ~100 MB and only SteamOS needs it (Bazzite/CachyOS/Fedora ship the libs
    # system-wide), so bundling it would bloat every download. Built locally
    # via podman instead, then cached. See setup_overlay_deps().
    setup_overlay_deps

    # Download and stage plugins. The loader binary expects every plugin's
    # backend + workspace deps on disk; without this step the public installer
    # leaves $INSTALL_DIR/plugins/ empty and nothing renders. Audit 2026-05 H-002.
    download_plugins "$ARCH"

    # Create symlink in ~/.local/bin so it's on PATH
    setup_bin_link
    setup_desktop
    setup_steam_cef_debugging
    setup_service
}

download_overlay() {
    ARCH="$1"
    info "Downloading Loadout Overlay..."

    OVERLAY_ASSET="loadout-overlay-${ARCH}.tar.xz"

    OVERLAY_URL=""
    OVERLAY_ACCEPT_HEADER=""
    if [ -n "$GITHUB_TOKEN" ]; then
        OVERLAY_URL="$(asset_api_url "$OVERLAY_ASSET")"
        [ -n "$OVERLAY_URL" ] && OVERLAY_ACCEPT_HEADER="Accept: application/octet-stream"
    fi
    if [ -z "$OVERLAY_URL" ] && [ -n "${RELEASE_JSON:-}" ]; then
        OVERLAY_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*/${OVERLAY_ASSET}\"" | head -1 | sed 's/.*"browser_download_url": *"//;s/"$//')"
    fi

    if [ -z "$OVERLAY_URL" ]; then
        if [ -n "$GITHUB_TOKEN" ]; then
            warn "Could not resolve overlay asset URL from release JSON. Skipping overlay download."
            return
        fi
        TAG=""
        if [ -n "${RELEASE_JSON:-}" ]; then
            TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')"
        fi
        if [ -z "$TAG" ]; then
            TAG="latest"
        fi
        OVERLAY_URL="https://github.com/$REPO/releases/download/$TAG/${OVERLAY_ASSET}"
    fi

    info "Overlay download URL: $OVERLAY_URL"

    TEMP_FILE="$(mktemp --suffix=.tar.xz)"
    if command -v curl >/dev/null 2>&1; then
        OVERLAY_OK=1
        if [ -n "$OVERLAY_ACCEPT_HEADER" ]; then
            curl_gh -fSL --progress-bar -H "$OVERLAY_ACCEPT_HEADER" -o "$TEMP_FILE" "$OVERLAY_URL" 2>/dev/null || OVERLAY_OK=0
        else
            curl_gh -fSL --progress-bar -o "$TEMP_FILE" "$OVERLAY_URL" 2>/dev/null || OVERLAY_OK=0
        fi
        if [ "$OVERLAY_OK" = "0" ]; then
            rm -f "$TEMP_FILE"
            warn "Overlay download failed. The server will run but the overlay window will not launch."
            warn "You can build it manually: bun run build-and-install (from the project root)"
            return
        fi
    elif command -v wget >/dev/null 2>&1; then
        OVERLAY_OK=1
        if [ -n "$OVERLAY_ACCEPT_HEADER" ]; then
            wget_gh --header="$OVERLAY_ACCEPT_HEADER" -q --show-progress -O "$TEMP_FILE" "$OVERLAY_URL" 2>/dev/null || OVERLAY_OK=0
        else
            wget_gh -q --show-progress -O "$TEMP_FILE" "$OVERLAY_URL" 2>/dev/null || OVERLAY_OK=0
        fi
        if [ "$OVERLAY_OK" = "0" ]; then
            rm -f "$TEMP_FILE"
            warn "Overlay download failed. The server will run but the overlay window will not launch."
            return
        fi
    fi

    DOWNLOADED_SIZE="$(wc -c < "$TEMP_FILE" | tr -d ' ')"
    if [ "$DOWNLOADED_SIZE" -lt 1024 ]; then
        rm -f "$TEMP_FILE"
        warn "Overlay download too small ($DOWNLOADED_SIZE bytes). Skipping."
        return
    fi
    info "Downloaded $DOWNLOADED_SIZE bytes."

    if ! verify_sha256 "$TEMP_FILE" "$OVERLAY_ASSET"; then
        rm -f "$TEMP_FILE"
        return
    fi

    # Stop overlay service before replacing files (CEF holds locks).
    if systemctl --user is-active loadout-overlay >/dev/null 2>&1; then
        info "Stopping existing overlay service..."
        systemctl --user stop loadout-overlay || true
    fi

    info "Extracting overlay tree to $OVERLAY_INSTALL_DIR..."
    rm -rf "$OVERLAY_INSTALL_DIR"
    mkdir -p "$OVERLAY_INSTALL_DIR"
    # Tar contains a top-level loadout-overlay-dev/ directory; strip it
    # so the launcher lands at $OVERLAY_INSTALL_DIR/bin/launcher (matching
    # the path the systemd unit expects).
    if ! tar -xJf "$TEMP_FILE" -C "$OVERLAY_INSTALL_DIR" --strip-components=1; then
        rm -f "$TEMP_FILE"
        error "Failed to extract overlay archive."
        return
    fi
    rm -f "$TEMP_FILE"

    if [ ! -x "$OVERLAY_LAUNCHER" ]; then
        warn "Overlay launcher missing or not executable at $OVERLAY_LAUNCHER"
        return
    fi
    success "Overlay installed to $OVERLAY_INSTALL_DIR"
}

# Fetch the runtime libraries the overlay's native wrapper needs but the
# release archive deliberately omits. Electrobun's libNativeWrapper.so dlopens
# libwebkit2gtk-4.1 / libjavascriptcoregtk-4.1 / libayatana-appindicator3 at
# startup. Bazzite, CachyOS and Fedora-ostree ship those in the base image;
# SteamOS Holo does not. Rather than fatten every download with a ~100 MB
# closure only SteamOS uses, we build it on the device at install time:
# fetch-deck-overlay-libs.sh is a near-instant no-op where the system already
# provides webkit2gtk-4.1, and builds + caches the closure from a Fedora
# container via podman (shipped in Holo 3.7+) on SteamOS.
#
# Non-fatal: if the helper can't be fetched or the build can't run we warn and
# continue. The binary, plugins and services still install; only the overlay
# window is blocked until the closure is in place (re-run, or build from clone).
setup_overlay_deps() {
    [ -x "$OVERLAY_LAUNCHER" ] || return 0

    # Prefer a sibling copy on disk (running from a clone); otherwise download
    # it from the repo — the curl|sh path has no checkout. curl_gh/wget_gh add
    # the GITHUB_TOKEN auth header so this works against a private repo too.
    DEPS_SCRIPT=""
    case "$0" in
        */*)
            _deps_dir="$(dirname "$0")"
            [ -f "$_deps_dir/fetch-deck-overlay-libs.sh" ] && \
                DEPS_SCRIPT="$_deps_dir/fetch-deck-overlay-libs.sh"
            ;;
    esac

    _deps_tmp=""
    if [ -z "$DEPS_SCRIPT" ]; then
        _deps_tmp="$(mktemp)"
        DEPS_URL="https://raw.githubusercontent.com/$REPO/main/scripts/fetch-deck-overlay-libs.sh"
        if command -v curl >/dev/null 2>&1; then
            curl_gh -fsSL -o "$_deps_tmp" "$DEPS_URL" 2>/dev/null || rm -f "$_deps_tmp"
        elif command -v wget >/dev/null 2>&1; then
            wget_gh -q -O "$_deps_tmp" "$DEPS_URL" 2>/dev/null || rm -f "$_deps_tmp"
        fi
        if [ ! -s "$_deps_tmp" ]; then
            rm -f "$_deps_tmp"
            warn "Could not fetch fetch-deck-overlay-libs.sh from $DEPS_URL."
            warn "On SteamOS the overlay won't launch until its webkit2gtk closure is present."
            warn "Build from a clone instead: bun run build-and-install"
            return 0
        fi
        DEPS_SCRIPT="$_deps_tmp"
    fi

    info "Preparing overlay runtime libraries (no-op unless on SteamOS)..."
    if sh "$DEPS_SCRIPT" "$OVERLAY_INSTALL_DIR/bin"; then
        success "Overlay runtime libraries ready."
    else
        warn "Overlay dependency setup did not complete (see the message above)."
        warn "The overlay won't launch until it does. On SteamOS install podman,"
        warn "then re-run this installer; or build from a clone: bun run build-and-install"
    fi

    # NOTE: keep this an `if`, not `[ -n "$_deps_tmp" ] && rm -f ...`. As the
    # function's last command the latter returns 1 whenever $_deps_tmp is empty
    # (the common case when running from a clone, where the helper is found on
    # disk and never downloaded), and `set -e` would abort the whole installer
    # right here — before plugins or the services are installed.
    if [ -n "$_deps_tmp" ]; then
        rm -f "$_deps_tmp"
    fi
}

# Download and extract the plugin tree built by release.yml. Tarball
# layout (produced by scripts/prepare-plugins.sh):
#
#   plugins/
#     apex-fixes/...          # source only
#     audio-loader/...
#     ...
#   node_modules/
#     react/                  # ONE shared copy, ~89 MB
#     react-dom/
#     scheduler/
#     react-icons/            # ~84 MB shared across all icon-using plugins
#     @loadout/{types,exec,...}
#
# The loader's inject-builder.ts looks for the hoisted location first,
# so plugins resolve their deps via standard Node upward traversal —
# no per-plugin duplication of node_modules. The hoisted layout was
# the original design (PR #48); a per-plugin variant briefly shipped
# but blew the release tarball up to ~2 GB raw / ~250 MB compressed.
#
# Audit 2026-05 H-002 — fixes "loader runs but no plugins render" on
# curl|sh installs (release tarball was previously binary-only).
download_plugins() {
    ARCH="$1"
    info "Downloading Loadout plugins..."

    PLUGINS_ASSET="loadout-plugins-${ARCH}.tar.xz"

    PLUGINS_URL=""
    PLUGINS_ACCEPT_HEADER=""
    if [ -n "$GITHUB_TOKEN" ]; then
        PLUGINS_URL="$(asset_api_url "$PLUGINS_ASSET")"
        [ -n "$PLUGINS_URL" ] && PLUGINS_ACCEPT_HEADER="Accept: application/octet-stream"
    fi
    if [ -z "$PLUGINS_URL" ] && [ -n "${RELEASE_JSON:-}" ]; then
        PLUGINS_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*/${PLUGINS_ASSET}\"" | head -1 | sed 's/.*"browser_download_url": *"//;s/"$//')"
    fi

    if [ -z "$PLUGINS_URL" ]; then
        if [ -n "$GITHUB_TOKEN" ]; then
            warn "Could not resolve plugins asset URL from release JSON. Skipping plugin staging."
            warn "The overlay will render an empty plugin list. Build from source to populate it."
            return
        fi
        TAG=""
        if [ -n "${RELEASE_JSON:-}" ]; then
            TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"//;s/"//')"
        fi
        if [ -z "$TAG" ]; then
            TAG="latest"
        fi
        PLUGINS_URL="https://github.com/$REPO/releases/download/$TAG/${PLUGINS_ASSET}"
    fi

    info "Plugins download URL: $PLUGINS_URL"

    TEMP_FILE="$(mktemp --suffix=.tar.xz)"
    if command -v curl >/dev/null 2>&1; then
        PLUGINS_OK=1
        if [ -n "$PLUGINS_ACCEPT_HEADER" ]; then
            curl_gh -fSL --progress-bar -H "$PLUGINS_ACCEPT_HEADER" -o "$TEMP_FILE" "$PLUGINS_URL" 2>/dev/null || PLUGINS_OK=0
        else
            curl_gh -fSL --progress-bar -o "$TEMP_FILE" "$PLUGINS_URL" 2>/dev/null || PLUGINS_OK=0
        fi
        if [ "$PLUGINS_OK" = "0" ]; then
            rm -f "$TEMP_FILE"
            warn "Plugins download failed. The overlay will render an empty plugin list."
            warn "Build from source to populate it: bun run build-and-install (from a clone)"
            return
        fi
    elif command -v wget >/dev/null 2>&1; then
        PLUGINS_OK=1
        if [ -n "$PLUGINS_ACCEPT_HEADER" ]; then
            wget_gh --header="$PLUGINS_ACCEPT_HEADER" -q --show-progress -O "$TEMP_FILE" "$PLUGINS_URL" 2>/dev/null || PLUGINS_OK=0
        else
            wget_gh -q --show-progress -O "$TEMP_FILE" "$PLUGINS_URL" 2>/dev/null || PLUGINS_OK=0
        fi
        if [ "$PLUGINS_OK" = "0" ]; then
            rm -f "$TEMP_FILE"
            warn "Plugins download failed. The overlay will render an empty plugin list."
            return
        fi
    fi

    DOWNLOADED_SIZE="$(wc -c < "$TEMP_FILE" | tr -d ' ')"
    if [ "$DOWNLOADED_SIZE" -lt 1024 ]; then
        rm -f "$TEMP_FILE"
        warn "Plugins download too small ($DOWNLOADED_SIZE bytes). Skipping."
        return
    fi
    info "Downloaded $DOWNLOADED_SIZE bytes."

    if ! verify_sha256 "$TEMP_FILE" "$PLUGINS_ASSET"; then
        rm -f "$TEMP_FILE"
        return
    fi

    # Stop the server before replacing plugins so the hot-reload watcher
    # doesn't try to rebuild against a half-extracted tree.
    if systemctl is-active loadout >/dev/null 2>&1; then
        info "Stopping loadout before staging plugins..."
        sudo systemctl stop loadout || true
    fi

    info "Extracting plugins + hoisted node_modules to $INSTALL_DIR/..."
    # The root service writes plugin build caches (.cache/) here as root;
    # reclaim ownership so the wipe below can remove them (needs sudo;
    # no-op on a fresh install).
    sudo chown -R "$(id -un):$(id -gn)" "$INSTALL_DIR" 2>/dev/null || true
    # Wipe both targets first so deleted plugins and stale deps don't
    # linger across reinstalls. Tarball contains plugins/ + node_modules/
    # at the top level, extracted directly into $INSTALL_DIR.
    rm -rf "$INSTALL_DIR/plugins" "$INSTALL_DIR/node_modules"
    if ! tar -xJf "$TEMP_FILE" -C "$INSTALL_DIR"; then
        rm -f "$TEMP_FILE"
        error "Failed to extract plugins archive."
        return
    fi
    rm -f "$TEMP_FILE"

    PLUGIN_COUNT="$(find "$INSTALL_DIR/plugins" -mindepth 1 -maxdepth 1 -type d | wc -l)"
    INSTALL_SIZE="$(du -sh "$INSTALL_DIR/plugins" "$INSTALL_DIR/node_modules" 2>/dev/null | tail -1 | awk '{print $1}')"
    success "Installed $PLUGIN_COUNT plugins (shared node_modules: $INSTALL_SIZE)"
}

setup_bin_link() {
    mkdir -p "$HOME/.local/bin"
    if [ -L "$BIN_LINK" ] || [ -f "$BIN_LINK" ]; then
        rm -f "$BIN_LINK"
    fi
    ln -sf "$BINARY_PATH" "$BIN_LINK"
    success "Symlink created: $BIN_LINK -> $BINARY_PATH"

    # Check if ~/.local/bin is on PATH
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *)
            warn "$HOME/.local/bin is not on your PATH."
            info "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
            info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            ;;
    esac
}

setup_desktop() {
    info "Installing .desktop file..."
    mkdir -p "$DESKTOP_DIR"

    cat > "$DESKTOP_FILE" <<DESKTOPEOF
[Desktop Entry]
Name=Loadout
Comment=Plugin manager overlay for Steam / Linux gaming
Exec=$BIN_LINK
Type=Application
Terminal=false
Categories=Game;Utility;
Keywords=steam;plugins;overlay;deck;gaming;
StartupWMClass=Loadout
DESKTOPEOF

    success "Desktop file installed to $DESKTOP_FILE"

    # Update desktop database if available
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi
}

# Enable Steam's Chromium DevTools Protocol endpoint (localhost:8080) by
# dropping the empty `.cef-enable-remote-debugging` marker file in Steam's
# root. Steam reads it once at startup. This is the SAME mechanism Decky
# Loader uses — we set it ourselves so the overlay's Steam-CDP features work
# on machines that don't have Decky installed.
#
# Why the overlay needs it: when Steam's Quick Access Menu is open and the
# user triggers the overlay, the overlay closes the QAM via CDP *before*
# claiming gamescope overlay focus. Without CDP it can't, and gamescope gets
# into an overlay focus-fight that flickers and can freeze input device-wide
# (recovers only on reboot). The injector + hltb + sound-loader plugins also
# talk to this endpoint.
CEF_DEBUG_FLAG=".cef-enable-remote-debugging"

setup_steam_cef_debugging() {
    info "Enabling Steam CEF remote debugging (for overlay focus + plugins)..."

    # Steam reads the flag from its data root. `~/.steam/steam` is the
    # canonical symlink (also where Decky writes it); `~/.local/share/Steam`
    # is the native target it points at; the Flatpak path covers Flatpak
    # Steam. Writing through any of them lands in the right place — a symlink
    # target we already created is skipped by the `-e` check below.
    created=0
    existed=0
    for root in \
        "$HOME/.steam/steam" \
        "$HOME/.local/share/Steam" \
        "$HOME/.var/app/com.valvesoftware.Steam/data/Steam"; do
        [ -d "$root" ] || continue
        flag="$root/$CEF_DEBUG_FLAG"
        if [ -e "$flag" ]; then
            existed=1
            continue
        fi
        if : > "$flag" 2>/dev/null; then
            success "Created $flag"
            created=1
        else
            warn "Could not write $flag (check permissions)."
        fi
    done

    if [ "$created" = "0" ] && [ "$existed" = "0" ]; then
        warn "No Steam install directory found — skipped CEF debugging flag."
        warn "If Steam is installed elsewhere, create an empty file named"
        warn "  $CEF_DEBUG_FLAG  in Steam's root, then restart Steam."
        return
    fi

    if [ "$created" = "1" ]; then
        warn "Restart Steam for CEF remote debugging to take effect."
    else
        info "CEF remote debugging already enabled."
    fi
}

setup_service() {
    # Backend runs as ROOT (a system service) so it can write hardware
    # sysfs / run privileged tools without per-op sudo at runtime — the
    # HHD/Decky model. A system unit can't expand %h (that's root's home),
    # so bake the concrete home + user in. This is the one step that needs
    # admin rights; sudo prompts once here.
    info "Installing the backend as a root system service (needs sudo once)..."

    # Backend moved from a --user service to a system unit — drop the old
    # per-user one if present.
    systemctl --user disable --now loadout 2>/dev/null || true
    rm -f "$SERVICE_FILE"

    TMP_UNIT="$(mktemp)"
    cat > "$TMP_UNIT" <<SERVICEEOF
[Unit]
Description=Loadout (backend)
# Loopback-only socket (127.0.0.1:$OVERLAY_PORT); no network.target needed.

[Service]
Type=simple
# Runs as root (no User=). Plugins are sandboxed at the @loadout/exec
# choke point (per-plugin command capability policy). \$HOME is set so
# os.homedir()/@loadout/steam-paths resolve the user's config + Steam;
# --user chowns files written under it back to the user.
Environment=HOME=$HOME
Environment=PLUGINS_DIR=$HOME/.local/share/loadout/plugins
ExecStart=$BINARY_PATH --user $(id -un)
WorkingDirectory=$HOME/.local/share/loadout
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEEOF
    sudo cp "$TMP_UNIT" "$SYSTEM_SERVICE_FILE"
    rm -f "$TMP_UNIT"
    success "Service file written to $SYSTEM_SERVICE_FILE"

    info "Reloading systemd + enabling the loadout service..."
    sudo systemctl daemon-reload
    sudo systemctl enable loadout
    sudo systemctl restart loadout

    # Verify the service started
    sleep 1
    if systemctl is-active loadout >/dev/null 2>&1; then
        success "Loadout service is running!"
    else
        warn "Service may not have started yet. Check with: systemctl status loadout"
    fi

    # Install overlay service if the overlay launcher is present.
    #
    # Heredoc kept in sync with the canonical /loadout-overlay.service
    # in the repo root. Changes to that file MUST be mirrored here. The
    # full content matters: missing the SingletonLock cleanup, HOME env,
    # DISPLAY-detection shell, or SIGCONT safety net breaks the overlay
    # in gaming mode, on $HOME-on-NFS setups, or on crash recovery.
    # Audit 2026-05 H-001.
    if [ -x "$OVERLAY_LAUNCHER" ]; then
        info "Writing overlay systemd user service file..."
        # ~/.config/systemd/user doesn't exist yet on a fresh install where
        # the user has never enabled a systemd --user unit (common on
        # Bazzite). Without this the `cat >` redirect below fails with
        # "no such file or directory" and `set -e` aborts the whole install.
        mkdir -p "$SERVICE_DIR"
        cat > "$OVERLAY_SERVICE_FILE" <<'OVERLAYEOF'
[Unit]
Description=Loadout Overlay
# The backend (loadout.service) is now a *system* service running as root,
# so this *user* unit can't Requires=/After= it across managers. Ordering
# is handled instead by the ExecStartPre curl-`/up` wait loop below.
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple

# Wipe Chromium/CEF singleton symlinks before launch. These encode
# <hostname>-<pid> and stop CEF from starting if they reference a
# different host (e.g. $HOME is shared across multiple handhelds via
# Syncthing / an SD card / NFS) or a dead PID from a crashed prior
# run. If the overlay is actually still alive, systemctl already
# killed it before this point — any lock we see here is stale.
ExecStartPre=-/bin/sh -c 'rm -f %h/.cache/com.loadout.overlay/dev/CEF/SingletonLock %h/.cache/com.loadout.overlay/dev/CEF/SingletonCookie %h/.cache/com.loadout.overlay/dev/CEF/SingletonSocket'

# Wait for the plugin server to be up before launching so the webview
# doesn't race its initial fetch.
ExecStartPre=/bin/sh -c 'for i in $(seq 1 30); do curl -sf "http://localhost:${LOADOUT_PORT:-33820}/up" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0'

# HOME must match the canonical path on Fedora/Bazzite, otherwise CEF's
# root_cache_path/cache_path consistency check fails (see the comment in
# src/bun/native/display-detect.ts).
Environment=HOME=%h

# NOTE: GDK_GL=disable was removed here. It only silenced a cosmetic
# "X11 Error: GLXBadWindow (code 170)" GTK GLX-probe warning under
# gamescope (CEF renders the UI itself, so the GTK host window needs no
# GL). But forcing GDK to its software/cairo path made the CEF host
# surface segfault when reallocated on a window resize — so in desktop
# mode, dragging a resize handle crashed the overlay (the window is
# created resizable; see BrowserWindow in src/bun/index.ts). Re-enabling
# GL restores safe live resize. The GLXBadWindow line returns as harmless
# log noise under gamescope; if it ever needs suppressing again, scope it
# to gamescope mode only (e.g. export GDK_GL=disable from the ExecStart
# wrapper when a gamescope display is detected) rather than setting it
# unconditionally here.

# CEF remote DevTools — attach Chrome to http://localhost:9222 on the
# device or over SSH tunnel. Port is baked into the build via
# electrobun.config.ts → build.linux.chromiumFlags.

# DISPLAY detection: Electrobun's libNativeWrapper opens X in
# startEventLoop() on the main thread of the Bun process, before our
# app's worker thread ever runs — we can't mutate process.env.DISPLAY
# from JS in time. So we detect inline here.
#   1. If $GAMESCOPE_DISPLAY is in the unit env, use it.
#   2. Read /proc/<steam-pid>/environ for GAMESCOPE_DISPLAY (set when
#      Steam was launched inside gamescope-session).
#   3. Fall back to $DISPLAY already in env.
#   4. Last resort: :0 (the conventional gamescope inner display).
# Works in both gaming mode (gamescope inner X) and desktop (KDE/GNOME).
ExecStart=/bin/sh -c '\
  GS_DISPLAY=""; \
  GS_WAYLAND=""; \
  PID=$(pgrep -x steam | head -n1); \
  if [ -n "$PID" ] && [ -r "/proc/$PID/environ" ]; then \
    GS_DISPLAY=$(tr "\\0" "\\n" < "/proc/$PID/environ" | sed -n "s/^GAMESCOPE_DISPLAY=//p" | head -n1); \
    GS_WAYLAND=$(tr "\\0" "\\n" < "/proc/$PID/environ" | sed -n "s/^GAMESCOPE_WAYLAND_DISPLAY=//p" | head -n1); \
    # SteamOS exports GAMESCOPE_WAYLAND_DISPLAY into steam's environment but
    # not GAMESCOPE_DISPLAY, so the sed above comes back empty in Gaming Mode
    # and the pgrep branch below is what actually resolves the display there.
    # Steam already knows the inner X display, so read it rather than letting
    # the fallback assume ":0".
    if [ -z "$GS_DISPLAY" ] && [ -n "$GS_WAYLAND" ]; then \
      GS_DISPLAY=$(tr "\\0" "\\n" < "/proc/$PID/environ" | sed -n "s/^DISPLAY=//p" | head -n1); \
    fi; \
  fi; \
  # gamescope's kernel comm name on Linux is "gamescope-wl", so a bare
  # `pgrep -x gamescope` misses it — match the real comm instead.
  #
  # Do NOT go back to `pgrep -f`: -f matches against full command lines,
  # and this entire script is the argv of the `sh -c` that runs it. The
  # GS_WAYLAND="gamescope-0" assignment below is therefore part of our own
  # command line, so `pgrep -f "gamescope[- ]"` matched this very shell
  # (pgrep excludes itself, but not its parent) and reported gamescope on
  # every desktop session. `pgrep -x` matches comm, which is "sh" here, so
  # it cannot self-match.
  if [ -z "$GS_DISPLAY" ] && { pgrep -x gamescope-wl > /dev/null 2>&1 || pgrep -x gamescope > /dev/null 2>&1; }; then \
    GS_DISPLAY=":0"; \
    [ -z "$GS_WAYLAND" ] && GS_WAYLAND="gamescope-0"; \
  fi; \
  if [ -n "$GS_DISPLAY" ]; then \
    export DISPLAY="$GS_DISPLAY"; \
    [ -n "$GS_WAYLAND" ] && export GAMESCOPE_WAYLAND_DISPLAY="$GS_WAYLAND"; \
    export GAMESCOPE_DISPLAY="$GS_DISPLAY"; \
  else \
    export DISPLAY="${DISPLAY:-:0}"; \
  fi; \
  echo "[loadout-overlay] DISPLAY=$DISPLAY GAMESCOPE_DISPLAY=${GAMESCOPE_DISPLAY:-unset} GAMESCOPE_WAYLAND_DISPLAY=${GAMESCOPE_WAYLAND_DISPLAY:-unset}"; \
  exec %h/.local/share/loadout-overlay/bin/launcher'

WorkingDirectory=%h/.local/share/loadout-overlay
Restart=on-failure
RestartSec=5

# Belt-and-braces safety net: if the overlay dies ungracefully with
# Steam still SIGSTOP'd, the whole machine looks frozen. Our Bun
# shutdown handler calls SIGCONT first, but it may not run on
# SIGKILL / segfault / OOM-kill. This ExecStopPost runs regardless
# of exit status ('-' prefix) and is a no-op if Steam is already
# running.
ExecStopPost=-/bin/sh -c 'pkill -CONT -x steam || true'

[Install]
WantedBy=graphical-session.target
OVERLAYEOF
        success "Overlay service file written to $OVERLAY_SERVICE_FILE"

        # Guard the --user calls: on a sessionless install (curl|sh over SSH
        # with no graphical session and no lingering, or run as root) the
        # per-user systemd bus is unavailable and these fail. Without `|| true`
        # `set -e` would abort here — right after the unit was written but
        # before the user-facing summary — leaving a confusing half-install.
        # The unit file is on disk regardless, so it'll be picked up on the
        # next graphical login even if we couldn't reload/enable now.
        if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable loadout-overlay 2>/dev/null; then
            success "Overlay service enabled (starts with graphical session)"
        else
            warn "Couldn't enable the overlay user service now (no active user session?)."
            warn "It'll be picked up on your next graphical login; or enable it manually:"
            warn "  systemctl --user enable --now loadout-overlay"
        fi

        # Start it right now (not just on next login) and pop the window so
        # the user can set their wake button immediately — no reboot, no
        # Steam restart needed for this (that's only for Gaming Mode focus).
        # Needs a graphical session; import its env so the user manager can
        # find the display. Skips cleanly on headless / SSH installs.
        if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
            systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2>/dev/null || true
            # Graceful restart — a plain `restart` can race CEF: the new
            # instance launches while the old one's helper/zygote children
            # still hold the browser profile under CEF/partitions/default,
            # which fails with "Cannot create profile at path ..." and a
            # blank webview. Stop, wait for the process tree to exit, start.
            systemctl --user stop loadout-overlay 2>/dev/null || true
            for _ in 1 2 3 4 5 6 7 8 9 10; do
                pgrep -f "$OVERLAY_INSTALL_DIR/bin" >/dev/null 2>&1 || break
                sleep 0.5
            done
            pkill -TERM -f "$OVERLAY_INSTALL_DIR/bin" 2>/dev/null || true
            sleep 0.5
            if systemctl --user start loadout-overlay 2>/dev/null; then
                # Give the overlay a moment to come up and connect, then ask
                # the loader to show it (loopback /show endpoint).
                show_ok=0
                for _ in 1 2 3 4 5 6 7 8 9 10; do
                    if curl -fsS "http://localhost:$OVERLAY_PORT/show" >/dev/null 2>&1; then
                        show_ok=1
                        break
                    fi
                    sleep 1
                done
                if [ "$show_ok" = "1" ]; then
                    success "Overlay opened — set your wake button, then close it."
                else
                    info "Overlay started; open it from your apps menu to set a wake button."
                fi
            else
                warn "Couldn't start the overlay now; it'll start with your next graphical session."
            fi
        else
            info "No graphical session detected — the overlay starts on your next login."
        fi
    fi

    echo ""
    success "=== Phase 1 complete ==="
    info "Binary:   $BINARY_PATH"
    if [ -x "$OVERLAY_LAUNCHER" ]; then
        info "Overlay:  $OVERLAY_LAUNCHER"
    fi
    info "Symlink:  $BIN_LINK"
    info "Desktop:  $DESKTOP_FILE"
    info "Service:  $SYSTEM_SERVICE_FILE"
    info "UI:       http://localhost:$OVERLAY_PORT"
    info "Plugins:  $INSTALL_DIR/plugins"
    echo ""
}

# ============================================================
# Phase 2: System dependencies (optional, may require sudo)
# ============================================================

phase2() {
    info "=== Phase 2: System dependencies (optional) ==="
    echo ""

    phase2_input_group
    phase2_inputplumber

    echo ""
    success "=== Phase 2 complete ==="
    echo ""
}

# The overlay's evdev grab (EVIOCGRAB on /dev/input/event*) requires the
# user to be in the `input` group. Without this the overlay loads but
# can't capture controller buttons — F16/QAM toggles silently no-op.
# Audit 2026-05 G-011.
phase2_input_group() {
    echo ""
    info "--- input group membership (needed for controller capture) ---"

    if id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx input; then
        success "$USER is already in the input group."
        return
    fi

    info "The overlay needs to grab /dev/input/event* devices to read"
    info "controller buttons. That requires membership in the 'input' group."
    echo ""

    # Default-yes: a bare <enter> accepts, since the overlay can't capture
    # controllers without it.
    if ! prompt_yn "Add $USER to the 'input' group? (needed for the overlay to capture controller buttons) (Y/n)" "y"; then
        warn "Skipped. You'll need to add yourself to 'input' manually before the overlay can grab controllers:"
        warn "  sudo usermod -aG input \"\$USER\""
        warn "  # then log out and back in"
        return
    fi

    info "Adding $USER to the input group (requires sudo)..."
    if sudo usermod -aG input "$USER"; then
        success "$USER added to the input group."
        warn "You must log out and back in (or reboot) for the group change to take effect."
    else
        error "Failed to add $USER to the input group."
        warn "Run this manually: sudo usermod -aG input \"\$USER\""
    fi
}

# InputPlumber is what produces the evdev event the overlay listens for
# when a controller button is pressed in-game. Steam Input owns the
# controller HID in big-picture / gamescope sessions, so the overlay's
# own evdev grab can't see button presses under a game — IP sits below
# Steam Input and emits a virtual keyboard the overlay can read.
#
# This step is a convenience: the welcome wizard inside the app does
# the same thing (and remains the canonical place for re-runs, repair,
# and the case where the app was installed via flatpak/Discover rather
# than this script). Phase 2 just gets the user to a working state
# before they ever launch the app.
#
# Delegates to the input-plumber plugin's own installer
# (./plugins/input-plumber/scripts/install-inputplumber.sh), which:
#   - Exits early ("nothing to do") when IP is already on PATH
#   - Otherwise installs IP via pacman / dnf / upstream tarball, then
#     enables + starts inputplumber.service
#
# It does NOT touch HHD. This comment used to claim it "stops + masks any
# conflicting hhd*.service units"; nothing here has ever done that.
#
# That early exit is load-bearing, not an optimisation: SteamOS ships IP
# with the image (disabled), and Bazzite ships it too, so on both the
# installer short-circuits before it can enable anything. That is what
# makes the "leaves it untouched" promise below true and what keeps IP
# from being enabled alongside a live HHD. Don't remove detect_installed
# without replacing the guarantee.
# Idempotent — re-running is safe.
phase2_inputplumber() {
    echo ""
    info "--- InputPlumber (recommended on handhelds) ---"

    IP_SCRIPT="$INSTALL_DIR/plugins/input-plumber/scripts/install-inputplumber.sh"
    if [ ! -f "$IP_SCRIPT" ]; then
        warn "input-plumber plugin not staged (script missing at $IP_SCRIPT)."
        warn "Skip — you can run this later from the welcome wizard, or build the plugin from source."
        return
    fi

    # Short-circuit if IP is already up and HHD isn't fighting it. No
    # point prompting the user for a no-op sudo.
    if command -v inputplumber >/dev/null 2>&1 \
       && systemctl is-active --quiet inputplumber.service 2>/dev/null \
       && ! systemctl list-units --plain --no-legend --type=service --state=active 'hhd*' 2>/dev/null | grep -q hhd; then
        success "InputPlumber is already installed, active, and uncontested. Skipping."
        return
    fi

    info "Loadout uses InputPlumber to route a controller button to the"
    info "overlay when you're in a game (Steam Input owns the controller in"
    info "big-picture / gamescope, so a daemon below it is the only way to"
    info "produce an event the overlay can see). Required on handhelds;"
    info "optional on a plain desktop."
    info ""
    info "On Bazzite IP is already installed — this is a no-op."
    info "On SteamOS Deck IP is already installed but ships disabled — this"
    info "step leaves it untouched. Enabling it (and claiming the Deck's"
    info "built-in controller) happens in-app when you choose an overlay wake"
    info "button, so it stays opt-in."
    info "On CachyOS/Arch this installs the pacman package."
    echo ""

    # Default-yes on <enter> to match the Phase 2 gate: controller wake
    # in-game doesn't work without IP, and the guard above already made
    # this a no-op when IP is installed and uncontested. The gate is what
    # refuses to run any of this unattended, so no separate default here.
    if ! prompt_yn "Install / enable InputPlumber now? (Y/n)" "y"; then
        info "Skipping. You can do this later from the welcome wizard."
        return
    fi

    info "Running $(basename "$IP_SCRIPT") (requires sudo)..."
    if sudo bash "$IP_SCRIPT"; then
        success "InputPlumber setup complete."
    else
        warn "InputPlumber setup script returned non-zero — check the log above."
        warn "You can re-run from the welcome wizard."
    fi
}

# ============================================================
# Main
# ============================================================

main() {
    echo ""
    info "========================================="
    info "  Loadout Installer"
    info "========================================="
    echo ""

    phase1

    echo ""
    # Default-yes on <enter>: without Phase 2 the overlay can't capture
    # controllers, so the common single-command install should get it.
    # Still declined with no terminal — this shells out to sudo, installs a
    # package and masks HHD, none of which should happen unattended.
    if prompt_yn "Run Phase 2 (input group + InputPlumber)? May require sudo. (Y/n)" "y" "n"; then
        phase2
    else
        info "Skipping Phase 2."
        info "Without it: overlay can't grab controllers (input group), and controller-button"
        info "wake-in-game won't work (InputPlumber)."
        info "Re-run the installer or use the welcome wizard inside the app to add any later."
    fi

    echo ""
    success "========================================="
    success "  Installation complete!"
    success "========================================="
    echo ""
    info "Commands (backend is a root system service):"
    info "  Status:  systemctl status loadout"
    info "  Logs:    journalctl -u loadout -f"
    info "  Stop:    sudo systemctl stop loadout"
    info "  Start:   sudo systemctl start loadout"
    info "  Restart: sudo systemctl restart loadout"
    echo ""
    info "Overlay:   http://localhost:$OVERLAY_PORT"
    info "Plugins:   $INSTALL_DIR/plugins"
    echo ""
    warn "Restart Steam once so it picks up CEF remote debugging — required for"
    warn "the overlay to grab focus cleanly over Steam's menus (and for plugins"
    warn "that talk to Steam). Big Picture: Steam > Power > Restart Steam."
    echo ""
}

main
