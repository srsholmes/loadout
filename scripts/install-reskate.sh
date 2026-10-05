#!/usr/bin/env bash
#
# install-reskate.sh — install ReSkate on Linux / SteamOS.
#
# ReSkate (https://github.com/Dingo-Shenanigans/ReSkate) lets you play
# skate. offline, host your own lobbies and mod it. It is a Windows
# launcher (ReSkateLauncher.exe) plus a runtime DLL that loads into the
# game, so on Linux it runs through Proton. You need your own copy of
# skate. on Steam.
#
# This reproduces the README's "Getting started" steps:
#
#   1. Download the latest ReSkate-<version>.zip from GitHub Releases.
#   2. Extract ReSkateLauncher.exe and ReSkate.dll into either
#        - your skate. folder, beside Skate.exe (the Steam install), or
#        - an empty folder, where the launcher downloads the game for you
#          (about 14 GB; you sign in to Steam inside the launcher).
#   3. Run ReSkateLauncher.exe. It checks for ReSkate updates, then checks
#      the game files against the supported Steam build (25414733).
#   4. Press PLAY.
#
# On this side of the fence step 2 is "find the Steam install of skate.
# (app id 3354750) in any Steam library" and step 3 is "add the launcher
# to Steam as a non-Steam game with Proton forced" — or `--run` to launch
# it through Proton straight from this script.
#
# Usage:
#   install-reskate.sh [--dest DIR] [--version vX.Y.Z] [--run] [--yes]
#
#   --dest DIR      Install here instead of the detected skate. folder.
#                   If DIR has no Skate.exe the launcher will download the
#                   game into it (README option 2).
#   --version TAG   Pin a release tag (default: latest non-prerelease).
#   --run           After installing, launch ReSkateLauncher.exe through
#                   Proton (Steam must be running for Steam features).
#   --yes           Don't ask before writing into the skate. folder.
#
# Read-only until the final copy step; nothing needs sudo.

set -euo pipefail

REPO="Dingo-Shenanigans/ReSkate"
SKATE_APPID=3354750
SUPPORTED_BUILD=25414733

DEST=""
VERSION=""
RUN=0
YES=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  # `$0` is "bash" under `curl … | bash`, so read the header from the
  # file only when it exists; otherwise fall back to a one-liner.
  if [ -r "$0" ]; then sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  else echo "usage: install-reskate.sh [--dest DIR] [--version vX.Y.Z] [--run] [--yes]"; fi
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)    DEST="${2:-}"; shift 2 ;;
    --dest=*)  DEST="${1#*=}"; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --run)     RUN=1; shift ;;
    --yes|-y)  YES=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

for tool in curl unzip sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not installed"
done

# ── Steam library discovery ──────────────────────────────────────────

