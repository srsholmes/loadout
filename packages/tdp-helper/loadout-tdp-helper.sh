#!/bin/bash
# loadout-tdp-helper.sh — Polkit-authorized TDP writer
#
# This script is called via pkexec to write TDP values to sysfs.
# It is intentionally minimal: hardcoded path, strict validation.
#
# Usage: loadout-tdp-helper.sh <microwatts>
#
# SECURITY:
#   - Only writes to /sys/class/hwmon/*/power*_cap (hardcoded glob)
#   - Validates input is an integer in range 3000000-30000000 (3-30W)
#   - No user-controlled paths — prevents path injection
#   - Called via pkexec with a polkit policy for authorization

set -euo pipefail

# --- Constants ---
MIN_MICROWATTS=3000000   # 3W
MAX_MICROWATTS=30000000  # 30W
HWMON_GLOB="/sys/class/hwmon/hwmon*/power*_cap"

# --- Argument validation ---
if [ $# -ne 1 ]; then
    echo "Usage: loadout-tdp-helper.sh <microwatts>" >&2
    echo "  microwatts: integer value between ${MIN_MICROWATTS} and ${MAX_MICROWATTS}" >&2
    exit 1
fi

VALUE="$1"

# Must be a pure integer (no decimals, no letters, no empty string)
if ! [[ "$VALUE" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Value must be a positive integer, got: ${VALUE}" >&2
    exit 1
fi

# Range check
if [ "$VALUE" -lt "$MIN_MICROWATTS" ] || [ "$VALUE" -gt "$MAX_MICROWATTS" ]; then
    echo "ERROR: Value ${VALUE} out of range (${MIN_MICROWATTS}-${MAX_MICROWATTS})" >&2
    exit 1
fi

# --- Find and write to all power cap files ---
FOUND=0
for cap_file in $HWMON_GLOB; do
    # Skip if glob didn't match (literal string with asterisks)
    [ -e "$cap_file" ] || continue

    echo "$VALUE" > "$cap_file" 2>/dev/null && {
        FOUND=$((FOUND + 1))
        echo "OK: Set ${cap_file} to ${VALUE}"
    } || {
        echo "WARN: Failed to write to ${cap_file}" >&2
    }
done

if [ "$FOUND" -eq 0 ]; then
    echo "ERROR: No writable power_cap files found in /sys/class/hwmon/" >&2
    exit 1
fi

echo "OK: Set TDP to ${VALUE} microwatts (${FOUND} file(s) updated)"
