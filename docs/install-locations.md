# Install locations across distros (SteamOS / Bazzite / generic)

There is **no single install path that works on every supported distro**. The
install scripts must branch on the host. This doc explains why and what to do.

## TL;DR — decision rule

Detect the distro from `/etc/os-release` and pick:

| Host (`ID=` in `/etc/os-release`) | Binary path | systemd `ExecStart=` |
|---|---|---|
| `steamos` | `~/.local/share/loadout/loadout` | the same `~/.local/share/loadout/loadout` |
| `bazzite` (or anything Fedora-ostree-based: `fedora`, `silverblue`, `kinoite`, `bazzite`) | `/usr/local/bin/loadout` | `/usr/local/bin/loadout` |
| anything else (Arch, CachyOS, generic) | `/usr/local/bin/loadout` | `/usr/local/bin/loadout` |

Plugins, config, and logs go in the user's home in **every** case
(`~/.local/share/loadout/plugins`, `~/.config/loadout/`) — only the binary
location moves.

**Do NOT run `steamos-readonly disable`** to force the binary into `/usr/local/bin` on SteamOS — see the SteamOS row below for why.

## SteamOS — install to `~/.local/share/loadout/loadout`

- `/usr` is mounted **read-only** on SteamOS by default. You can `steamos-readonly disable` to make it writable, but:
  - **SteamOS updates replace the entire root partition (A/B image swap), so anything written into `/usr` is wiped on the next system update.** The user would have to reinstall after every SteamOS update — terrible UX.
  - Disabling readonly is also a system-wide change that can interact badly with SteamOS's own updater.
- SteamOS does **not** run SELinux in enforcing mode, so the original concern (system service can't `exec` a binary in `data_home_t`) does not apply. A binary in `~/.local/share/loadout/loadout` execs fine from a root systemd unit.
- `/home/<user>/` (and `~/.local/share/`) are on the persistent user partition (`/home`), which **survives SteamOS image updates**.

So on SteamOS, the install layout is: binary in `~/.local/share/loadout/loadout`, the system unit's `ExecStart=` points there, plugins/config/logs unchanged. Persistent + no readonly toggling.

## Bazzite / Fedora ostree — install to `/usr/local/bin/loadout`

- Bazzite runs SELinux in **enforcing** mode.
- A root systemd unit runs in the `init_t` SELinux domain. `init_t` is **denied `execute`** on any binary labeled `data_home_t` — which is everything under `~/.local/share/` and `~/.config/`. So the binary cannot live in the user's home on Bazzite; the service fails with `status=203/EXEC` "Permission denied" and crash-loops.
- The binary must live at a system path with the `bin_t` SELinux context. On Fedora-ostree systems, `/usr/local/bin/` is a writable, persistent, `bin_t`-labeled location: `/usr/local` is a symlink to `/var/usrlocal`, so its contents survive `rpm-ostree` updates.
- This mirrors what [HHD](https://hhd.dev) does: HHD ships as a Fedora RPM (`hhd-*.noarch`) and its binary lives at `/usr/bin/hhd` (system-managed, `bin_t`). The "run from `~/.local/share`" pattern (HHD's `hhd_local@.service`) is a developer-only path that doesn't work under enforcing SELinux.

Document of record: `memory/project_root_service_selinux.md` (and the
`loadout.service` template comment in the repo root).

## Generic Linux (CachyOS, Arch, etc.) — `/usr/local/bin/loadout`

`/usr/local/bin` is writable on a normal Linux system and on `PATH` by default. No SELinux issue, no immutable-root issue. Same path as Bazzite for consistency.

## What the install scripts do

`scripts/install.sh` and `scripts/install-local.sh` resolve the binary path at
install time:

1. Source `/etc/os-release` and read `ID`.
2. If `ID=steamos`, install the binary to `$HOME/.local/share/loadout/loadout` (no sudo needed for the binary itself; the system unit install still needs sudo).
3. Otherwise (Bazzite, Fedora-ostree, CachyOS, Arch, generic): install to `/usr/local/bin/loadout` with `sudo install` + `restorecon`.
4. Generate `loadout.service` with the chosen `ExecStart=` path baked in (the unit template uses `__BIN__`/`__USER__` substitution).
5. Surface the chosen path in the install summary so the user knows where the binary landed.

`uninstall.sh` runs the symmetric detection so it removes from the right path.

## What NOT to do

- **Do not** `steamos-readonly disable` + install to `/usr/local/bin` on SteamOS. The next OS update wipes it.
- **Do not** install to `~/.local/share` on Bazzite/Fedora-ostree. SELinux blocks the root service from `exec`'ing it (`status=203/EXEC`).
- **Do not** install to `/opt/` blindly — its label and writability vary by distro and aren't worth the extra branching when `/usr/local/bin` already works everywhere except SteamOS.
