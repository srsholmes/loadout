#!/bin/bash
# install.sh — Install the TDP helper script and polkit policy
#
# Installs:
#   1. Helper script to ~/.local/share/loadout/helpers/
#   2. Polkit policy to /usr/share/polkit-1/actions/ (requires sudo)
#
# The polkit policy is patched at install time to reference the actual
# helper path, so pkexec knows which binary is authorized.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Helper script ---
HELPER_DIR="${HOME}/.local/share/loadout/helpers"
HELPER_DEST="${HELPER_DIR}/loadout-tdp-helper.sh"

# Audit A-031: $HELPER_DEST flows into the polkit policy via `sed
# "s|HELPER_PATH|${HELPER_DEST}|g"` below. If $HOME ever contained a `|`
# (sed's chosen delimiter) the policy would silently land with a broken
# <annotate key="org.freedesktop.policykit.exec.path"> attribute and every
# pkexec call would fail with "Action not registered". Refuse to install
# rather than emit garbage. Restrict to absolute paths under a safe
# charset — colons, pipes, quotes, backslashes, whitespace, etc. all reject.
if [[ ! "$HELPER_DEST" =~ ^/[a-zA-Z0-9._/-]+$ ]]; then
  echo "ERROR: HELPER_DEST ('$HELPER_DEST') is not a safe absolute path." >&2
  echo "       Expected /-prefixed path containing only [A-Za-z0-9._/-]." >&2
  echo "       Refusing to install — sed substitution into the polkit" >&2
  echo "       policy would produce a broken file." >&2
  exit 1
fi

echo "Installing TDP helper script..."
mkdir -p "$HELPER_DIR"
cp "${SCRIPT_DIR}/loadout-tdp-helper.sh" "$HELPER_DEST"
chmod 755 "$HELPER_DEST"
echo "  -> ${HELPER_DEST}"

# --- Polkit policy ---
POLICY_SRC="${SCRIPT_DIR}/com.loadout.tdp.policy"
POLICY_DEST="/usr/share/polkit-1/actions/com.loadout.tdp.policy"

echo "Installing polkit policy (requires sudo)..."

# Patch the helper path into the policy file. $HELPER_DEST is validated
# above (A-031) so the `|`-delimited sed expression stays well-formed.
POLICY_CONTENT=$(sed "s|HELPER_PATH|${HELPER_DEST}|g" "$POLICY_SRC")

echo "$POLICY_CONTENT" | sudo tee "$POLICY_DEST" > /dev/null
echo "  -> ${POLICY_DEST}"

echo ""
echo "TDP helper installed successfully."
echo "You can now use: pkexec ${HELPER_DEST} <microwatts>"
echo "  Example (15W): pkexec ${HELPER_DEST} 15000000"
