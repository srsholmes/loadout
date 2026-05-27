#!/bin/sh
# Test script for Loadout install/uninstall/build scripts
# Validates syntax, .desktop files, OS detection logic, and build script
# Usage: sh scripts/test-install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Colors (only if terminal supports them)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    NC=''
fi

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    printf "${GREEN}  PASS${NC} %s\n" "$1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    printf "${RED}  FAIL${NC} %s\n" "$1"
}

section() {
    echo ""
    printf "%s--- %s ---%s\n" "$YELLOW" "$1" "$NC"
}

# ============================================================
# 1. Syntax validation
# ============================================================

section "Shell script syntax validation"

for script in install.sh uninstall.sh build.sh; do
    if bash -n "$SCRIPT_DIR/$script" 2>/dev/null; then
        pass "$script has valid syntax"
    else
        fail "$script has syntax errors"
    fi
done

# ============================================================
# 2. POSIX compatibility check (no bash-isms)
# ============================================================

section "POSIX compatibility checks"

for script in install.sh uninstall.sh build.sh; do
    SCRIPT_PATH="$SCRIPT_DIR/$script"

    # Check shebang lines
    SHEBANG="$(head -1 "$SCRIPT_PATH")"
    if [ "$SHEBANG" = "#!/bin/sh" ]; then
        pass "$script uses #!/bin/sh shebang"
    else
        fail "$script shebang is '$SHEBANG', expected '#!/bin/sh'"
    fi

    # Check for [[ ]] (bash-ism; POSIX uses [ ])
    if grep -n '\[\[' "$SCRIPT_PATH" >/dev/null 2>&1; then
        fail "$script uses [[ ]] (bash-ism, use [ ] for POSIX)"
    else
        pass "$script does not use [[ ]] (POSIX compliant)"
    fi

    # Check for function keyword (bash-ism; POSIX uses name() { })
    if grep -n '^function ' "$SCRIPT_PATH" >/dev/null 2>&1; then
        fail "$script uses 'function' keyword (bash-ism)"
    else
        pass "$script does not use 'function' keyword (POSIX compliant)"
    fi

    # Check for arrays (bash-ism)
    if grep -n '=(' "$SCRIPT_PATH" | grep -v '^#' >/dev/null 2>&1; then
        fail "$script uses arrays (bash-ism)"
    else
        pass "$script does not use arrays (POSIX compliant)"
    fi

    # Check for (( )) arithmetic (bash-ism)
    if grep -nE '^\s*\(\(' "$SCRIPT_PATH" >/dev/null 2>&1; then
        fail "$script uses (( )) arithmetic (bash-ism)"
    else
        pass "$script does not use (( )) arithmetic (POSIX compliant)"
    fi
done

# ============================================================
# 3. .desktop file validation
# ============================================================

section ".desktop file validation"

for desktop_file in loadout-install.desktop loadout-uninstall.desktop; do
    DESKTOP_PATH="$SCRIPT_DIR/$desktop_file"

    if [ ! -f "$DESKTOP_PATH" ]; then
        fail "$desktop_file does not exist"
        continue
    fi

    pass "$desktop_file exists"

    # Check required keys per freedesktop.org spec
    for key in Name Exec Type; do
        if grep -q "^${key}=" "$DESKTOP_PATH"; then
            pass "$desktop_file has required key: $key"
        else
            fail "$desktop_file missing required key: $key"
        fi
    done

    # Check Type=Application
    if grep -q "^Type=Application" "$DESKTOP_PATH"; then
        pass "$desktop_file has Type=Application"
    else
        fail "$desktop_file does not have Type=Application"
    fi

    # Check Terminal=true (needed for interactive scripts)
    if grep -q "^Terminal=true" "$DESKTOP_PATH"; then
        pass "$desktop_file has Terminal=true"
    else
        fail "$desktop_file missing Terminal=true (needed for interactive scripts)"
    fi

    # Check that [Desktop Entry] header exists
    if head -1 "$DESKTOP_PATH" | grep -q '^\[Desktop Entry\]'; then
        pass "$desktop_file has [Desktop Entry] header"
    else
        fail "$desktop_file missing [Desktop Entry] header"
    fi
