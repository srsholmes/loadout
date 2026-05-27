#!/bin/bash
# Clone and build InputPlumber from upstream main.
#
# History: this used to track PR #567 (OXP HID driver). That PR was
# merged upstream in early 2026, so we now build straight from main.
# A stale local pr-567 branch in an existing vendor checkout will
# reference modules that have since been moved/removed upstream
# (e.g. `msi_claw`) and break the build — `git switch` + hard reset
# handle that case.
#
# Usage:
#   ./scripts/build-inputplumber.sh
#
# Output: vendor/InputPlumber/target/release/inputplumber
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IP_DIR="$REPO_DIR/vendor/InputPlumber"
IP_BRANCH="main"

echo "=== Building InputPlumber from upstream $IP_BRANCH ==="

# Check for cargo
if ! command -v cargo &>/dev/null; then
    echo "ERROR: cargo not found. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# Bazzite ships libclang via ROCm — point bindgen at it
if [ -z "${LIBCLANG_PATH:-}" ] && [ -d /usr/lib64/rocm/llvm/lib ]; then
    export LIBCLANG_PATH=/usr/lib64/rocm/llvm/lib
    export LD_LIBRARY_PATH="${LIBCLANG_PATH}:${LD_LIBRARY_PATH:-}"
    echo "Using ROCm libclang at $LIBCLANG_PATH"
fi

# ROCm's libclang doesn't auto-discover its own resource directory — the one
# that holds clang's compiler-shipped stddef.h/stdint.h. Without it, bindgen
# fails in crates that include <sys/types.h> with:
#   fatal error: 'stddef.h' file not found
# We detect the newest available resource dir under $LIBCLANG_PATH/clang/*/
# and pass it explicitly via BINDGEN_EXTRA_CLANG_ARGS. Using sort -V so if
# ROCm ever ships multiple versions side-by-side we pick the highest.
if [ -n "${LIBCLANG_PATH:-}" ]; then
    CLANG_RESOURCE_DIR="$(ls -d "$LIBCLANG_PATH"/clang/*/ 2>/dev/null \
        | sort -V | tail -1)"
    if [ -n "$CLANG_RESOURCE_DIR" ]; then
        # Trim trailing slash — clang -resource-dir chokes on it in some versions.
        CLANG_RESOURCE_DIR="${CLANG_RESOURCE_DIR%/}"
        export BINDGEN_EXTRA_CLANG_ARGS="${BINDGEN_EXTRA_CLANG_ARGS:-} -resource-dir=$CLANG_RESOURCE_DIR"
        echo "Pointing bindgen at clang resource dir: $CLANG_RESOURCE_DIR"
    fi
fi

# Check for build deps (on Bazzite: sudo ostree admin unlock --hotfix && sudo rpm -ivh ...)
MISSING_DEPS=()
[ ! -f /usr/lib64/libiio.so ] && MISSING_DEPS+=("libiio-devel")
[ ! -f /usr/lib64/libudev.so ] && MISSING_DEPS+=("systemd-devel")
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo "ERROR: Missing build deps: ${MISSING_DEPS[*]}"
    echo "On Bazzite:"
    echo "  sudo ostree admin unlock --hotfix"
    echo "  sudo rpm -ivh --nodeps \$(dnf download --url ${MISSING_DEPS[*]} 2>/dev/null | grep x86_64)"
    exit 1
fi

# Clone or update
if [ -d "$IP_DIR/.git" ]; then
    echo "InputPlumber repo exists, updating to origin/$IP_BRANCH..."
    cd "$IP_DIR"
    git fetch origin --prune
    # Hard-switch to main even if the working tree was on a stale
    # PR branch from a previous build. -B creates the branch if absent.
    git checkout -B "$IP_BRANCH" "origin/$IP_BRANCH"
    git reset --hard "origin/$IP_BRANCH"
else
    echo "Cloning InputPlumber..."
    mkdir -p "$(dirname "$IP_DIR")"
    git clone --branch "$IP_BRANCH" https://github.com/ShadowBlip/InputPlumber.git "$IP_DIR"
    cd "$IP_DIR"
fi

echo "Building (release)..."
cargo build --release

BINARY="$IP_DIR/target/release/inputplumber"
if [ ! -f "$BINARY" ]; then
    echo "ERROR: Build failed — no binary produced"
    exit 1
fi

echo "=== Build complete ==="
echo "  Binary: $BINARY"
echo "  Size:   $(du -h "$BINARY" | cut -f1)"
echo
echo "To install system-wide:"
echo "  sudo cp $BINARY /usr/bin/inputplumber"
echo "  sudo cp $IP_DIR/rootfs/usr/lib/systemd/system/inputplumber.service /etc/systemd/system/"
echo "  sudo cp -r $IP_DIR/rootfs/usr/share/inputplumber/ /usr/share/inputplumber/"
