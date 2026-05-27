#!/bin/sh
# install.test.sh — Audit A-015.
#
# Exercises the HELPER_DEST validation block added in A-031. We don't
# want to actually install anything, so each test:
#
#   1. Stages the install.sh script + sibling helper + policy file
#      into a per-case tempdir.
#   2. Overrides $HOME (which is what install.sh derives HELPER_DEST
#      from) to control whether HELPER_DEST passes the regex guard.
#   3. Prepends a PATH stub that mocks `sudo` so the post-validation
#      `sudo tee` doesn't actually require root if it ever runs.
#
# Cases (5):
#   - HOME containing `|` -> validation rejects
#   - HOME containing a space -> validation rejects
#   - HOME relative (./foo) -> validation rejects (HELPER_DEST won't
#     start with `/`)
#   - HOME containing `..` -> validation rejects (`..` is not in the
#     allowed [A-Za-z0-9._/-]+ set... actually `.` and `-` are. But
#     the dot-dot path component is still legal under the regex.
#     The audit guard isn't a path-traversal check — it's a sed-safety
#     check. We assert the regex actually allows `..` to pass through
#     so that the test documents the guard's actual scope.)
#   - HOME valid (/tmp/...) -> validation passes, script proceeds.
#
# Idiom mirrors scripts/check-plugin-specs.sh + tdp-helper.test.sh.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SRC="${SCRIPT_DIR}/install.sh"
HELPER_SRC="${SCRIPT_DIR}/loadout-tdp-helper.sh"
POLICY_SRC="${SCRIPT_DIR}/com.loadout.tdp.policy"

for f in "$INSTALL_SRC" "$HELPER_SRC" "$POLICY_SRC"; do
  if [ ! -f "$f" ]; then
    echo "FATAL: missing required file $f" >&2
    exit 1
  fi
done

pass=0
fail=0
expected_cases=5

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Stage install.sh + sibling files into a fresh tempdir. Echoes the
# directory path (caller cleans up).
stage_install_dir() {
  d="$(mktemp -d)"
  cp "$INSTALL_SRC"  "$d/install.sh"
  cp "$HELPER_SRC"   "$d/loadout-tdp-helper.sh"
  cp "$POLICY_SRC"   "$d/com.loadout.tdp.policy"
  chmod 755 "$d/install.sh"
  echo "$d"
}

# Stage a PATH directory with a fake `sudo` that just `tee`s to
# /dev/null (so the post-validation polkit install path is a no-op
# even if validation passes).
stage_sudo_stub() {
  d="$(mktemp -d)"
  cat > "$d/sudo" <<'EOF'
#!/bin/sh
# Fake sudo for install.test.sh — drop the privilege flag and forward
# the rest to the underlying binary, but with our test-only behavior:
# if invoked as `sudo tee <path>`, drain stdin to /dev/null rather than
# write anywhere on the real filesystem.
if [ "$1" = "tee" ]; then
  shift
  # Don't actually write to /usr/share/polkit-1/... — just consume stdin.
  cat > /dev/null
  exit 0
fi
exec "$@"
EOF
  chmod 755 "$d/sudo"
  echo "$d"
}

record_pass() { pass=$((pass + 1)); echo "  PASS  $1"; }
record_fail() { fail=$((fail + 1)); echo "  FAIL  $1: $2" >&2; }

# run_install <HOME> -> sets rc + out
# Stages a per-case workdir, runs install.sh with $HOME overridden and
# a stubbed sudo on PATH. Cleans up after.
run_install() {
  _home="$1"
  _dir="$(stage_install_dir)"
  _sudo="$(stage_sudo_stub)"
  rc=0
  out="$(HOME="$_home" PATH="$_sudo:$PATH" bash "$_dir/install.sh" 2>&1)" || rc=$?
  rm -rf "$_dir" "$_sudo"
}

# ---------------------------------------------------------------------------
# Case 1: HOME containing `|` (the sed delimiter) -> validation rejects
# ---------------------------------------------------------------------------
case_home_with_pipe() {
  name="HOME containing '|' -> install.sh exits non-zero before sudo"
  bad="$(mktemp -d)/a|b"
  mkdir -p "$bad"
  run_install "$bad"
  rm -rf "$(dirname "$bad")"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0 (output: $out)"
    return
  fi
  case "$out" in
    *ERROR*HELPER_DEST*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'ERROR: HELPER_DEST' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 2: HOME containing a space -> validation rejects
# ---------------------------------------------------------------------------
case_home_with_space() {
  name="HOME containing space -> install.sh exits non-zero before sudo"
  parent="$(mktemp -d)"
  bad="${parent}/with space"
  mkdir -p "$bad"
  run_install "$bad"
  rm -rf "$parent"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0 (output: $out)"
    return
  fi
  case "$out" in
    *ERROR*HELPER_DEST*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'ERROR: HELPER_DEST' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 3: HOME relative -> validation rejects (no leading slash)
# ---------------------------------------------------------------------------
case_home_relative() {
  name="HOME relative './foo' -> install.sh exits non-zero before sudo"
  run_install "./foo"
  if [ "$rc" -eq 0 ]; then
    record_fail "$name" "expected non-zero exit, got 0 (output: $out)"
    return
  fi
  case "$out" in
    *ERROR*HELPER_DEST*) record_pass "$name" ;;
    *) record_fail "$name" "expected 'ERROR: HELPER_DEST' in stderr, got: $out" ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 4: HOME containing '..' -> the A-031 regex actually permits this
# (it's a sed-safety guard, not a path-traversal guard). Document the
# behavior with an assertion so future tightening is intentional.
# ---------------------------------------------------------------------------
case_home_with_dotdot() {
  name="HOME containing '..' -> sed-safety guard permits it (documents scope)"
  parent="$(mktemp -d)"
  # /tmp/.../a/../b — `..` is in the path string but it's still safe
  # for sed because `..` is in [A-Za-z0-9._/-].
  mkdir -p "$parent/a" "$parent/b"
  bad="$parent/a/../b"
  run_install "$bad"
  rm -rf "$parent"
  # We expect the script to reach the install branch (validation passes
  # because `..` chars are in the allowed set) and then either succeed
  # (rc=0) or fail somewhere after the guard for unrelated reasons. The
  # important assertion: stderr does NOT contain the A-031 guard message.
  case "$out" in
    *"is not a safe absolute path"*)
      record_fail "$name" "A-031 guard rejected '..' — guard is now stricter than documented; update the test or the comment in install.sh"
      ;;
    *)
      record_pass "$name"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Case 5: HOME valid -> validation passes, install proceeds past the
# guard. Assert exit 0 and that the staged helper landed at the
# computed HELPER_DEST.
# ---------------------------------------------------------------------------
case_home_valid() {
  name="HOME valid '/tmp/...' -> install.sh proceeds past A-031 guard"
  good="$(mktemp -d)"
  run_install "$good"
  expected_dest="${good}/.local/share/loadout/helpers/loadout-tdp-helper.sh"
  if [ ! -f "$expected_dest" ]; then
    rm -rf "$good"
    record_fail "$name" "expected helper at $expected_dest after install; output: $out"
    return
  fi
  rm -rf "$good"
  if [ "$rc" -ne 0 ]; then
    record_fail "$name" "expected exit 0, got $rc (output: $out)"
    return
  fi
  case "$out" in
    *"is not a safe absolute path"*)
      record_fail "$name" "A-031 guard wrongly rejected valid path"
      ;;
    *)
      record_pass "$name"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "running install.test.sh"

case_home_with_pipe
case_home_with_space
case_home_relative
case_home_with_dotdot
case_home_valid

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
