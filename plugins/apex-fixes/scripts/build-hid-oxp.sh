#!/bin/bash
# Build hid-oxp.ko for the running kernel.
#
# Usage:
#   ./scripts/build-hid-oxp.sh
#
# Output: kernel-patches/hid-oxp/build/hid-oxp.ko
#         (also copied to kernel-patches/hid-oxp/<kernel>/hid-oxp.ko)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_DIR/kernel-patches/hid-oxp/build"
KERNEL="$(uname -r)"
KDIR="/lib/modules/$KERNEL/build"
OUTPUT_DIR="$REPO_DIR/kernel-patches/hid-oxp/$KERNEL"

echo "=== Building hid-oxp.ko for kernel $KERNEL ==="

# Check kernel headers
if [ ! -d "$KDIR" ]; then
    echo "ERROR: Kernel headers not found at $KDIR"
    echo "Install with: sudo dnf install kernel-devel-$KERNEL"
    exit 1
fi

if [ ! -f "$BUILD_DIR/hid-oxp.c" ]; then
    echo "ERROR: Source not found at $BUILD_DIR/hid-oxp.c"
    exit 1
fi

# Build
echo "Building in $BUILD_DIR..."
make -C "$KDIR" M="$BUILD_DIR" modules

if [ ! -f "$BUILD_DIR/hid-oxp.ko" ]; then
    echo "ERROR: Build produced no hid-oxp.ko"
    exit 1
fi

# Copy to kernel-versioned dir
mkdir -p "$OUTPUT_DIR"
cp "$BUILD_DIR/hid-oxp.ko" "$OUTPUT_DIR/hid-oxp.ko"

echo "=== Build complete ==="
echo "  Module: $BUILD_DIR/hid-oxp.ko"
echo "  Copied: $OUTPUT_DIR/hid-oxp.ko"
echo "  Size:   $(du -h "$OUTPUT_DIR/hid-oxp.ko" | cut -f1)"
