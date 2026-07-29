# Contributing to Loadout

Thanks for your interest — Loadout is a solo-maintained project and
contributions, bug reports, and device reports are all very welcome.

## Before you start

For anything beyond a small fix, please **open an issue first** so we can
agree on the approach before you sink time into a PR. If you're reporting
that Loadout works (or doesn't) on a handheld I haven't tested, the
**hardware/device report** issue template is exactly what I'm looking for.

## Development setup

Loadout is a [Bun](https://bun.sh) monorepo (`apps/*`, `packages/*`,
`plugins/*`).

```sh
bun install
bun run dev:overlay      # loader dev server + Electrobun overlay, hot reload
```

Full build-from-source and install steps are in the
[README](README.md#build-from-source). The overlay/CEF architecture is
described in [docs/architecture.md](docs/architecture.md).

## Writing a plugin

[docs/plugin-development.md](docs/plugin-development.md) is the complete
guide — plugin anatomy, the manifest format, the backend/frontend APIs, the
permission model, and a fully worked example. Start there.

## Before you open a PR

Please make sure the suite is green — CI runs all of these on every PR:

```sh
bun run typecheck     # tsc --noEmit, must be 0 errors
bun run lint          # eslint, must be 0 errors (warnings tolerated)
bun run test          # backend + UI tests, must pass
bun run check:specs   # backend/lib files over 100 LOC need a sibling spec
bun run format        # prettier
```

Keep PRs focused, match the style of the surrounding code, and add tests for
new backend/lib behaviour.

## Releases

Releases are versioned (`vX.Y.Z`) and cut manually with `bun run release
<minor|patch>`, which bumps versions, updates the CHANGELOG, tags, and lets CI
build and publish. Loose semver pre-1.0: features → minor, fixes → patch. See
[docs/releasing.md](docs/releasing.md).

## Licensing

By contributing, you agree your contributions are licensed under the
project's [BSD-3-Clause](LICENSE) license. If your change wraps or bundles a
third-party component, note its license in the relevant `NOTICE` file (see
existing `plugins/*/NOTICE` for the pattern) and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