steam_root() {
  local candidate
  for candidate in \
    "$HOME/.local/share/Steam" \
    "$HOME/.steam/steam" \
    "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam"; do
    if [ -d "$candidate/steamapps" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Every steamapps dir: the default one plus each "path" in
# libraryfolders.vdf (SD card, external drives).
library_paths() {
  local root="$1" vdf="$1/steamapps/libraryfolders.vdf" p
  printf '%s\n' "$root/steamapps"
  [ -r "$vdf" ] || return 0
  sed -n 's/^[[:space:]]*"path"[[:space:]]*"\([^"]*\)".*/\1/p' "$vdf" |
    while IFS= read -r p; do
      # VDF escapes backslashes; Linux paths never contain them anyway.
      p="${p//\\\\/\\}"
      [ "$p/steamapps" = "$root/steamapps" ] && continue
      [ -d "$p/steamapps" ] && printf '%s\n' "$p/steamapps"
    done
}

# Where Steam installed skate. Prints `ready <dir>` when Skate.exe is
# there, `pending <dir>` when Steam has the manifest but the download
# hasn't finished (a manifest exists from the moment a download starts,
# so the exe is the real "it's there" check), nothing when no library
# knows the game.
find_skate_dir() {
  local root="$1" lib manifest installdir dir pending=""
  while IFS= read -r lib; do
    manifest="$lib/appmanifest_${SKATE_APPID}.acf"
    [ -r "$manifest" ] || continue
    installdir=$(sed -n 's/^[[:space:]]*"installdir"[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -n1)
    [ -n "$installdir" ] || continue
    dir="$lib/common/$installdir"
    if [ -f "$dir/Skate.exe" ]; then
      printf 'ready %s\n' "$dir"
      return 0
    fi
    pending="$dir"
  done < <(library_paths "$root")
  [ -n "$pending" ] && printf 'pending %s\n' "$pending"
  return 0
}

# ── Release resolution + download ────────────────────────────────────

resolve_version() {
  if [ -n "$VERSION" ]; then
    printf '%s\n' "$VERSION"
    return 0
  fi
  # github.com/<repo>/releases/latest 302s to /releases/tag/<tag> — the
  # newest non-prerelease, with no API rate limit. Fall back to the API,
  # parsed newline-insensitively (its JSON may come compact or pretty).
  local tag
  tag=$(curl -fsSI "https://github.com/$REPO/releases/latest" 2>/dev/null |
    tr -d '\r' | sed -n 's|^[Ll]ocation: .*/releases/tag/\([^/?#[:space:]]*\).*|\1|p' | head -n1)
  if [ -z "$tag" ]; then
    tag=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      tr -d '\n' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p')
  fi
  printf '%s\n' "$tag"
}

# Pull `"sha256": "<hex>"` out of the named block of launcher.json
# (which pins the exact bytes of the launcher and runtime this release
# expects — the launcher itself verifies against it on update).
pinned_sha256() {
  local file="$1" block="$2"
  tr -d '\n' < "$file" |
    sed -n "s/.*\"$block\":[[:space:]]*{[^}]*\"sha256\":[[:space:]]*\"\([0-9a-fA-F]*\)\".*/\1/p" |
    tr 'A-F' 'a-f'
}

verify() {
  local file="$1" expected="$2" actual
  [ -n "$expected" ] || { warn "no pinned sha256 for $(basename "$file") — skipping verification"; return 0; }
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || die "$(basename "$file") sha256 mismatch: expected $expected, got $actual"
  log "verified $(basename "$file") (sha256 $actual)"
}

# ── Main ─────────────────────────────────────────────────────────────

STEAM=$(steam_root || true)
SKATE_PENDING_DIR=""
SKATE_DIR=""
if [ -n "$STEAM" ]; then
  found=$(find_skate_dir "$STEAM")
  case "$found" in
    ready\ *)   SKATE_DIR="${found#ready }" ;;
    pending\ *) SKATE_PENDING_DIR="${found#pending }" ;;
  esac
fi

MODE=""
if [ -n "$DEST" ]; then
  # Don't create anything yet — nothing is written until the download has
  # been verified. Resolve to an absolute path if it exists already.
  [ -d "$DEST" ] && DEST=$(cd "$DEST" && pwd)
  if [ -f "$DEST/Skate.exe" ]; then
    MODE="beside"
  else
    MODE="empty"
    if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST")" ] && [ ! -f "$DEST/ReSkateLauncher.exe" ]; then
      die "$DEST is neither a skate. folder (no Skate.exe) nor empty. Pick an empty folder or the game folder."
    fi
  fi
elif [ -n "$SKATE_DIR" ]; then
  DEST="$SKATE_DIR"
  MODE="beside"
else
  if [ -n "$SKATE_PENDING_DIR" ]; then
    die "Steam has skate. registered at $SKATE_PENDING_DIR but Skate.exe isn't there yet — it's probably still downloading. Let Steam finish, then run this again. (Or pass --dest DIR to let the launcher download the game itself.)"
  fi
  die "skate. isn't installed through Steam on this machine. Install it in Steam first (your own copy), then run this again — or pass --dest DIR to an empty folder and the launcher will download the game (~14 GB, Steam sign-in inside the launcher)."
fi

case "$MODE" in
  beside)
    log "skate. found at: $DEST"
    if [ "$YES" -ne 1 ]; then
      [ -t 0 ] || die "this writes ReSkateLauncher.exe + ReSkate.dll into your skate. folder; re-run with --yes to confirm non-interactively"
      printf 'Install ReSkate beside Skate.exe in that folder? [Y/n] '
      read -r answer || die "aborted"
      case "${answer:-Y}" in [Yy]*) ;; *) die "aborted" ;; esac
    fi
    ;;
  empty)
    warn "No Skate.exe in $DEST — installing in 'empty folder' mode."
    warn "On first run the launcher will ask you to sign in to Steam and download build $SUPPORTED_BUILD (~14 GB) into that folder."
    ;;
esac

TAG=$(resolve_version || true)
[ -n "$TAG" ] || die "could not resolve the latest ReSkate release (github.com unreachable?); pass --version vX.Y.Z"
VER="${TAG#v}"
ZIP="ReSkate-${VER}.zip"
BASE="https://github.com/$REPO/releases/download/$TAG"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/reskate-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

log "downloading $ZIP ($TAG)"
curl -fL --retry 3 --progress-bar -o "$WORK/$ZIP" "$BASE/$ZIP"
curl -fsSL --retry 3 -o "$WORK/launcher.json" "$BASE/launcher.json" ||
  warn "launcher.json not available for $TAG — downloads will not be checksum-verified"

