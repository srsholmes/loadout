#!/bin/sh
# Loadout build script
# Uses `bun build --compile` to produce a single self-contained binary.
#
# Output: dist/loadout (single binary, ~50-100MB depending on bundled assets)
#
# Prerequisites:
#   - Bun >= 1.0 (https://bun.sh)
#   - All dependencies installed (bun install)
#
# Usage:
#   sh scripts/build.sh              # Build for current platform
#   sh scripts/build.sh --verbose    # Build with verbose output
#
# The compiled binary embeds the Bun runtime and all TypeScript/JavaScript code.
# It does NOT include:
#   - Electrobun overlay tree (apps/loadout-overlay/) — built below via
#     vite + electrobun and copied by scripts/install-local.sh.
#   - CEF runtime — downloaded by Electrobun on first build and bundled into
#     the overlay install prefix.
#   - Plugin directories — loaded at runtime from PLUGINS_DIR

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY_POINT="$PROJECT_ROOT/apps/loadout/src/index.ts"
DIST_DIR="$PROJECT_ROOT/dist"
OUTPUT="$DIST_DIR/loadout"

# Colors (only if terminal supports them)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    BLUE='\033[0;34m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    GREEN=''
    BLUE=''
    YELLOW=''
    RED=''
    BOLD=''
    NC=''
fi

info() {
    printf "${BLUE}[BUILD]${NC} %s\n" "$1"
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

# --- Determine version ---

get_version() {
    # Priority: git tag > package.json version > "dev"
    VERSION=""

    # Try git tag first (e.g., v0.1.0 -> 0.1.0)
    if command -v git >/dev/null 2>&1 && git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        GIT_TAG="$(git -C "$PROJECT_ROOT" describe --tags --exact-match 2>/dev/null || true)"
        if [ -n "$GIT_TAG" ]; then
            VERSION="$(printf '%s' "$GIT_TAG" | sed 's/^v//')"
        fi
    fi

    # Fall back to package.json
    if [ -z "$VERSION" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
        # Extract version without jq (POSIX-compatible)
        VERSION="$(grep '"version"' "$PROJECT_ROOT/package.json" 2>/dev/null | head -1 | sed 's/.*"version": *"//;s/".*//')"
    fi

    # Fall back to git short hash
    if [ -z "$VERSION" ] && command -v git >/dev/null 2>&1; then
        GIT_HASH="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
        if [ -n "$GIT_HASH" ]; then
            VERSION="dev-$GIT_HASH"
        fi
    fi

    # Ultimate fallback
    if [ -z "$VERSION" ]; then
        VERSION="dev"
    fi

    printf '%s' "$VERSION"
}

# --- Check prerequisites ---

check_prereqs() {
    if ! command -v bun >/dev/null 2>&1; then
        error "Bun is not installed. Install it from https://bun.sh"
        exit 1
    fi

    BUN_VERSION="$(bun --version 2>/dev/null)"
    info "Bun version: $BUN_VERSION"

    if [ ! -f "$ENTRY_POINT" ]; then
        error "Entry point not found: $ENTRY_POINT"
        exit 1
    fi

    # Check that dependencies are installed
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        warn "node_modules not found. Running bun install..."
        (cd "$PROJECT_ROOT" && bun install)
    fi
}

# --- Build ---

build() {
    VERSION="$(get_version)"
    ARCH="$(uname -m)"
    PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
    BUILD_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    info "========================================="
    info "  Loadout Build"
    info "========================================="
    info "Version:    $VERSION"
    info "Platform:   $PLATFORM/$ARCH"
    info "Entry:      $ENTRY_POINT"
    info "Output:     $OUTPUT"
    info "Date:       $BUILD_DATE"
    info "========================================="
    echo ""

    # Create dist directory
    mkdir -p "$DIST_DIR"

    # Clean previous build
    if [ -f "$OUTPUT" ]; then
        info "Removing previous build..."
        rm -f "$OUTPUT"
    fi

    # Run bun build --compile
    info "Compiling binary..."

    DEFINE_FLAGS=""
    DEFINE_FLAGS="$DEFINE_FLAGS --define __LOADOUT_VERSION__='\"$VERSION\"'"
    DEFINE_FLAGS="$DEFINE_FLAGS --define __LOADOUT_BUILD_DATE__='\"$BUILD_DATE\"'"

    BUILD_START="$(date +%s)"

    # shellcheck disable=SC2086
    if ! (cd "$PROJECT_ROOT" && bun build "$ENTRY_POINT" \
        --compile \
        --outfile "$OUTPUT" \
        $DEFINE_FLAGS \
        --minify); then
        error "Build failed!"
        exit 1
    fi

    BUILD_END="$(date +%s)"
    BUILD_DURATION=$((BUILD_END - BUILD_START))

    if [ ! -f "$OUTPUT" ]; then
        error "Build completed but output file not found: $OUTPUT"
        exit 1
    fi

    chmod +x "$OUTPUT"

    # Report results
    BINARY_SIZE="$(wc -c < "$OUTPUT" | tr -d ' ')"
    BINARY_SIZE_MB="$((BINARY_SIZE / 1024 / 1024))"

    echo ""
    success "========================================="
    success "  Build complete!"
    success "========================================="
    info "Binary:     $OUTPUT"
    info "Size:       ${BINARY_SIZE_MB}MB ($BINARY_SIZE bytes)"
    info "Version:    $VERSION"
    info "Duration:   ${BUILD_DURATION}s"
    echo ""
    info "Test it:"
    info "  $OUTPUT --help"
    info "  $OUTPUT"
    echo ""
    info "Install it:"
    info "  cp $OUTPUT ~/.local/share/loadout/loadout"
    echo ""

    # Build Electrobun overlay. Vite builds the webview (React, tailwind,
    # alias resolution) then Electrobun bundles it + CEF + Bun main into
    # apps/loadout-overlay/build/. scripts/install-local.sh copies
    # that tree into the install prefix.
    ELECTROBUN_DIR="$PROJECT_ROOT/apps/loadout-overlay"
    if [ -f "$ELECTROBUN_DIR/electrobun.config.ts" ]; then
        echo ""
        info "Building Electrobun overlay..."
        if (cd "$ELECTROBUN_DIR" && bunx vite build 2>&1 && bunx electrobun build --release 2>&1); then
            success "Electrobun overlay built (see $ELECTROBUN_DIR/build/ for artifacts)"
            # Swap our patched libNativeWrapper.so over the stock one electrobun
            # downloaded (CEF 100%-CPU spin fix — see vendor/README.md). Shared
            # with apps/loadout-overlay's package.json build scripts so every
            # build path gets it.
            sh "$PROJECT_ROOT/scripts/inject-patched-wrapper.sh" "$ELECTROBUN_DIR"
        else
            warn "Electrobun overlay build failed. Backend binary is still usable."
        fi
    else
        warn "Electrobun overlay not found at $ELECTROBUN_DIR — skipping."
    fi
}

# --- Main ---

VERBOSE=0
for arg in "$@"; do
    case "$arg" in
        --verbose|-v) VERBOSE=1 ;;
        --help|-h)
            echo "Usage: $0 [--verbose] [--help]"
            echo ""
            echo "Build Loadout into a single self-contained binary."
            echo ""
            echo "Options:"
            echo "  --verbose, -v   Show detailed build output"
            echo "  --help, -h      Show this help message"
            echo ""
            echo "Output: dist/loadout"
            exit 0
            ;;
        *)
            warn "Unknown option: $arg"
            ;;
    esac
done

check_prereqs
build
