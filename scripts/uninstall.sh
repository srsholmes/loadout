#!/bin/sh
# Loadout uninstaller script
# Reverses everything done by install.sh, idempotent (safe to run multiple times)
# Usage: curl -fsSL https://raw.githubusercontent.com/srsholmes/linux-gaming-plugin-manager/main/scripts/uninstall.sh | sh

set -e

# Configuration
INSTALL_DIR="$HOME/.local/share/loadout"
OVERLAY_INSTALL_DIR="$HOME/.local/share/loadout-overlay"
BINARY_PATH="$INSTALL_DIR/loadout"
BIN_LINK="$HOME/.local/bin/loadout"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/loadout.service"
OVERLAY_SERVICE_FILE="$SERVICE_DIR/loadout-overlay.service"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/loadout.desktop"
CONFIG_DIR="$HOME/.config/loadout"
POLKIT_POLICY="com.loadout.tdp-helper.policy"
POLKIT_DIR="/usr/share/polkit-1/actions"

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

# Prompt user for yes/no (defaults to no)
prompt_yn() {
    if [ ! -t 0 ]; then
        # Non-interactive: use default (no)
        return 1
    fi
    printf "%s " "$1"
    read -r answer
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

    # --- Stop services (overlay first, then backend it depends on) ---
    for unit in loadout-overlay loadout; do
        if systemctl --user is-active "$unit" >/dev/null 2>&1; then
            info "Stopping $unit service..."
            systemctl --user stop "$unit"
            success "$unit stopped."
        else
            info "$unit is not running."
        fi
    done

    # --- Disable services ---
    for unit in loadout-overlay loadout; do
        if systemctl --user is-enabled "$unit" >/dev/null 2>&1; then
            info "Disabling $unit service..."
            systemctl --user disable "$unit"
            success "$unit disabled."
        else
            info "$unit is not enabled."
        fi
    done

    # --- Remove the service files ---
    for unit_file in "$SERVICE_FILE" "$OVERLAY_SERVICE_FILE"; do
        if [ -f "$unit_file" ]; then
            info "Removing $(basename "$unit_file")..."
            rm -f "$unit_file"
            success "$(basename "$unit_file") removed."
        fi
    done

    # --- Reload systemd ---
    info "Reloading systemd user daemon..."
    systemctl --user daemon-reload
    success "Systemd reloaded."

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

    # --- Ask about plugin data ---
    if [ -d "$INSTALL_DIR" ]; then
        if prompt_yn "Remove all Loadout data (binary, plugins, helpers)? (y/N)"; then
            info "Removing all Loadout data..."
            rm -rf "$INSTALL_DIR"
            success "Removed $INSTALL_DIR"
        else
            info "Keeping data. Removing only the binary..."
            if [ -f "$BINARY_PATH" ]; then
                rm -f "$BINARY_PATH"
                success "Binary removed."
            else
                info "Binary not found (already removed)."
            fi
            info "Plugin data preserved at: $INSTALL_DIR"
        fi
    else
        info "Install directory not found (already removed)."
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

    # --- Ask about polkit policy ---
    if [ -f "$POLKIT_DIR/$POLKIT_POLICY" ]; then
        echo ""
        if prompt_yn "Remove polkit policy for TDP helper? (requires sudo) (y/N)"; then
            info "Removing polkit policy..."
            if sudo rm -f "$POLKIT_DIR/$POLKIT_POLICY"; then
                success "Polkit policy removed."
            else
                warn "Failed to remove polkit policy. Remove manually:"
                info "  sudo rm $POLKIT_DIR/$POLKIT_POLICY"
            fi
        else
            info "Polkit policy preserved."
        fi
    fi

    echo ""
    success "========================================="
    success "  Loadout has been uninstalled."
    success "========================================="
    echo ""
}

main
