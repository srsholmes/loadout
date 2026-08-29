# Storage

> Detect and mount a game-storage drive (e.g. a second SSD holding a Steam library) that the system stopped auto-mounting after an update, and optionally pin it in /etc/fstab so it survives future updates. Works on any device.

## Why the boot mount stops working, and how it heals itself

"Mount on boot" writes an `/etc/fstab` entry. On any OS that regenerates
`/etc` on update, that entry can simply vanish — and the plugin has to cope
with that everywhere, not just on one device.

The clearest case is SteamOS. `/etc` is an overlay whose upper layer lives on
`/var` —

```
/etc  overlay  lowerdir=/new_root/etc, upperdir=/new_root/var/lib/overlays/etc/upper
```

— and `/var` is **per-slot**, not shared:

| partset   | rootfs    | var       | holds                                        |
| --------- | --------- | --------- | -------------------------------------------- |
| self (A)  | `nvme…p5` | `nvme…p7` | the `/etc` upper layer for slot A            |
| other (B) | `nvme…p4` | `nvme…p6` | the `/etc` upper layer for slot B            |
| shared    | —         | —         | `/home` — survives updates and slot switches |

An A/B update installs into the _other_ slot and boots you into it. Carrying
`/etc` across is a separate step (`holo-booted-slot-sync-trigger`, which runs
on shutdown after an update), so if it doesn't run — a hard power-off, a
suspend instead of a shutdown — you boot into a slot whose `/etc/fstab`
predates your pin. **The entry is gone**, the drive doesn't mount, and Steam
shows a library full of missing games. rpm-ostree images regenerate `/etc`
too; the mechanism differs, the symptom doesn't.

So the plugin checks at startup and puts it back. The user's choice is stored
in plugin storage under `$HOME` (`autoMount`, keyed by lowercased UUID), not
inferred from `/etc/fstab`: the entry is exactly what the update deletes, so
afterwards it cannot distinguish "never wanted it" from "wanted it and the OS
ate it". Re-pinning off the fstab state would mean re-pinning nothing at all.

### It never edits an entry it didn't write

Matching on `UUID=<uuid>` alone does not establish ownership. Most pinned
entries on a given machine were written by its owner, long before they
installed Loadout, and their options matter enormously — `subvol=@games` on
btrfs, `uid=`/`umask=` on ntfs and exfat. Normalising one of those to our
canonical line silently boots someone into the wrong subvolume, or makes the
mount root-only so Steam can't write to it.

So the **options field is the discriminator** (`MANAGED_OPTIONS`). An entry
whose options are one Loadout has written is ours: we refresh its shape when
it's stale, and remove it if the user switches the drive off. Anything else is
theirs — stored verbatim, restored byte-for-byte if it disappears, and
otherwise never touched. Adopted entries are recorded line and all, because
adoption is not authorship.

### The other two failures

The entry surviving but the drive **not mounting** looks identical to the user.
`nofail` plus a device timeout means a slow-to-enumerate drive fails
_silently_ — no failed unit, no journal error. On a Deck cold boot the SD
controller only publishes `mmcblk0` around two seconds in, and the entry used
to allow 5s; it now allows 10s, and a stale entry of ours is rewritten on
sight. A drive that hasn't enumerated _at all_ when the backend starts is
invisible to a single `lsblk`, so the reconcile re-scans on a short schedule
while a wanted drive is still missing — that being precisely the case that
most needs healing.

Third, a drive switched **off** whose removal failed is still pinned and still
mounting every boot while the toggle reads off. The reconcile retracts our own
leftover entry, so that state self-corrects.

Mounting goes through `mount <target>` with a single argument when fstab
already pins the drive, so `mount(8)` reads the entry and applies the user's
own options — passing both device and directory silently discards them, which
would mount a btrfs top-level subvolume instead of `subvol=@games`. An entry
marked `noauto` is left unmounted: that flag is how a dual-booter keeps a
Windows partition alone.

Either way the drive is mounted immediately, not just pinned for next time —
the boot the user is sitting in is the broken one. What happened is reported
as a toast at overlay startup **and** on the plugin page; the two consume the
notice independently, because the toast fires on the first overlay open,
before anyone can have navigated to the page, and a shared flag would leave
the page permanently empty.

The reconcile runs fire-and-forget from `onLoad` — the loader awaits each
plugin's `onLoad` in turn with no timeout and the HTTP server doesn't start
until that loop finishes, so blocking on `lsblk` + `mount`, let alone the
re-scan window, would stall the whole backend boot.

## What it will not touch

The plugin edits `/etc/fstab` as root, so its filters are deny-by-default and
its ownership rules are explicit.

**System partitions.** A partition is judged by _where it is mounted_, not by
whether someone labelled it helpfully. Only `/run/media/`, `/media/` and
`/mnt/` count as data mount roots; everything else is the OS's. Labels alone
were never enough — SteamOS is the one distro that both labels its system
partitions (`rootfs-A`, `var`) and refers to them in fstab by
`/dev/disk/by-partsets/…` rather than `UUID=`. Fedora, Bazzite and Nobara
label the root `fedora` and leave `/boot` unlabelled at exactly the 1 GiB size
floor; Arch and Ubuntu label nothing. An unmounted system partition is caught
by its fstab target instead.

**Entries it didn't write.** Ownership is decided by the options field
(`MANAGED_OPTIONS`), never by `UUID=` alone: one filesystem UUID legitimately
has many fstab entries — that is how btrfs subvolumes are mounted. A line the
user wrote is never rewritten and never removed, and the boot-mount toggle is
disabled for a drive pinned that way (`externallyPinned`) rather than offering
a switch we would refuse to honour.

**Malformed writes.** Mount points are octal-escaped on the way in, so a drive
labelled `My Passport` produces six fields rather than seven — an unescaped
space shifts every field along, which silently drops `nofail` and turns the
mount into a hard requirement of `local-fs.target`.

**Interrupted writes.** `/etc/fstab` is replaced by write-to-temp plus
`rename`, never truncated in place, and a read that _fails_ is never treated
as an empty file. The backup at `/etc/fstab.loadout.bak` is only taken from
content actually read, and is never overwritten with nothing.

## Screenshots

![Storage](./assets/screenshot.png)

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