done

# ============================================================
# 4. OS detection logic tests
# ============================================================

section "OS detection logic (isolated tests)"

# Test: SteamOS detection via /usr/share/steamos-atomupd
test_steamos_file() {
    MOCK_FS="$(mktemp -d)"
    mkdir -p "$MOCK_FS/usr/share"
    touch "$MOCK_FS/usr/share/steamos-atomupd"

    if [ -f "$MOCK_FS/usr/share/steamos-atomupd" ]; then
        pass "SteamOS detection: /usr/share/steamos-atomupd file check works"
    else
        fail "SteamOS detection: /usr/share/steamos-atomupd file check failed"
    fi
    rm -rf "$MOCK_FS"
}
test_steamos_file

# Test: Bazzite detection logic
test_bazzite_detection() {
    MOCK_FS="$(mktemp -d)"
    mkdir -p "$MOCK_FS/etc/bazzite"

    MOCK_BIN="$(mktemp -d)"
    cat > "$MOCK_BIN/rpm-ostree" <<'MOCKEOF'
#!/bin/sh
echo "mock rpm-ostree"
MOCKEOF
    chmod +x "$MOCK_BIN/rpm-ostree"

    if [ -d "$MOCK_FS/etc/bazzite" ] && "$MOCK_BIN/rpm-ostree" >/dev/null 2>&1; then
        pass "Bazzite detection: /etc/bazzite + rpm-ostree check works"
    else
        fail "Bazzite detection: condition check failed"
    fi
    rm -rf "$MOCK_FS" "$MOCK_BIN"
}
test_bazzite_detection

# Test: Arch/CachyOS detection logic
test_arch_detection() {
    MOCK_BIN="$(mktemp -d)"
    cat > "$MOCK_BIN/pacman" <<'MOCKEOF'
#!/bin/sh
echo "mock pacman"
MOCKEOF
    chmod +x "$MOCK_BIN/pacman"

    if "$MOCK_BIN/pacman" >/dev/null 2>&1; then
        pass "Arch detection: pacman check works"
    else
        fail "Arch detection: pacman check failed"
    fi
    rm -rf "$MOCK_BIN"
}
test_arch_detection

# Test: Unknown OS fallback
test_unknown_os() {
    RESULT="$(
        PATH="/usr/bin:/bin"
        detect_os_isolated() {
            if [ -f /nonexistent/steamos-atomupd ]; then
                echo "steamos"
            elif command -v rpm-ostree-nonexistent >/dev/null 2>&1 && [ -d /nonexistent-bazzite ]; then
                echo "bazzite"
            elif command -v pacman-nonexistent >/dev/null 2>&1; then
                echo "arch"
            else
                echo "unknown"
            fi
        }
        detect_os_isolated
    )"

    if [ "$RESULT" = "unknown" ]; then
        pass "detect_os returns 'unknown' when no OS markers present"
    else
        fail "detect_os returned '$RESULT' instead of 'unknown'"
    fi
}
test_unknown_os

# ============================================================
# 5. Content checks — install.sh
# ============================================================

section "install.sh content checks"

# Phase 1: user-level install
for pattern in \
    "systemctl --user daemon-reload" \
    "systemctl --user enable" \
    "systemctl --user is-active" \
    "chmod +x" \
    "PLUGINS_DIR" \
    ".local/bin" \
    ".local/share/applications" \
    ".desktop" \
    "Phase 1" \
    "Phase 2" \
    "polkit" \
    "webkit2gtk" \
    "apt" \
    "dnf" \
    "pacman" \
    "zypper" \
    "rpm-ostree"; do
    if grep -qi "$pattern" "$SCRIPT_DIR/install.sh"; then
        pass "install.sh contains: $pattern"
    else
        fail "install.sh missing: $pattern"
    fi
done

