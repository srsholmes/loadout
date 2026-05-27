#!/bin/sh
# Audit Q-011 + Q-012 (2026-05): require a sibling spec for every
# non-trivial plugin entry point and the shared library modules
# plugins use.
#
# Rules:
#   plugins/*/backend.ts        ≥ MIN_LOC  must have  plugins/*/backend.spec.ts
#   plugins/*/app.tsx           ≥ MIN_LOC  must have  plugins/*/app.spec.tsx
#   plugins/*/lib/**/*.ts       ≥ MIN_LOC  must have  sibling *.spec.ts
#   packages/*/src/*.ts         ≥ MIN_LOC  must have  sibling *.spec.ts
#
# The LOC floor exists so trivial passthroughs (empty default exports,
# pure-decorative HUD widgets, barrel re-exports) don't force a spec
# for the sake of one. Raise it deliberately if a class of module
# should be exempt — don't special-case individual paths.
#
# Exit non-zero if any required spec is missing.

set -eu

MIN_LOC=100

# `EXEMPT_APPS` lists app.tsx paths that are non-trivial in LOC but
# don't have a meaningful UI surface to spec (e.g. they only render a
# settings card driven entirely by backend RPC + the plugin author has
# decided the integration test isn't worth its weight). Empty by
# default — add entries with a short justification comment.
EXEMPT_APPS=""

missing=0

for backend in plugins/*/backend.ts; do
  [ -f "$backend" ] || continue
  loc=$(wc -l < "$backend")
  if [ "$loc" -lt "$MIN_LOC" ]; then continue; fi
  dir=$(dirname "$backend")
  spec="$dir/backend.spec.ts"
  if [ ! -f "$spec" ]; then
    echo "MISSING SPEC: $backend ($loc LOC ≥ $MIN_LOC) — add $spec" >&2
    missing=$((missing + 1))
  fi
done

for app in plugins/*/app.tsx; do
  [ -f "$app" ] || continue
  loc=$(wc -l < "$app")
  if [ "$loc" -lt "$MIN_LOC" ]; then continue; fi

  # Skip explicitly-exempt apps.
  skip=0
  for exempt in $EXEMPT_APPS; do
    if [ "$app" = "$exempt" ]; then skip=1; break; fi
  done
  [ "$skip" -eq 1 ] && continue

  dir=$(dirname "$app")
  spec="$dir/app.spec.tsx"
  if [ ! -f "$spec" ]; then
    echo "MISSING SPEC: $app ($loc LOC ≥ $MIN_LOC) — add $spec" >&2
    missing=$((missing + 1))
  fi
done

# Plugin lib/ modules — every .ts file under SPEC_SCOPED_LIB_DIRS
# that isn't already a spec/types file gets the same spec
# requirement. Listed explicitly so the rule can be ratcheted in
# one plugin at a time without retroactively breaking older code
# that was written before the rule existed.
# Helper: type-only module = nothing but `export type` / `export
# interface` declarations. Those have no runtime to spec.
is_type_only_module() {
  # Reject if the file has any non-type runtime export. Catches:
  #   - export [async|abstract|default] function|class|const|let|var
  #   - export default (anything that isn't `type|interface`)
  #   - export enum (runtime, not type-only — TS enums emit JS)
  #   - export { x } from … (re-export of values)
  #   - export * from … (barrel re-export)
  if grep -Eq '^export[[:space:]]+(async[[:space:]]+|abstract[[:space:]]+|default[[:space:]]+(async[[:space:]]+|abstract[[:space:]]+)?)?(function|class|const|let|var|enum|default)' "$1"; then
    return 1
  fi
  if grep -Eq '^export[[:space:]]*[{*]' "$1"; then
    return 1
  fi
  return 0
}

# Lib modules with an explicit reason to not carry a direct spec.
# Each entry needs a one-line justification immediately above. Keep
# the list short — direct unit tests are cheaper than indirect.
# Empty: the plugins that needed exemptions (recomp) are not part of
# the minimal PoC; re-add entries when those plugins are migrated back.
EXEMPT_LIB=""

# Empty: store-bridge/recomp are not part of the minimal PoC. Re-scope
# when those plugins are migrated back.
SPEC_SCOPED_LIB_DIRS=""
for dir in $SPEC_SCOPED_LIB_DIRS; do
  [ -d "$dir" ] || continue
  for lib in $(find "$dir" -type f -name '*.ts' 2>/dev/null); do
    case "$lib" in
      *.spec.ts) continue ;;
      */types.ts) continue ;;
    esac
    # Skip explicitly-exempt entries.
    skip=0
    for exempt in $EXEMPT_LIB; do
      if [ "$lib" = "$exempt" ]; then skip=1; break; fi
    done
    [ "$skip" -eq 1 ] && continue
    [ -f "$lib" ] || continue
    if is_type_only_module "$lib"; then continue; fi
    loc=$(wc -l < "$lib")
    if [ "$loc" -lt "$MIN_LOC" ]; then continue; fi
    base="${lib%.ts}"
    spec="$base.spec.ts"
    if [ ! -f "$spec" ]; then
      echo "MISSING SPEC: $lib ($loc LOC ≥ $MIN_LOC) — add $spec" >&2
      missing=$((missing + 1))
    fi
  done
done

# Shared workspace packages — same rule, scoped to a list of
# package src/ trees the ratchet has been applied to.
# Empty: sgdb-art/steam-shortcut/file-picker are removed from the minimal
# PoC. Re-scope when those packages return with their plugins.
SPEC_SCOPED_PACKAGES=""
for dir in $SPEC_SCOPED_PACKAGES; do
  [ -d "$dir" ] || continue
  for src in $(find "$dir" -type f -name '*.ts' 2>/dev/null); do
    case "$src" in
      *.spec.ts) continue ;;
      */types.ts) continue ;;
    esac
    [ -f "$src" ] || continue
    if is_type_only_module "$src"; then continue; fi
    loc=$(wc -l < "$src")
    if [ "$loc" -lt "$MIN_LOC" ]; then continue; fi
    base="${src%.ts}"
    spec="$base.spec.ts"
    if [ ! -f "$spec" ]; then
      echo "MISSING SPEC: $src ($loc LOC ≥ $MIN_LOC) — add $spec" >&2
      missing=$((missing + 1))
    fi
  done
done

if [ "$missing" -gt 0 ]; then
  echo "" >&2
  echo "$missing plugin entry point(s) lack a sibling spec." >&2
  echo "Either add a spec (see plugins/network-info/ for a backend example," >&2
  echo "plugins/network-info/app.spec.tsx for an app example) or, if the" >&2
  echo "plugin's UI genuinely has no testable surface, add it to" >&2
  echo "EXEMPT_APPS in scripts/check-plugin-specs.sh with a justification." >&2
  exit 1
fi

echo "OK — every plugin entry point ≥ $MIN_LOC LOC has a sibling spec."
