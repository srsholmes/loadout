# Storage

> Detect and mount a game-storage drive (e.g. a second SSD holding a Steam library) that the system stopped auto-mounting after an update, and optionally pin it in /etc/fstab so it survives future updates. Works on any device.

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
