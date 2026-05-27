#!/bin/sh
# loadout-tdp-helper.test.sh — Audit A-015.
#
# Validates the argument-parsing, range-check, and glob-walking behavior
# of loadout-tdp-helper.sh without requiring polkit, root, or a
# real /sys/class/hwmon hierarchy. Each test stages a per-case copy of
# the script with HWMON_GLOB rewritten to point at a tempdir, then
# invokes it as a normal user.
#
# Idiom mirrors scripts/check-plugin-specs.sh: track pass/fail counts,
# exit non-zero on any failure.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_SRC="${SCRIPT_DIR}/loadout-tdp-helper.sh"

if [ ! -f "$HELPER_SRC" ]; then
  echo "FATAL: cannot find loadout-tdp-helper.sh at $HELPER_SRC" >&2
  exit 1
fi

pass=0
fail=0
expected_cases=7

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Stage a copy of the helper into a tempdir with HWMON_GLOB rewritten to
# point at $1/power_cap*. Caller writes/removes files under $1 to
# control the glob's behavior.
#
# Echoes the path of the rewritten script.
stage_helper() {
  hwmon_root="$1"
  staged="${hwmon_root}/loadout-tdp-helper.sh"
  # `|` is safe as a sed delimiter here because $hwmon_root comes from
  # mktemp and contains only [A-Za-z0-9/._-].
  sed "s|^HWMON_GLOB=.*|HWMON_GLOB=\"${hwmon_root}/power_cap_*\"|" \
    "$HELPER_SRC" > "$staged"
  chmod 755 "$staged"
  echo "$staged"
}

# record_pass <name>
record_pass() {
  pass=$((pass + 1))
  echo "  PASS  $1"
}

# record_fail <name> <reason>
record_fail() {
  fail=$((fail + 1))
  echo "  FAIL  $1: $2" >&2
}

# ---------------------------------------------------------------------------
# Case 1: zero arguments
# ---------------------------------------------------------------------------
case_zero_args() {
  name="zero arguments -> non-zero exit + usage message"
  tmp="$(mktemp -d)"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0"
    return
  fi
  case "$out" in
    *Usage*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'Usage' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 2: too many arguments
# ---------------------------------------------------------------------------
case_too_many_args() {
  name="argument count > 1 -> non-zero exit"
  tmp="$(mktemp -d)"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 15000000 20000000 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0 (stdout: $out)"
    return
  fi
  record_pass "$name"
}

# ---------------------------------------------------------------------------
# Case 3: non-integer argument
# ---------------------------------------------------------------------------
case_non_integer() {
  name="non-integer argument 'abc' -> non-zero exit"
  tmp="$(mktemp -d)"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" abc 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0"
    return
  fi
  case "$out" in
    *ERROR*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'ERROR' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 4: below minimum (3W = 3000000uW)
# ---------------------------------------------------------------------------
case_below_min() {
  name="value below MIN_MICROWATTS (2999999) -> non-zero exit"
  tmp="$(mktemp -d)"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 2999999 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0"
    return
  fi
  case "$out" in
    *out\ of\ range*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'out of range' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 5: above maximum (30W = 30000000uW)
# ---------------------------------------------------------------------------
case_above_max() {
  name="value above MAX_MICROWATTS (30000001) -> non-zero exit"
  tmp="$(mktemp -d)"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 30000001 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0"
    return
  fi
  case "$out" in
    *out\ of\ range*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'out of range' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 6: valid mid-range value writes to the (mocked) cap file
# ---------------------------------------------------------------------------
case_valid_writes_file() {
  name="valid mid-range value (15000000) writes mocked power_cap file"
  tmp="$(mktemp -d)"
  cap_file="${tmp}/power_cap_0"
  : > "$cap_file"
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 15000000 2>&1)" || rc=$?
  contents="$(cat "$cap_file")"
  rm -rf "$tmp"
  if [ "$rc" -ne 0 ]; then
    record_fail "$name" "expected exit 0, got $rc (stderr+stdout: $out)"
    return
  fi
  if [ "$contents" != "15000000" ]; then
    record_fail "$name" "expected '15000000' in cap file, got: '$contents'"
    return
  fi
  record_pass "$name"
}

# ---------------------------------------------------------------------------
# Case 7: no matching glob entries -> non-zero with hwmon-mentioning error
# ---------------------------------------------------------------------------
case_no_glob_match() {
  name="no power_cap files in HWMON_GLOB -> non-zero exit + hwmon error"
  tmp="$(mktemp -d)"
  # NB: don't create any power_cap_* files.
  helper="$(stage_helper "$tmp")"
  rc=0
  out="$("$helper" 15000000 2>&1)" || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0"
    return
  fi
  case "$out" in
    *hwmon*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'hwmon' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "running loadout-tdp-helper.test.sh"

case_zero_args
case_too_many_args
case_non_integer
case_below_min
case_above_max
case_valid_writes_file
case_no_glob_match

total=$((pass + fail))
echo ""
echo "  pass=$pass fail=$fail (expected_cases=$expected_cases)"

if [ "$total" -ne "$expected_cases" ]; then
  echo "  FATAL: ran $total case(s); expected $expected_cases" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "  OK — all $pass case(s) passed."
