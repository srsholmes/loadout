# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/srsholmes/loadout/security/advisories/new)
button (Security → Advisories), which opens a private security advisory only
the maintainer can see. I'll acknowledge it as soon as I can and work with
you on a fix and disclosure timeline.

## Scope worth knowing

Loadout runs a background service **as root** (`loadout.service` /
`loadout-overlay.service`) so it can write hardware sysfs without a polkit
prompt per action — the same model as Decky Loader and HHD. Plugins run
in-process within that service and are gated by a deny-by-default command +
filesystem allow-list declared in each plugin's manifest (see
[docs/plugin-development.md](docs/plugin-development.md)).

Because of the root service, the most security-relevant areas are: the
installer (`scripts/install.sh`, which verifies SHA256 checksums of release
assets), the plugin command/filesystem permission enforcement
(`packages/exec`), and any plugin that downloads and runs external tools.
Reports in these areas are especially appreciated.

## Supported versions

Loadout ships as a rolling release built from `main`. Only the latest
release is supported — please confirm an issue reproduces on the current
build before reporting.
