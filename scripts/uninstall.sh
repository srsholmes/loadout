#!/bin/sh
# Loadout uninstaller script
# Reverses everything done by install.sh, idempotent (safe to run multiple times)
# Usage: curl -fsSL https://raw.githubusercontent.com/srsholmes/loadout/main/scripts/uninstall.sh | sh

set -e

# Configuration
INSTALL_DIR="$HOME/.local/share/loadout"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
# Binary path is distro-dependent — must mirror install.sh's branching
# so we remove from the path it was actually written to. See
# docs/install-locations.md. SteamOS: ~/.local/share/loadout/loadout
# (user-writable, no /usr); everywhere else: /usr/local/bin/loadout
# (system path, removal needs sudo).
case "$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")" in
    steamos)
        BINARY_PATH="$INSTALL_DIR/loadout"
        BIN_NEEDS_SUDO=0
        ;;
    *)
        BINARY_PATH="/usr/local/bin/loadout"
        BIN_NEEDS_SUDO=1
        ;;
esac
BIN_LINK="$HOME/.local/bin/loadout"
SERVICE_DIR="$HOME/.config/systemd/user"
# Obsolete per-user backend unit (the backend is now a root system unit).
SERVICE_FILE="$SERVICE_DIR/loadout.service"
SYSTEM_SERVICE_FILE="/etc/systemd/system/loadout.service"
OVERLAY_SERVICE_FILE="$SERVICE_DIR/loadout-overlay.service"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/loadout.desktop"
CONFIG_DIR="$HOME/.config/loadout"

# Colors (only if terminal supports them)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
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

# Where prompts read from. Under the documented `curl … | sh` uninstall,
# stdin is the script text itself, so `[ -t 0 ]` is false and a bare
# `read` would eat the script rather than the user's answer — the
# plugin-data and config prompts below could never be answered. Read the
# controlling terminal instead. Empty only when there's genuinely no
# terminal (CI, systemd), where prompts fall back to the default (no).
PROMPT_TTY=""
if { true < /dev/tty; } 2>/dev/null; then
    PROMPT_TTY=/dev/tty
fi

# Prompt user for yes/no (defaults to no)
prompt_yn() {
    if [ -z "$PROMPT_TTY" ]; then
        # No terminal to ask on: use default (no)
        return 1
    fi
    printf "%s " "$1" > "$PROMPT_TTY"
    # EOF on the terminal is treated as the default rather than hanging.
    read -r answer < "$PROMPT_TTY" || answer=""
    case "$answer" in
        [Yy]*) return 0 ;;
        *) return 1 ;;
    esac
}

main() {
    echo ""
    info "========================================="
    info "  Loadout Uninstaller"
    info "========================================="
    echo ""

    # --- Overlay (user service): stop, disable, remove ---
    if systemctl --user is-active loadout-overlay >/dev/null 2>&1; then
        info "Stopping loadout-overlay..."
        systemctl --user stop loadout-overlay || true
    fi
    systemctl --user disable loadout-overlay 2>/dev/null || true
    rm -f "$OVERLAY_SERVICE_FILE"
    # Drop the obsolete per-user backend unit if a prior install left one.
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload
    success "Overlay user service removed."

    # --- Backend (root system service): stop, disable, remove (needs sudo) ---
    if systemctl is-active loadout >/dev/null 2>&1 || [ -f "$SYSTEM_SERVICE_FILE" ]; then
        info "Removing the loadout system service (needs sudo)..."
        sudo systemctl disable --now loadout 2>/dev/null || true
        sudo rm -f "$SYSTEM_SERVICE_FILE"
        sudo systemctl daemon-reload
        success "Backend system service removed."
    else
        info "Backend system service not installed."
    fi

    # --- Remove .desktop file ---
    if [ -f "$DESKTOP_FILE" ]; then
        info "Removing .desktop file..."
        rm -f "$DESKTOP_FILE"
        success "Desktop file removed."
        # Update desktop database if available
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
        fi
    else
        info "Desktop file not found (already removed)."
    fi

    # --- Remove ~/.local/bin symlink ---
    if [ -L "$BIN_LINK" ]; then
        info "Removing symlink $BIN_LINK..."
        rm -f "$BIN_LINK"
        success "Symlink removed."
    elif [ -f "$BIN_LINK" ]; then
        info "Removing $BIN_LINK..."
        rm -f "$BIN_LINK"
        success "Binary removed from $BIN_LINK."
    else
        info "Symlink $BIN_LINK not found (already removed)."
    fi

    echo ""

    # --- Remove the binary (sudo only when system-owned, per install.sh) ---
    if [ -f "$BINARY_PATH" ]; then
        if [ "$BIN_NEEDS_SUDO" = "1" ]; then
            info "Removing $BINARY_PATH (needs sudo)..."
            sudo rm -f "$BINARY_PATH"
        else
            info "Removing $BINARY_PATH..."
            rm -f "$BINARY_PATH"
        fi
        success "Binary removed."
    else
        info "Binary not found at $BINARY_PATH (already removed)."
    fi

    # --- Ask about plugin data ---
    if [ -d "$INSTALL_DIR" ]; then
        if prompt_yn "Remove plugin data at $INSTALL_DIR? (y/N)"; then
            info "Removing plugin data..."
            rm -rf "$INSTALL_DIR"
            success "Removed $INSTALL_DIR"
        else
            info "Plugin data preserved at: $INSTALL_DIR"
        fi
    else
        info "Plugin data directory not found (already removed)."
    fi

    # --- Remove overlay install directory ---
    if [ -d "$OVERLAY_INSTALL_DIR" ]; then
        info "Removing overlay tree at $OVERLAY_INSTALL_DIR..."
        rm -rf "$OVERLAY_INSTALL_DIR"
        success "Overlay removed."
    else
        info "Overlay directory not found (already removed)."
    fi

    # --- Ask about configuration ---
    if [ -d "$CONFIG_DIR" ]; then
        if prompt_yn "Remove configuration? (y/N)"; then
            info "Removing configuration..."
            rm -rf "$CONFIG_DIR"
            success "Configuration removed."
        else
            info "Configuration preserved at: $CONFIG_DIR"
        fi
    else
        info "Configuration directory not found (nothing to remove)."
    fi

    echo ""
    success "========================================="
    success "  Loadout has been uninstalled."
    success "========================================="
    echo ""
}

main
