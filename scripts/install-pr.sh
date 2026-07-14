#!/bin/sh
# Build and install Loadout from a pull request, for testing a fix before
# it merges. Fetches the PR head via GitHub's refs/pull/N/head (works for
# same-repo and fork PRs alike), builds from source, and installs exactly
# like `bun run build-and-install`.
#
# Usage:
#   sh scripts/install-pr.sh <pr-number>     # e.g. sh scripts/install-pr.sh 214
#   sh scripts/install-pr.sh <branch-name>   # e.g. sh scripts/install-pr.sh fix/my-branch
#
# Environment:
#   LOADOUT_REPO   git URL to fetch from (default: git@github.com:srsholmes/loadout.git;
#                  use an https URL + your token if you don't have SSH access)
#
# The build happens in a fresh shallow clone under ~/.cache/loadout-pr-test/,
# so an existing checkout (and any local changes in it) is never touched.
# (Deliberately NOT inside ~/.cache/loadout — the backend runs as root and
# owns that directory, so a user-run script can't create anything there.)
# Reverting to the official build afterwards is one command — the README's
# install one-liner reinstalls the current release over this.
#
# Requires: git, bun (https://bun.sh), and the build deps a normal
# `bun run build-and-install` needs. Prompts for sudo once, at install time,
# same as the regular installer.
set -eu

REPO="${LOADOUT_REPO:-git@github.com:srsholmes/loadout.git}"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/loadout-pr-test"

if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
else
    RED=''; GREEN=''; BLUE=''; NC=''
fi
info()  { printf "${BLUE}[INFO]${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
fail()  { printf "${RED}[ERROR]${NC} %s\n" "$1" >&2; exit 1; }

REF_ARG="${1:-}"
[ -n "$REF_ARG" ] || fail "usage: install-pr.sh <pr-number | branch-name>"

# A numeric argument is a PR number; anything else is a branch name.
# refs/pull/N/head is GitHub's read-only ref for a PR's current head — it
# exists for every open PR, including ones from forks, without needing to
# know the contributor's branch name.
case "$REF_ARG" in
    *[!0-9]*) REF="refs/heads/$REF_ARG"; NAME="$REF_ARG" ;;
    *)        REF="refs/pull/$REF_ARG/head"; NAME="pr-$REF_ARG" ;;
esac

command -v git >/dev/null 2>&1 || fail "git is required"

# bun might not be on PATH in a fresh shell even when installed (its
# installer puts it in ~/.bun/bin and only edits interactive-shell rc files).
if ! command -v bun >/dev/null 2>&1; then
    if [ -x "$HOME/.bun/bin/bun" ]; then
        PATH="$HOME/.bun/bin:$PATH"
        export PATH
    else
        fail "bun is required to build from source — install it first: curl -fsSL https://bun.sh/install | bash"
    fi
fi

WORKDIR="$CACHE_ROOT/$(printf '%s' "$NAME" | tr '/' '-')"
info "Fetching $REF into $WORKDIR..."
mkdir -p "$WORKDIR"
cd "$WORKDIR"
if [ ! -d .git ]; then
    git init -q
    git remote add origin "$REPO"
fi
# --depth 1 keeps the clone small; re-running the script re-fetches the
# PR's current head, so an updated PR just needs the same command again.
git fetch --depth 1 origin "$REF" || fail "could not fetch $REF from $REPO — check the PR number / branch name and your access to the repo"
git checkout -q --detach FETCH_HEAD
ok "Checked out $(git rev-parse --short HEAD) ($REF)"

info "Installing dependencies..."
bun install --frozen-lockfile

info "Building + installing (this replaces your current Loadout install; sudo will prompt once)..."
bun run build-and-install

echo ""
ok "Installed Loadout from $NAME ($(git rev-parse --short HEAD))."
info "Verify:  systemctl --user is-active loadout-overlay && journalctl --user -u loadout-overlay --since '-2min' | grep -c panic"
info "Revert to the official release at any time with the README install one-liner."
