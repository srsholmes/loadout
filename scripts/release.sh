#!/bin/sh
# Cut a versioned Loadout release.
#
# Bumps the product version, updates the CHANGELOG (via a gate — see below),
# commits, tags `vX.Y.Z`, and pushes. The tag push triggers
# .github/workflows/release.yml, which builds the tag in clean CI and publishes
# a versioned GitHub Release (marked "latest", so the curl installer resolves to
# it). Old versions stay downloadable by tag.
#
# Semver (pre-1.0, loose): features -> minor, fixes -> patch. No major until 1.0.
#
# Usage:
#   sh scripts/release.sh <major|minor|patch|X.Y.Z> [flags]
#   bun run release minor
#
# Flags:
#   --dry-run          Show what would happen; make no commits/tags/pushes.
#                      Preflight problems (dirty tree, behind origin) become
#                      warnings instead of errors so it's a safe preview.
#   --skip-changelog   Skip the CHANGELOG-entry gate (rare no-notes release).
#   --no-ci-check      Skip the "main CI is green" gate.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="srsholmes/loadout"

# --- output helpers (match scripts/build.sh) ---
if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
    RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
    GREEN=''; BLUE=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi
info()    { printf "${BLUE}[release]${NC} %s\n" "$1"; }
success() { printf "${GREEN}[ok]${NC} %s\n" "$1"; }
warn()    { printf "${YELLOW}[warn]${NC} %s\n" "$1"; }
error()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }
die()     { error "$1"; exit 1; }

# --- args ---
BUMP=""
DRY_RUN=0
SKIP_CHANGELOG=0
NO_CI_CHECK=0
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --skip-changelog) SKIP_CHANGELOG=1 ;;
        --no-ci-check) NO_CI_CHECK=1 ;;
        --force) FORCE=1 ;;
        -h|--help)
            sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        -*) die "unknown flag: $arg" ;;
        *) [ -z "$BUMP" ] && BUMP="$arg" || die "unexpected argument: $arg" ;;
    esac
done
[ -n "$BUMP" ] || die "missing bump: major|minor|patch|X.Y.Z (see --help)"

# preflight problems are fatal for a real run, warnings for --dry-run
preflight_fail() { [ "$DRY_RUN" = "1" ] && warn "$1" || die "$1"; }

# --- tools ---
for t in git gh bun; do command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"; done

# --- preflight: branch, tree, remote, auth ---
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || preflight_fail "not on main (on '$BRANCH'). Releases are cut from main."
[ -z "$(git -C "$ROOT" status --porcelain)" ] || preflight_fail "working tree is dirty. Commit or stash first."
gh auth status >/dev/null 2>&1 || preflight_fail "gh is not authenticated (run: gh auth login)."

git -C "$ROOT" fetch --quiet origin main 2>/dev/null || warn "could not fetch origin/main"
LOCAL="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE="$(git -C "$ROOT" rev-parse origin/main 2>/dev/null || echo "")"
if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    preflight_fail "local main ($(echo "$LOCAL" | cut -c1-9)) != origin/main ($(echo "$REMOTE" | cut -c1-9)). Pull/push first."
fi

# --- compute versions ---
CUR="$(grep '"version"' "$ROOT/package.json" | head -1 | sed 's/.*"version": *"//;s/".*//')"
[ -n "$CUR" ] || die "could not read current version from package.json"
MAJOR="${CUR%%.*}"; REST="${CUR#*.}"; MINOR="${REST%%.*}"; PATCH="${REST#*.}"; PATCH="${PATCH%%-*}"

case "$BUMP" in
    major) die "major bumps are disabled pre-1.0 — pass an explicit version (e.g. 1.0.0) if you truly mean it." ;;
    minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
    patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    [0-9]*.[0-9]*.[0-9]*) NEW="$BUMP" ;;
    *) die "invalid bump '$BUMP' — use major|minor|patch|X.Y.Z" ;;
esac
echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "computed version '$NEW' is not X.Y.Z"
TAG="v$NEW"

git -C "$ROOT" rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists."

# Guard against a downgrade: an explicit version lower than the current one
# would still publish with make_latest, silently downgrading every installer.
# (minor/patch keywords always increase, so this only bites explicit X.Y.Z.)
# NEW == CUR is allowed — that's the first release when package.json already
# carries the target version; the tag-exists check above blocks true re-releases.
if [ "$NEW" != "$CUR" ]; then
    HIGHEST="$(printf '%s\n%s\n' "$CUR" "$NEW" | sort -V | tail -1)"
    if [ "$HIGHEST" = "$CUR" ]; then
        [ "$FORCE" = "1" ] || die "refusing to release $NEW — lower than current $CUR (pass --force to override)."
        warn "releasing $NEW below current $CUR (--force)."
    fi
fi

info "current version: ${BOLD}$CUR${NC}"
info "new version:     ${BOLD}$NEW${NC}  (tag $TAG)"

# --- CI-green gate: newest ci.yml run for this exact commit must be success ---
if [ "$NO_CI_CHECK" = "1" ]; then
    warn "skipping CI-green gate (--no-ci-check)"
