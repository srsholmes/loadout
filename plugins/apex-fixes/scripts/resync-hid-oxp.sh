#!/bin/bash
# Refresh kernel-patches/hid-oxp/build/hid-oxp.c from pastaq's upstream tree
# and rebuild .ko against the running kernel.
#
# Pastaq's branch is the source of truth for the hid-oxp driver — it's what
# will eventually land in the OGC and Valve kernels. Our copy diverges only
# in one spot: pastaq's tree uses `#include "hid-ids.h"` (in-tree header),
# but we build out-of-tree, so we inline the four USB device ID defines
# instead. That single rewrite is applied by this script.
#
# Usage:
#   ./scripts/resync-hid-oxp.sh         # fetch + adapt + rebuild
#   ./scripts/resync-hid-oxp.sh --no-build   # fetch + adapt only
#
# After running: commit the updated build/hid-oxp.c and the rebuilt
# kernel-patches/hid-oxp/<kernel>/hid-oxp.ko. The migration script will
# install the new .ko to /var/lib/hid-oxp/ on next run; reboot to load it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_DIR/kernel-patches/hid-oxp/build"
SRC_URL="https://raw.githubusercontent.com/pastaq/linux/pastaq/7.1/hid/hid-oxp/drivers/hid/hid-oxp.c"

DO_BUILD=1
for arg in "$@"; do
    case "$arg" in
        --no-build) DO_BUILD=0 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

echo "Fetching latest hid-oxp.c from pastaq's tree..."
TMPF="$(mktemp)"
trap 'rm -f "$TMPF"' EXIT
curl -fsSL "$SRC_URL" -o "$TMPF"

if ! grep -q '#include "hid-ids.h"' "$TMPF"; then
    echo "WARNING: upstream no longer uses hid-ids.h — adaptation may be unnecessary."
    echo "         Diff upstream against $BUILD_DIR/hid-oxp.c manually."
fi

# Out-of-tree adaptation: replace hid-ids.h include with inline defines.
# Bazzite / Fedora kernel-devel packages don't ship drivers/hid/hid-ids.h.
sed -i 's|#include "hid-ids.h"|/* Standalone out-of-tree build: inline the device IDs from hid-ids.h */\
#define USB_VENDOR_ID_CRSC\t\t\t0x1a2c\
#define USB_DEVICE_ID_ONEXPLAYER_GEN1\t\t0xb001\
#define USB_VENDOR_ID_WCH\t\t\t0x1a86\
#define USB_DEVICE_ID_ONEXPLAYER_GEN2\t\t0xfe00|' "$TMPF"

cp "$TMPF" "$BUILD_DIR/hid-oxp.c"
echo "Updated $BUILD_DIR/hid-oxp.c"

if [ "$DO_BUILD" = "1" ]; then
    echo "Rebuilding for kernel $(uname -r)..."
    bash "$SCRIPT_DIR/build-hid-oxp.sh"
fi

echo
echo "Done. Next steps:"
echo "  1. git add kernel-patches/hid-oxp/build/hid-oxp.c kernel-patches/hid-oxp/$(uname -r)/hid-oxp.ko"
echo "  2. sudo ./scripts/migrate-to-inputplumber.sh   # installs the new .ko to /var/lib/hid-oxp/"
echo "  3. sudo systemctl reboot                        # loads the new module"
