# Recomp catalog refresh — September 2026

Follow-up to `docs/recomp-new-titles-plan.md` (July 2026). Everything here
was verified live against the GitHub API on 2026-09-09, including
downloading the release archives to pin exact `launchCommand` paths.

## The rule this sweep exists to record

**Most "releases" in the 2026 recomp wave are build harnesses, not games.**
Download the archive and look inside before writing a catalog entry.

- A **real game** is a stripped ELF or AppImage of tens of MB with an
  `assets/` directory and no toolchain.
- A **harness** contains `CMakeLists.txt`, `recomp-ui/`, `psxrecomp/`, a
  `README-SETUP.txt`, or a `setup.sh`. Installing one lands a source tree
  and launches nothing.

The filename does not tell you which: `-linux-x64.zip` means both things
depending on the project. Verified examples:

| Repo | Linux asset | Contents |
|---|---|---|
| `TechnicallyComputers/Klonoa-Door-to-Phantomile` | `kdp-0.1.3-linux-x64.zip` | 2125 files, `psxrecomp/` + `README-SETUP.txt` — harness |
| `Unchiga/YuGiOhForbiddenMemoriesRecomp` | `ygofm-0.5.9-linux-x64.zip` | 2321 files, `recomp-ui/` — harness |
| `Ed1z19/ValkyrieRecomp` | `ValkyrieRecomp-1.0.1-linux-x64.zip` | `CMakeLists.txt`, `codegen_setup.c` — harness |
| `jackpoison-prog/RingOut` | `RingOut-1.5.2-steamdeck-x86_64.zip` | README: *"contains NO game data and NO game code"* — harness |
| `mstan/ApeEscapeRecomp` | `…-linux-x86_64.AppImage` | 27 MB ELF + assets — **game** |
| `novapowers0/BloodyRoar2Recomp` | `BloodyRoar2-US-linux-x64-*.zip` | ELF + bundled `openbios.bin` — **game** |

The reason is legal as much as technical: a binary built from the user's
disc is the game, so upstreams ship the recompiler instead.

## What landed

19 new installable titles, 9 fixes to existing rows, 4 regression repairs
found by the audit, and one pipeline capability.