else
    CI="$(gh run list --repo "$REPO" --branch main --workflow ci.yml --limit 15 \
        --json headSha,status,conclusion \
        --jq '[.[] | select(.headSha=="'"$LOCAL"'")][0] | if . == null then "" else .status + "/" + (.conclusion // "") end' 2>/dev/null || true)"
    case "$CI" in
        completed/success) success "CI is green for $(echo "$LOCAL" | cut -c1-9)" ;;
        "" ) preflight_fail "no CI run found for main HEAD $(echo "$LOCAL" | cut -c1-9) yet — wait for CI, or pass --no-ci-check." ;;
        completed/*) preflight_fail "CI for main HEAD is ${CI#completed/} (not success). Fix main first, or pass --no-ci-check." ;;
        *) preflight_fail "CI for main HEAD is still running ($CI). Wait for it, or pass --no-ci-check." ;;
    esac
fi

# --- CHANGELOG gate (the AI/human prompt) ---
DATE="$(date -u +%Y-%m-%d)"
if [ "$SKIP_CHANGELOG" = "1" ]; then
    warn "skipping CHANGELOG gate (--skip-changelog)"
elif grep -qF "## [$TAG]" "$ROOT/CHANGELOG.md" 2>/dev/null; then
    success "CHANGELOG.md has a section for $TAG"
else
    LAST_TAG="$(git -C "$ROOT" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
    printf '\n'
    error "CHANGELOG.md has no \"## [$TAG]\" section."
    printf "${BOLD}Add this section to the top of CHANGELOG.md, then re-run \`bun run release $BUMP\`:${NC}\n\n"
    printf "  ## [%s] — %s\n\n" "$TAG" "$DATE"
    printf "  ### Added / Changed / Fixed\n"
    printf "  - ...\n\n"
    printf "${BOLD}Source material — changes since %s:${NC}\n" "${LAST_TAG:-the start (first versioned release)}"
    if [ -n "$LAST_TAG" ]; then
        git -C "$ROOT" log --no-merges --pretty='  - %s' "$LAST_TAG..HEAD"
        SINCE="$(git -C "$ROOT" log -1 --format=%cs "$LAST_TAG")"
        printf "\n${BOLD}Merged PRs since %s:${NC}\n" "$SINCE"
        gh pr list --repo "$REPO" --state merged --limit 100 \
            --json number,title,mergedAt \
            --jq 'sort_by(.mergedAt) | .[] | select(.mergedAt[0:10] >= "'"$SINCE"'") | "  #\(.number) \(.title)"' 2>/dev/null || true
    else
        git -C "$ROOT" log --no-merges -20 --pretty='  - %s'
        printf "  (first versioned release — see the existing CHANGELOG for the full history)\n"
    fi
    printf "\n${BOLD}Reminder:${NC} features -> minor, fixes -> patch. Group entries under Added / Changed / Fixed.\n\n"
    # In --dry-run this is a preview: surface the requirement but don't hard-fail,
    # so the rest of the plan still prints. A real run stops here.
    [ "$DRY_RUN" = "1" ] || exit 1
    warn "--dry-run: CHANGELOG section missing (a real run would stop here)."
fi

# --- dry run stops here ---
if [ "$DRY_RUN" = "1" ]; then
    printf '\n'
    info "--dry-run: would do the following (no changes made):"
    printf "  1. bump root + apps/loadout + apps/loadout-overlay package.json -> %s\n" "$NEW"
    printf "  2. commit \"chore(release): %s\" (package.json x3 + CHANGELOG.md)\n" "$TAG"
    printf "  3. tag %s and push main + tag\n" "$TAG"
    printf "  4. tag push triggers release.yml -> versioned release\n"
    exit 0
fi

# --- bump, commit, tag, push ---
info "bumping product versions..."
bun "$SCRIPT_DIR/bump-version.ts" "$NEW"

git -C "$ROOT" add package.json apps/loadout/package.json apps/loadout-overlay/package.json CHANGELOG.md
git -C "$ROOT" commit -q -m "chore(release): $TAG"
git -C "$ROOT" tag -a "$TAG" -m "$TAG"
success "committed and tagged $TAG"

info "pushing main + tag..."
git -C "$ROOT" push --quiet origin main --follow-tags
success "pushed. release.yml will build $TAG."

# --- watch the release run (best-effort) ---
# Poll for the run whose head branch is THIS tag, rather than grabbing the
# newest release run — otherwise a slow-to-register run lets us watch a prior
# (already-succeeded) one and report a false success.
RUN_ID=""
i=0
while [ "$i" -lt 6 ]; do
    RUN_ID="$(gh run list --repo "$REPO" --workflow release.yml --limit 15 \
        --json databaseId,headBranch \
        --jq '[.[] | select(.headBranch=="'"$TAG"'")][0].databaseId' 2>/dev/null || true)"
    [ -n "$RUN_ID" ] && break
    i=$((i + 1))
    sleep 5
done
if [ -n "$RUN_ID" ]; then
    info "watching release run $RUN_ID..."
    gh run watch "$RUN_ID" --repo "$REPO" --exit-status --interval 15 || warn "release run did not succeed — check the Actions tab."
else
    warn "couldn't find the release run for $TAG yet — check the Actions tab."
fi
success "done. Release: https://github.com/$REPO/releases/tag/$TAG"
