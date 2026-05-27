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
BINARY_PATH="$INSTALL_DIR/$BINARY_NAME"
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

# Prompt user for yes/no (defaults to $2 if provided, otherwise no)
prompt_yn() {
    if [ ! -t 0 ]; then
        # Non-interactive: use default
        case "${2:-n}" in
            [Yy]*) return 0 ;;
            *) return 1 ;;
        esac
    fi
    printf "%s " "$1"
    read -r answer
    case "$answer" in
        [Yy]*) return 0 ;;
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

    RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"

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

    # Check if binary already exists
    if [ -f "$BINARY_PATH" ]; then
        if prompt_yn "Loadout binary already exists. Overwrite? (y/N)"; then
            info "Overwriting existing binary..."
        else
            info "Keeping existing binary."
            setup_desktop
            setup_service
            return
        fi
    fi

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

    # Move binary into place
    mv "$TEMP_FILE" "$BINARY_PATH"
    chmod +x "$BINARY_PATH"
    success "Binary installed to $BINARY_PATH"

    # Download the overlay binary
    download_overlay "$ARCH"

    # Download and stage plugins. The loader binary expects every plugin's
    # backend + workspace deps on disk; without this step the public installer
    # leaves $INSTALL_DIR/plugins/ empty and nothing renders. Audit 2026-05 H-002.
    download_plugins "$ARCH"

    # Create symlink in ~/.local/bin so it's on PATH
    setup_bin_link
    setup_desktop
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
ExecStart=$HOME/.local/share/loadout/loadout --user $(id -un)
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
        cat > "$OVERLAY_SERVICE_FILE" <<'OVERLAYEOF'
[Unit]
Description=Loadout Overlay
# The backend (loadout.service) is a *system* service running as root, so
# this *user* unit can't Requires=/After= it across managers. Ordering is
# handled by the ExecStartPre curl-`/up` wait loop below.
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
  fi; \
  # gamescope's kernel comm name on Linux is "gamescope-wl" so `pgrep -x`
  # on it fails. Match via -f against a pattern. steamcompmgr is a
  # reliable secondary signal.
  if [ -z "$GS_DISPLAY" ] && pgrep -f "gamescope[- ]" > /dev/null 2>&1; then \
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

        systemctl --user daemon-reload
        systemctl --user enable loadout-overlay
        success "Overlay service enabled (starts with graphical session)"
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

    # Default-yes: empty answer (just <enter>) accepts. Honors the (Y/n)
    # hint without needing to restructure the shared prompt_yn helper.
    INPUT_GROUP_ANSWER=""
    if [ -t 0 ]; then
        printf "Add %s to the 'input' group? (needed for the overlay to capture controller buttons) (Y/n) " "$USER"
        read -r INPUT_GROUP_ANSWER
    else
        # Non-interactive (curl|sh): default to yes since the overlay is
        # useless without it.
        INPUT_GROUP_ANSWER="y"
    fi
    case "$INPUT_GROUP_ANSWER" in
        [Nn]*)
            warn "Skipped. You'll need to add yourself to 'input' manually before the overlay can grab controllers:"
            warn "  sudo usermod -aG input \"\$USER\""
            warn "  # then log out and back in"
            return
            ;;
    esac

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
#   - Detects + installs IP via pacman / dnf / upstream tarball
#   - Enables + starts inputplumber.service
#   - Stops + masks any conflicting hhd*.service units
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
    info "On SteamOS Deck IP ships disabled — this enables it."
    info "On CachyOS/Arch this installs the pacman package."
    info ""
    info "If Handheld Daemon (HHD) is running it'll be stopped and masked —"
    info "it conflicts with IP over controller HID ownership."
    echo ""

    if ! prompt_yn "Install / enable InputPlumber now? (y/N)"; then
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
    if prompt_yn "Run Phase 2 (input group + InputPlumber)? May require sudo. (y/N)"; then
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
}

main
