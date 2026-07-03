# Releasing

Loadout ships **versioned, manually-triggered releases**. A release is a git tag
`vX.Y.Z` that CI builds into a GitHub Release (binary + overlay + plugins +
checksums), marked "latest" so the installer resolves to it. Every version stays
downloadable by tag.

## Versioning (loose semver, pre-1.0)

- **New feature → minor** (`0.1.0` → `0.2.0`)
- **Bug fix / small change → patch** (`0.2.0` → `0.2.1`)
- **No major bump before 1.0.** `bun run release major` is intentionally
  disabled; pass an explicit version if you ever truly mean it.

Only the **product** versions are bumped — the repo root and the two shipped apps
(`apps/loadout`, `apps/loadout-overlay`). Internal `packages/*` and `plugins/*`
keep their own versions (private, unpublished, not user-visible).

## Cutting a release

From a clean, up-to-date `main`:

```sh
bun run release minor    # or: patch  |  or an explicit X.Y.Z
```

The script (`scripts/release.sh`) then:

1. **Preflight** — on `main`, clean tree, `gh` authenticated, in sync with
   `origin/main`.
2. **CI-green gate** — the newest `ci.yml` run for `main`'s HEAD must be green
   (`--no-ci-check` to override).
3. **CHANGELOG gate** — if `CHANGELOG.md` has no `## [vX.Y.Z]` section it
   **stops** and prints the merged PRs / commits since the last tag so you can
   write the entry, then re-run (`--skip-changelog` to override).
4. Bumps the three product `package.json` versions.
5. Commits `chore(release): vX.Y.Z`, tags it, and pushes `main` + the tag.
6. The tag push triggers `.github/workflows/release.yml`, which **re-runs
   typecheck/lint/specs/tests as a gate**, builds, and publishes the versioned
   release. The script watches that run and prints the release URL.

Preview without changing anything:

```sh
bun run release patch --dry-run
```

## How the version reaches the build

- **Binary:** `scripts/build.sh` runs `git describe --tags --exact-match`, so a
  build at tag `v0.2.0` reports `loadout 0.2.0` — no manual edit needed.
- **Overlay UI:** `apps/loadout-overlay/vite.config.ts` bakes
  `__OVERLAY_VERSION__` from that app's `package.json`; Settings → About, the
  sidebar badge, and error reports all read it. That's why the release script
  bumps the overlay `package.json` before tagging.

## Installing a specific version

The installer takes the newest release by default. To pin/downgrade:

```sh
LOADOUT_VERSION=v0.1.0 curl -fsSL https://raw.githubusercontent.com/srsholmes/loadout/main/scripts/install.sh | sh
```

## Emergency / offline release

If CI is unavailable, mirror it locally (checkout the tag first so the binary
versions correctly):

```sh
git checkout v0.2.0
sh scripts/release-local.sh v0.2.0        # add --dry-run to build without publishing
```

## Notes

- The old single **`rolling`** release is retired in favour of versioned tags.
- GitHub auto-generates release notes from merged PRs; `CHANGELOG.md` is the
  curated, human-facing history.