# Unpack to a staging dir first. The zip is built on Windows with
# backslash separators; unzip rewrites them into directories but exits
# 1 (= warnings) for it, which is not a failure.
log "extracting into $DEST"
unzip -q -o "$WORK/$ZIP" -d "$WORK/stage" >/dev/null 2>&1 || [ $? -eq 1 ] ||
  die "extraction failed — is $ZIP a valid ReSkate release archive?"
[ -f "$WORK/stage/ReSkateLauncher.exe" ] && [ -f "$WORK/stage/ReSkate.dll" ] ||
  die "$ZIP did not contain ReSkateLauncher.exe + ReSkate.dll (release layout changed?)"

if [ -f "$WORK/launcher.json" ]; then
  verify "$WORK/stage/ReSkateLauncher.exe" "$(pinned_sha256 "$WORK/launcher.json" launcher)"
  verify "$WORK/stage/ReSkate.dll"         "$(pinned_sha256 "$WORK/launcher.json" runtime)"
fi

# Only the two files the README names go beside Skate.exe; the licence
# texts the release ships are kept under licenses/ so they don't mix
# with the game's own files.
mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd)
cp -f "$WORK/stage/ReSkateLauncher.exe" "$WORK/stage/ReSkate.dll" "$DEST/"
mkdir -p "$DEST/licenses"
[ -f "$WORK/stage/LICENSE.txt" ] && cp -f "$WORK/stage/LICENSE.txt" "$DEST/licenses/ReSkate-LICENSE.txt"
if [ -d "$WORK/stage/licenses" ]; then
  cp -f "$WORK/stage/licenses/"* "$DEST/licenses/" 2>/dev/null || true
fi

log "installed ReSkate $TAG → $DEST"

cat <<EOF

Next steps
----------
ReSkate supports one skate. build at a time (Steam build $SUPPORTED_BUILD).
In Steam → skate. → Properties → Updates, choose "Only update this game
when I launch it" so Steam doesn't move past that build behind your back;
if it does, the launcher re-downloads the pinned build after a Steam
sign-in.

Run it through Proton, one of:

  a) Steam (recommended, works in Gaming Mode):
       Steam → Add a Game → Add a Non-Steam Game → Browse →
         $DEST/ReSkateLauncher.exe
       then Properties → Compatibility → Force the use of a specific
       Steam Play compatibility tool → Proton Experimental (GE-Proton
       also works). Launch it, then press PLAY.

  b) Loadout's RecompHub plugin ("ReSkate" entry) does the above for you,
     Steam shortcut and artwork included.

  c) This script:  install-reskate.sh --run

Controls in game: Insert = ReSkate menu, ~ = console, T = chat.
Mods go in $DEST/Mods/, logs in $DEST/logs/ReSkate.log.
EOF

# ── --run: launch through Proton from here ───────────────────────────

if [ "$RUN" -eq 1 ]; then
  [ -n "$STEAM" ] || die "--run needs a Steam install (Proton comes from it)"
  PROTON=""
  for candidate in \
    "$STEAM/steamapps/common/Proton - Experimental" \
    "$STEAM/compatibilitytools.d"/GE-Proton* \
    "$STEAM/steamapps/common/Proton "*; do
    if [ -x "$candidate/proton" ]; then PROTON="$candidate"; break; fi
  done
  [ -n "$PROTON" ] || die "no Proton found under $STEAM — install Proton Experimental from Steam → Library → Tools"

  # Share skate.'s own prefix when running beside it (same registry,
  # same Steam detection), otherwise keep one of our own. Note a Steam
  # non-Steam shortcut (option a) gets its OWN prefix, so profiles made
  # here and there are separate. Running `proton` outside Steam's
  # container is unsupported-but-works on SteamOS; Flatpak Steam can't.
  if [ "$MODE" = "beside" ]; then
    export STEAM_COMPAT_DATA_PATH="$STEAM/steamapps/compatdata/$SKATE_APPID"
  else
    export STEAM_COMPAT_DATA_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/reskate/compatdata"
  fi
  mkdir -p "$STEAM_COMPAT_DATA_PATH"
  export STEAM_COMPAT_CLIENT_INSTALL_PATH="$STEAM"
  pgrep -x steam >/dev/null 2>&1 || warn "Steam isn't running — ReSkate will report Steam as offline (multiplayer needs it)"

  log "launching with $(basename "$PROTON")"
  cd "$DEST"
  exec "$PROTON/proton" run "$DEST/ReSkateLauncher.exe"
fi
