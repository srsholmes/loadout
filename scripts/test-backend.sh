#!/bin/sh
# Backend test runner — finds every backend spec under packages/ and
# plugins/ and runs each through `bun test` in its own process.
#
# Why per-file? `bun test` in Bun 1.3.x shares module state across files
# within a single invocation, so any plugin that monkey-patches global
# state in its spec (e.g. mocking @loadout/exec) bleeds into the
# next file's run. Forking one process per spec gives each test a clean
# slate at the cost of ~200ms startup overhead per file.
#
# Extracted from the inline `test:backend` package.json script as part
# of audit 2026-05 Q-013 — the pipeline grew too thorny to maintain on
# one line, and future work (per-plugin mock-isolation, --bail, parallel
# execution, opt-in coverage) needs a real shell file.
#
# Exclusions match the historic behavior of the inline pipeline:
#   - *.integration.spec.ts   live-machine / network specs
#   - *.e2e.*                 Playwright + browser specs
#   - */e2e/*                 nested e2e suites
#   - *.claude*               sandbox / scratch fixtures
#
# Modes:
#   sh scripts/test-backend.sh                 # run all backend specs
#   sh scripts/test-backend.sh --coverage ...  # forward args to `bun test`
#   sh scripts/test-backend.sh --list          # print NUL-separated spec
#                                              # paths; used by
#                                              # scripts/test-coverage.sh
#                                              # so there is one source
#                                              # of truth for "what
#                                              # counts as a backend
#                                              # spec".
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Single source of truth for the spec-discovery globs. Anything that
# needs the same list (e.g. test-coverage.sh) should invoke this script
# with --list instead of duplicating the find expression.
list_specs() {
  find packages plugins \
    -name '*.spec.ts' \
    ! -name '*.integration.spec.ts' \
    ! -path '*.e2e.*' \
    ! -path '*/e2e/*' \
    ! -path '*.claude*' \
    -print0
}

if [ "${1:-}" = "--list" ]; then
  list_specs
  exit 0
fi

# -print0 + xargs -0 -n1 preserves the original semantics: one `bun test`
# per spec file. Filenames with spaces would survive, though none exist
# in the repo today.
list_specs | xargs -0 -n1 bun test "$@"
