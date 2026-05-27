#!/bin/sh
# Loadout TDP Helper
# Called via pkexec to write TDP values to sysfs.
# Only writes to /sys/class/hwmon/*/power*_cap paths.
# Validates input is a number within safe bounds.

set -e

VALUE="$1"

# Validate: must be a number
case "$VALUE" in
  ''|*[!0-9]*) echo "ERROR: Value must be a positive integer (microwatts)" >&2; exit 1 ;;
esac

# Validate: 3W-30W in microwatts (3000000-30000000)
if [ "$VALUE" -lt 3000000 ] || [ "$VALUE" -gt 30000000 ]; then
  echo "ERROR: Value out of range (3000000-30000000 microwatts)" >&2
  exit 1
fi

# Find the hwmon path — HARDCODED pattern, no user input in path
HWMON_PATH=""
for p in /sys/class/hwmon/hwmon*/power1_cap; do
  if [ -w "$p" ] || [ -e "$p" ]; then
    HWMON_PATH="$p"
    break
  fi
done

if [ -z "$HWMON_PATH" ]; then
  echo "ERROR: No writable power1_cap found in /sys/class/hwmon/" >&2
  exit 1
fi

# Write the value
echo "$VALUE" > "$HWMON_PATH"

# Also write to power2_cap if it exists (some devices have separate fast/slow limits)
HWMON_DIR=$(dirname "$HWMON_PATH")
if [ -e "$HWMON_DIR/power2_cap" ]; then
  echo "$VALUE" > "$HWMON_DIR/power2_cap"
fi

echo "OK: Set TDP to $VALUE microwatts via $HWMON_PATH"
