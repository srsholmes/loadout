#!/usr/bin/env bash
# spike-ambient-atoms.sh — on-device spike for the ambient (click-through)
# overlay mode. Answers the one open question gating the feature: can the
# Loadout overlay window composite ABOVE the running game while gamescope
# keeps routing ALL input to the game?
#
# Two candidate atom arrangements, tried in preference order:
#
#   Arrangement 1 — GAMESCOPE_EXTERNAL_OVERLAY=1 (the mangoapp slot).
#     Click-through by construction IF this gamescope build registers the
#     atom. Known risk: gamescope tracks a single external-overlay window
#     and Steam's Performance HUD (mangoapp) uses this exact slot.
#
#   Arrangement 2 — STEAM_OVERLAY=1 + STEAM_INPUT_FOCUS=0.
#     Claims Steam's overlay slot for compositing but declines input
#     focus (steamcompmgr consults STEAM_INPUT_FOCUS on the overlay
#     window — see gamescope-atoms.ts). Known risks: the no-focus-window
#     halt when no game is running, and slot contention when Steam opens
#     its own QAM.
#
# Run this ON THE HANDHELD, inside the gamescope session, over SSH from
# another machine (the overlay window must stay untouched by you).
# A GAME MUST BE RUNNING — especially for arrangement 2, where an overlay
# with no focus window halts input device-wide (gamescope-atoms.ts:642).
#
# Usage:
#   ./spike-ambient-atoms.sh status         # dump current atom state
#   ./spike-ambient-atoms.sh try-external   # arrangement 1
#   ./spike-ambient-atoms.sh try-slot      # arrangement 2
#   ./spike-ambient-atoms.sh restore        # back to the hidden baseline
#
# Each try-* maps the (normally minimized) overlay window and sets the
# arrangement's atoms at ~50% opacity so the game stays visible through
# the overlay UI. Then verify by hand and record results in
# docs/ambient-overlay-notes.md. `restore` is best-effort; the clean
# reset is: systemctl --user restart loadout-overlay.

set -euo pipefail

DISPLAY="${DISPLAY:-:0}"
export DISPLAY
WINDOW_NAME="Loadout Overlay"
# 50% alpha — enough to see both the HUD and the game underneath.
OPACITY_HALF=0x7fffffff
OPACITY_HIDDEN=0x00000000

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
info() { printf '%s[*]%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YEL" "$NC" "$*"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"; }
need xdotool
need xprop

find_overlay() {
  # Same lookup gamescope-atoms.ts uses: Electrobun can't set a stable
  # WM_CLASS, so the window is found by title.
  local id
  id="$(xdotool search --name "^${WINDOW_NAME}$" | head -n1 || true)"
  [ -n "$id" ] || die "no window titled '${WINDOW_NAME}' on ${DISPLAY} — is loadout-overlay running?"
  printf '0x%x' "$id"
}

set_atom() { # window atom value
  xprop -id "$1" -f "$2" 32c -set "$2" "$3"
}

show_atoms() { # window
  info "atoms on overlay window $1:"
  xprop -id "$1" \
    _NET_WM_WINDOW_OPACITY STEAM_OVERLAY STEAM_INPUT_FOCUS \
    GAMESCOPE_EXTERNAL_OVERLAY 2>/dev/null | sed 's/^/    /'
  info "root STEAM_TOUCH_CLICK_MODE + gamescope focus atoms:"
  xprop -root STEAM_TOUCH_CLICK_MODE GAMESCOPE_FOCUSED_APP \
    GAMESCOPE_FOCUSED_WINDOW 2>/dev/null | sed 's/^/    /'
}

checklist() {
  cat <<EOF

${YEL}Verify by hand and record in docs/ambient-overlay-notes.md:${NC}
  1. Does the overlay composite ABOVE the game (semi-transparent)?
  2. Does gamepad/keyboard/touch input still reach the GAME?
  3. Open + close Steam's QAM — does the overlay flicker, vanish, or
     steal the slot back? Does input survive?
  4. Exit the game to BPM home — any input halt? (arrangement 2's
     known landmine; have SSH ready to run 'restore')
  5. Toggle Steam's Performance HUD (mangoapp) — do both coexist?
     (arrangement 1 shares its slot)
EOF
}

cmd="${1:-status}"
WIN="$(find_overlay)"
info "overlay window: ${WIN} (display ${DISPLAY})"

case "$cmd" in
  status)
    show_atoms "$WIN"
    ;;
  try-external)
    warn "arrangement 1: GAMESCOPE_EXTERNAL_OVERLAY (mangoapp slot)"
    xdotool windowmap "$WIN" || warn "windowmap failed — window may already be mapped"
    set_atom "$WIN" GAMESCOPE_EXTERNAL_OVERLAY 1
    set_atom "$WIN" STEAM_OVERLAY 0
    set_atom "$WIN" STEAM_INPUT_FOCUS 0
    set_atom "$WIN" _NET_WM_WINDOW_OPACITY "$OPACITY_HALF"
    show_atoms "$WIN"
    checklist
    ;;
  try-slot)
    warn "arrangement 2: STEAM_OVERLAY=1 + STEAM_INPUT_FOCUS=0"
    warn "make sure a game is RUNNING and focused before continuing (Ctrl-C now if not)"
    sleep 3
    xdotool windowmap "$WIN" || warn "windowmap failed — window may already be mapped"
    set_atom "$WIN" GAMESCOPE_EXTERNAL_OVERLAY 0
    set_atom "$WIN" STEAM_OVERLAY 1
    set_atom "$WIN" STEAM_INPUT_FOCUS 0
    set_atom "$WIN" _NET_WM_WINDOW_OPACITY "$OPACITY_HALF"
    show_atoms "$WIN"
    checklist
    ;;
  restore)
    # Mirror the hidden baseline gamescope-atoms.ts prepare()/hide()
    # leaves behind: invisible, no slot claims, no input focus.
    set_atom "$WIN" _NET_WM_WINDOW_OPACITY "$OPACITY_HIDDEN"
    set_atom "$WIN" GAMESCOPE_EXTERNAL_OVERLAY 0
    set_atom "$WIN" STEAM_OVERLAY 0
    set_atom "$WIN" STEAM_INPUT_FOCUS 0
    xdotool windowunmap "$WIN" || warn "windowunmap failed (non-fatal)"
    info "restored; if the overlay misbehaves: systemctl --user restart loadout-overlay"
    ;;
  *)
    die "unknown command '$cmd' (status | try-external | try-slot | restore)"
    ;;
esac
