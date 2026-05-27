#!/usr/bin/env bash
# Combined coverage runner — runs Vitest (UI) and Bun (backend) coverage,
# then prints a one-line % lines-covered summary per layer.
#
# Used both locally (`bun run test:coverage`) and in CI. The audit's
# follow-up step is to ratchet a threshold against the measured baseline.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p coverage/ui coverage/backend

ui_summary="(no data)"
backend_summary="(no data)"

# Extract "lines covered %" from an lcov.info file.
# Returns "<percent>% (<hit>/<total> lines)" or "(no data)" if empty.
lcov_pct() {
  local file="$1"
  if [ ! -s "$file" ]; then
    echo "(no data)"
    return
  fi
  awk '
    /^DA:/ {
      split($0, a, ":"); split(a[2], b, ",");
      total++;
      if (b[2] != "0") hit++;
    }
    END {
      if (total == 0) { print "(no data)"; exit }
      printf "%.2f%% (%d/%d lines)\n", (hit / total) * 100, hit, total;
    }
  ' "$file"
}

# UI layer (Vitest + v8)
echo "=== UI coverage (Vitest v8) ==="
if bun run test:ui:coverage; then
  ui_summary="$(lcov_pct coverage/ui/lcov.info)"
else
  ui_summary="FAILED"
fi

# Backend layer (Bun). xargs invokes bun test once per file; each call
# overwrites coverage/backend/lcov.info, so we accumulate by appending.
echo
echo "=== Backend coverage (Bun) ==="
rm -f coverage/backend/lcov.info coverage/backend/lcov.combined.info
combined="coverage/backend/lcov.combined.info"

# Collect all backend spec files, then loop so we can append each run's
# lcov output instead of letting xargs clobber it. Delegate the find
# expression to scripts/test-backend.sh --list so we don't drift from
# the package.json `test:backend` script's notion of "backend spec"
# (audit 2026-05 Q-013 consolidation — single source of truth).
mapfile -d '' -t SPECS < <(sh "$ROOT_DIR/scripts/test-backend.sh" --list)

backend_ok=1
for spec in "${SPECS[@]}"; do
  if bun test --coverage --coverage-reporter=text --coverage-reporter=lcov \
       --coverage-dir=coverage/backend "$spec"; then
    if [ -f coverage/backend/lcov.info ]; then
      cat coverage/backend/lcov.info >> "$combined"
    fi
  else
    backend_ok=0
  fi
done

if [ "$backend_ok" = 1 ] && [ -s "$combined" ]; then
  mv "$combined" coverage/backend/lcov.info
  backend_summary="$(lcov_pct coverage/backend/lcov.info)"
elif [ "$backend_ok" = 0 ]; then
  backend_summary="FAILED"
fi

echo
echo "=================================================="
echo " Coverage baseline"
echo "=================================================="
printf "  UI       (Vitest v8) : %s\n" "$ui_summary"
printf "  Backend  (Bun)       : %s\n" "$backend_summary"
echo "=================================================="

# Audit 2026-05 Q-005 follow-up — ratchet against baseline.
# UI thresholds are enforced inline by Vitest via `coverage.thresholds`
# in vitest.config.ts (already failed `test:ui:coverage` above if it
# regressed). Backend uses the custom parser since Bun has no built-in
# threshold flag. Floors are 1pp below the values measured when the
# ratchet landed.
BACKEND_FLOOR="${BACKEND_COVERAGE_FLOOR:-29.3}"
if [ "$backend_summary" = "FAILED" ] || [ "$backend_summary" = "(no data)" ]; then
  echo "Skipping backend ratchet — coverage didn't produce output." >&2
elif [ -s coverage/backend/lcov.info ]; then
  if ! bash "$ROOT_DIR/scripts/coverage-ratchet.sh" coverage/backend/lcov.info "$BACKEND_FLOOR"; then
    echo "Backend coverage regressed below $BACKEND_FLOOR% floor." >&2
    exit 1
  fi
fi

# Re-throw any spec-level UI failure so CI sees it. We intentionally
# don't fast-exit earlier — the backend ratchet is the more informative
# signal when only one layer regresses.
if [ "$ui_summary" = "FAILED" ]; then
  exit 1
fi