**Pipeline**: added `GameEntry.flattenRoot` (`lib/types.ts`,
`lib/pipeline.ts`) — an opt-in that hoists a single *version-stamped*
top-level directory out of the extracted archive, reusing the existing
`flattenSingleRoot()` that was previously gated on `manualImport` alone.
Entries with a **stable** wrapper (`perfect-dark`'s `pd-x86_64-linux/`)
must NOT set it; they encode the directory in `launchCommand` on purpose.

**Not needed after all**: the July note that Mega Man 64's Linux build is
"a nested zip→tar.gz the installer doesn't unwrap" is stale —
`extractNestedArchives()` in `lib/pipeline-archive.ts` already handles it.
Mega Man 64 and Donkey Kong 64 both install natively on Linux now.

**Regressions the audit caught** (all the same class — upstream renamed an
asset, the glob stopped matching, and the entry silently fell back to
Windows-via-Proton or broke outright):

- `banjo-recomp` — v1.0.2 switched `.zip` → `.tar.gz`
- `mariokart64-recomp`, `dnzh-recomp`, `starfox64-recomp` — pkgforge-dev's
  2026-09-01 rebuild dropped the underscores (`MarioKart_64_Recompiled-` →
  `MarioKart64Recompiled-`). All three now anchor on the stable
  `*Recompiled-*-anylinux-x86_64.AppImage` tail.
- `viva-pinata-tip-recomp` (`retip_` → `retip-`) and `opentdu` (both
  platform assets renamed)

`scripts/audit-urls.ts` is what surfaces these; it is worth running on a
schedule rather than only during a sweep. Two fixes went in alongside:

- It now checks **every declared platform** instead of returning ok on the
  first glob that matches. The old behaviour hid exactly this regression
  class — `banjo-recomp` declares both a Linux and a Windows glob, so while
  its Linux asset was unmatched the audit still reported
  "ok (matched windows)". Tightening it immediately surfaced two more
  pre-existing breakages that had been masked: `openmw` (Windows glob) and
  `aitd-rehaunted` (Linux glob).
- It skips `manualImport` entries, which carry no `repo` and could only ever
  report a false 404.

## Deferred, with reasons

- **Klonoa, Yu-Gi-Oh! Forbidden Memories, Valkyrie Profile, Tomba!,
  SoulCalibur II (RingOut), Mario Kart Wii** — build harnesses (above).
  Cataloguing them needs a new `setup_package` install type that runs the
  upstream wizard inside the `recomp-build` distrobox container (which
  `lib/build-env.ts` already provisions for `sotn-pc`) and allowlists
  `TechnicallyComputers/retcomm-toolchains` as a download host. RingOut is
  the best first target: a measured 45–49 fps on SteamOS with working
  rollback netplay. Tomba! additionally publishes two incompatible asset
  naming schemes in one repo, which a single glob string cannot express.
- **Super Smash Bros. Melee** — `doldecomp/melee` hit 100% matched on
  2026-09-07 (all 19,828 functions; byte-identical GALE01 NTSC 1.02 DOL).
  It builds a **GameCube DOL**, not a PC binary, and publishes no releases.
  A matching decompilation recovers the source; a port is a separate
  project on top of it. `jonrosner/melee-native` ships a Linux tarball but
  is a one-day-old v0.1.0 prerelease **in which saving does not work**.
  Tracked via the `super-smash-bros-melee` row's `_reason`.
- **Wave Race 64** (`chronic8000/WaveRace64Recompiled`) — no releases;
  upstream self-describes as unfinished.
- **Conker** (`Conker64Recomp/conker64-recompiled`) — sole asset is 940 KB,
  which cannot contain a game.
- **Castlevania 64** (`spacefarergames/CV64-Recomp`) — non-semver tag
  (`Releases`) and an unresolved AI-provenance flag on the author's output.
- **Animal Crossing** (`flyngmt/ACGC-PC-Port`) — prerelease-only *and*
  32-bit MinGW, needing a 32-bit Wine prefix nothing else here exercises.
- **Mega Man X4, Pocket Monsters Stadium (JP), Beetle Adventure Racing** —
  too early, or rolling `Continuous` tags that make versions meaningless.
- **Tekken 3, Einhander, Strider 2, Street Fighter EX2** — require a retail
  `SCPH1001.BIN`; there is still no BIOS-file `romInfo` capability. (Most
  psxrecomp titles bundle MIT OpenBIOS and need no BIOS, which is what
  unblocked the four PS1 rows that did land.)
- **GoldenEye 007 N64** (`cblock85/GoldenEye64Recomp`) — advertises Linux,
  publishes only macOS ARM64.
- **GitLab-hosted canonical repos** (`sonicdcer/*`: Mario Kart 64, Star Fox
  64, DNZH, Extreme-G) — the pipeline is GitHub-only. Keep the
  `pkgforge-dev` AppImage mirrors; do not "fix" the repo field to GitLab.

## Gotchas worth knowing next time

- **A declared platform whose asset is missing from the newest release is a
  hard install failure, not a fallback.** `getEffectivePlatformValue()`
  commits to Linux as soon as `releaseAssets.linux` is a string, so if the
  resolved release happens to ship Windows only, `resolveAssetUrl` throws
  `No asset matching …` instead of falling back to the Proton build. This is
  not hypothetical: `aitd-rehaunted` was live-broken this way (its 2.4.0
  stable is Windows-only; Linux last appeared in a 2.3.0 *prerelease*, which
  the resolver skips), and it was fixed here by setting `"linux": null`.
  The same trap is latent for the `mstan` PS1 entries, whose rolling
  `shared-staging-*` tag has occasionally carried Windows assets only. If
  that recurs, either pin `latestAssetUrl` or drop the Linux glob until
  upstream stabilises — and consider teaching `resolveAssetUrl` to fall back
  to an older release that does have the platform asset.
- **`scripts/test-installers.ts --deep` is weaker than it looks.** It
  accepts the launch binary at *any* depth in the extracted tree, so it
  cannot catch a wrong `launchCommand` path or a missing `flattenRoot`.
  Verify the exact `{installDir}/…` path separately.
- **The `mstan` PS1 repos publish a rolling `shared-staging-YYYYMMDD`
  release** that is not flagged prerelease and sorts newest, so it wins
  over the semver tag. Assets are identically named, so globs match either
  way — but the displayed version reads `shared-staging-…`.
  `GameEntry.versionPattern` exists in `lib/types.ts` for exactly this and
  is **read nowhere**; implement or delete it.
- **Region is baked into a PS1 recompilation.** Bloody Roar II's EU and US
  binaries are not interchangeable. Only the US row is catalogued.
- **Two GameCube decomp repos are misleading**: Kirby Air Ride's
  `doldecomp/kar` has more stars but died in Feb 2025 (live: `wowjinxy/KAR`),
  and Perfect Dark moved to `perfect-dark-pc-port/perfect_dark`.