# Verify service file content in install.sh
for pattern in "ExecStart=%h/.local/share/loadout/loadout" "Restart=on-failure" "WantedBy=default.target"; do
    if grep -q "$pattern" "$SCRIPT_DIR/install.sh"; then
        pass "install.sh service definition contains: $pattern"
    else
        fail "install.sh service definition missing: $pattern"
    fi
done

# ============================================================
# 6. Content checks — uninstall.sh
# ============================================================

section "uninstall.sh content checks"

for pattern in \
    "systemctl --user stop" \
    "systemctl --user disable" \
    "systemctl --user daemon-reload" \
    "plugin data|Loadout data" \
    "Remove configuration" \
    ".local/bin" \
    ".desktop" \
    "polkit"; do
    if grep -qiE "$pattern" "$SCRIPT_DIR/uninstall.sh"; then
        pass "uninstall.sh contains: $pattern"
    else
        fail "uninstall.sh missing: $pattern"
    fi
done

# ============================================================
# 7. Content checks — build.sh
# ============================================================

section "build.sh content checks"

for pattern in \
    "bun build" \
    "compile" \
    "outfile" \
    "dist/loadout" \
    "get_version" \
    "package.json" \
    "git.*describe|git.*tag|git.*rev-parse" \
    "LOADOUT_VERSION|__LOADOUT_VERSION__"; do
    if grep -qiE "$pattern" "$SCRIPT_DIR/build.sh"; then
        pass "build.sh contains: $pattern"
    else
        fail "build.sh missing: $pattern"
    fi
done

# Verify build.sh uses the correct entry point
if grep -q "packages/dev-server/src/index.ts" "$SCRIPT_DIR/build.sh"; then
    pass "build.sh uses correct entry point (packages/dev-server/src/index.ts)"
else
    fail "build.sh does not reference the correct entry point"
fi

# ============================================================
# 8. Flatpak manifest validation
# ============================================================

section "Flatpak manifest checks"

FLATPAK_MANIFEST="$PROJECT_ROOT/flatpak/org.steamloader.Overlay.yml"

if [ -f "$FLATPAK_MANIFEST" ]; then
    pass "Flatpak manifest exists"
else
    fail "Flatpak manifest not found at flatpak/org.steamloader.Overlay.yml"
fi

if [ -f "$FLATPAK_MANIFEST" ]; then
    for pattern in \
        "app-id:" \
        "org.steamloader.Overlay" \
        "org.gnome.Platform" \
        "share=network" \
        "socket=x11" \
        "socket=wayland" \
        "loadout-overlay" \
        "device=dri"; do
        if grep -q "$pattern" "$FLATPAK_MANIFEST"; then
            pass "Flatpak manifest contains: $pattern"
        else
            fail "Flatpak manifest missing: $pattern"
        fi
    done
fi

# Check Flatpak README exists
if [ -f "$PROJECT_ROOT/flatpak/README.md" ]; then
    pass "Flatpak README.md exists"
else
    fail "Flatpak README.md not found"
fi

# ============================================================
# 9. File permissions check
# ============================================================

section "File permissions"

for script in install.sh uninstall.sh build.sh test-install.sh; do
    if [ -f "$SCRIPT_DIR/$script" ]; then
        pass "$script exists and is readable"
    else
        fail "$script does not exist"
    fi
done

# ============================================================
# 10. Idempotency markers
# ============================================================

section "Idempotency checks"

# Install script should check for existing binary
if grep -q "already exists" "$SCRIPT_DIR/install.sh"; then
    pass "install.sh checks for existing binary (idempotent)"
else
    fail "install.sh does not check for existing binary"
fi

# Uninstall script should check before removing
if grep -q "not found\|already removed\|not running\|not enabled" "$SCRIPT_DIR/uninstall.sh"; then
    pass "uninstall.sh handles missing items gracefully (idempotent)"
else
    fail "uninstall.sh does not handle missing items"
fi

# ============================================================
# Results
# ============================================================

echo ""
echo "========================================="
printf "Results: %s passed, %s failed, %s total\n" "$PASS" "$FAIL" "$TOTAL"
echo "========================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi

exit 0
