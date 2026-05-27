# Planned: deprecate and delete `apex-fixes` from this repo

This plugin will be **deprecated and removed** from
`linux-gaming-plugin-manager` before the public release. The earlier
plan was to extract it to its own repo so the GPL-2 kernel artifacts
could live in a dedicated repo with `COPYING` + `WRITTEN_OFFER.txt`
— that plan is **dropped**. We are simply not going to ship the
plugin from here.

## Rationale

- **No public release ships before deprecation.** With deletion
  scheduled before any public release, the GPL-2 obligations on
  `kernel-modules/*/oxpec.ko` (out-of-tree Linux kernel module — GPL-2
  by kernel mandate) and `kernel-patches/hid-oxp/*.patch` (Linux
  kernel patches, GPL-2) never trigger from this repository — there
  is no public distribution from here to comply against.
- **DMI-guarded scope.** The plugin is a no-op on every platform
  that isn't a OneXPlayer APEX. With InputPlumber landing natively
  in Bazzite imminently and the input-plumber plugin handling the
  installer story for distros that don't ship it, the bulk of what
  apex-fixes does becomes redundant for new users.
- **Whoever needs the OXP-specific kernel module on a non-Bazzite
  setup** can build `oxpec.ko` directly from
  [Samsagax/oxpec](https://github.com/Samsagax/oxpec) themselves —
  which is where it should be sourced from anyway.

## Action

- [ ] Pick a date or trigger for deletion (e.g. once Bazzite ships
      InputPlumber natively in the base image).
- [ ] On that date: `git rm -r plugins/apex-fixes/`. Update
      `install-local.sh` if it references the plugin path. Drop
      apex-fixes from `LICENSE_AUDIT.md`'s plugin tables and from
      anywhere else in docs (`docs/architecture.md`, etc.).
- [ ] Optional: a one-line note in `README.md` or release notes
      pointing OXP Apex users at upstream `Samsagax/oxpec` if they
      still need the kernel module on non-Bazzite distros.

## Why not extract to its own repo?

Considered, then dropped. Extraction would mean:

1. New repo with GPL-2 `COPYING` and `WRITTEN_OFFER.txt` for the
   kernel artifacts.
2. Pinned source revisions per kernel build.
3. Independent release cadence tracking Bazzite kernel ABI changes.

That's a non-trivial maintenance burden (per-kernel rebuilds,
written-offer hygiene, release tagging) for a plugin whose
addressable audience is one specific handheld and whose key
functionality is becoming a default in the upstream OS. Just
delete it; users on niche setups can build oxpec themselves.

## Out of scope

- The TypeScript wrapper licensing is moot — it doesn't ship from
  this repo once the directory is removed.
- No code changes to `apex-fixes` itself between now and deletion;
  the plugin remains DMI-guarded and inert on non-APEX hardware in
  the meantime.

For the audit context that drove this decision, see
`LICENSE_AUDIT.md` at the repo root, §3 HIGH (`plugins/apex-fixes`)
and §5 row 4.
