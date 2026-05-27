#!/usr/bin/env bash
# Backend coverage ratchet — parses coverage/backend/lcov.info and asserts
# the lines-covered % is at or above the floor.
#
# Why a custom script? Bun's coverage flags emit lcov but don't enforce
# a threshold — there's no `--coverage-threshold` flag. Vitest has built-in
# thresholds (see vitest.config.ts `test.coverage.thresholds`); this is
# the matching gate for the Bun half of the suite.
#
# Audit 2026-05 Q-005 follow-up: the backend baseline was 30.30% lines
# (11682 / 38550) on commit 1a084ab. We set the floor 1pp below that so
# trivial drift doesn't fail CI but any real regression does.
#
# Parsing approach:
#   - lcov DA: lines have the form `DA:<line>,<hit>` (hit=0 means uncovered).
#   - SF: lines name the source file the following DA records apply to.
#   - Backend lcov is an APPEND of per-spec runs, so the same file/line
#     may appear in multiple SF blocks. We dedup by (file, line): a line
#     counts as covered if ANY block shows hit>0. This matches the
#     semantics of "is this line tested by the suite as a whole?" rather
#     than "is it tested by every spec".
#
# Usage:
#   bash scripts/coverage-ratchet.sh <lcov-file> <floor-percent>
#
# Example:
#   bash scripts/coverage-ratchet.sh coverage/backend/lcov.info 29.3
set -euo pipefail

LCOV_FILE="${1:-coverage/backend/lcov.info}"
FLOOR="${2:-29.3}"

if [ ! -s "$LCOV_FILE" ]; then
  echo "coverage-ratchet: lcov file '$LCOV_FILE' missing or empty" >&2
  exit 2
fi

read -r PCT HIT TOTAL <<<"$(awk '
  /^SF:/ {
    sf = substr($0, 4);
    next;
  }
  /^DA:/ {
    s = substr($0, 4);
    n = split(s, a, ",");
    if (n < 2) next;
    key = sf "|" a[1];
    # First time we see this (file, line): record covered state.
    # Subsequent times: only flip miss → hit, never hit → miss.
    if (!(key in seen)) {
      seen[key] = (a[2] != "0") ? 1 : 0;
    } else if (a[2] != "0") {
      seen[key] = 1;
    }
  }
  END {
    total = 0; hit = 0;
    for (k in seen) {
      total++;
      if (seen[k] == 1) hit++;
    }
    if (total == 0) { print "0.00 0 0"; exit }
    printf "%.2f %d %d\n", (hit / total) * 100, hit, total;
  }
' "$LCOV_FILE")"

echo "Backend coverage: ${PCT}% (${HIT}/${TOTAL} lines)"
echo "Floor          : ${FLOOR}%"

# Use awk for floating-point comparison (POSIX sh has no float math).
if awk -v p="$PCT" -v f="$FLOOR" 'BEGIN { exit (p + 0 >= f + 0) ? 0 : 1 }'; then
  echo "PASS — backend coverage at or above floor."
else
  echo "FAIL — backend coverage below floor. Add tests or investigate the regression." >&2
  exit 1
fi
