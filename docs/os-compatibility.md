# OS Compatibility

Loadout is a **Linux-only** app — an overlay for distros running Steam's
Gaming Mode. Supported targets are **SteamOS**, **Bazzite**, and
**CachyOS**. There is no macOS or Windows build; the notes below cover
the differences between the supported Linux distros.

## The Immutability Spectrum

| OS | Filesystem | Notes |
|---|---|---|
| **SteamOS** | Fully immutable root. `/usr` read-only. A/B partition scheme (like Android OTA). Home directory survives. | Primary target |
| **Bazzite** | Immutable via `rpm-ostree` (Fedora Silverblue lineage). Can layer system packages that persist across updates. | Growing community |
| **CachyOS** | Traditional mutable Arch. No immutability constraints. | Easiest target, least representative |

**Implication:** The binary, plugins, overlay, and user data live in the home
partition and survive updates. The **backend** runs as a *system* service
(`/etc/systemd/system/loadout.service`, root — so plugins can touch hardware
without a password prompt); the **overlay** runs as a *user* service
(`~/.config/systemd/user/loadout-overlay.service`). The binary installs to
`~/.local/share/loadout/loadout` on SteamOS (writable home) or
`/usr/local/bin/loadout` elsewhere, symlinked onto `PATH` at
`~/.local/bin/loadout`. See [install-locations.md](install-locations.md) for the
exact per-distro paths.

## SteamOS

### What Survives Updates (Home Partition)

- `~/.local/share/loadout/loadout` (the binary) + `~/.local/bin/loadout` (PATH symlink)
- `~/.config/systemd/user/loadout-overlay.service` (the overlay user service)
- `~/.local/share/loadout/plugins/` and `~/.local/share/loadout-overlay/`
- User config + data in `~/.config/loadout/` and `~/.local/`

### What Gets Wiped (System Partition)

- `/usr/`, `/etc/`, `/opt/`
- System-level systemd services in `/etc/systemd/system/` — **including the
  backend's `loadout.service`**, so after a major SteamOS update re-run the
  installer to re-register it (the home-partition pieces above are untouched)
- Packages installed with `pacman`

### Gotchas

- SteamOS sometimes resets `~/.bash_profile` — don't rely on shell-config environment variables
- SteamOS ships a specific Steam client version, often months behind latest — webpack module finders must be tested against the SteamOS-pinned version, not just latest

## Bazzite

- **SELinux** enabled and pre-configured by default — the biggest cross-OS gotcha. The loader must only do things the default Bazzite policy permits: spawning from `$HOME`, binding localhost ports, writing to `$HOME`. For hardware control (sysfs writes), use the polkit helper pattern
- **CEF debug port** forwarded differently: `steam-web-debug-portforward@.service` forwards from `localhost:8080` to `localhost:8081`
- Steam installed as layered RPM (not Flatpak) — same system access as SteamOS
- `fsync`/`futex2` patched kernel for broader hardware support (ROG Ally, Legion Go, desktops)

## CachyOS

- LAVD scheduler as default CPU scheduler, optimised for handheld
- No guaranteed Gaming Mode — scripted approximation of SteamOS's implementation
- Rolling release means Steam is always latest — CachyOS users hit webpack breakage first, making them a canary for SteamOS
- BORE scheduler kernel with custom patches, not Deck-specific

## Steam Packaging: Native vs Flatpak

```
Native Steam:  ~/.local/share/Steam/
Flatpak Steam: ~/.var/app/com.valvesoftware.Steam/.local/share/Steam/
```

SteamOS ships native Steam. Bazzite installs Steam as layered RPM (not Flatpak). CachyOS varies.

```ts
import { existsSync } from "fs";

export function getSteamRoot(): string {
  const flatpak = `${process.env.HOME}/.var/app/com.valvesoftware.Steam/.local/share/Steam`;
  const native = `${process.env.HOME}/.local/share/Steam`;
  return existsSync(flatpak) ? flatpak : native;
}
```

## CEF Debug Port

| OS | Port |
|---|---|
| SteamOS | `localhost:8080` |
| Bazzite | `localhost:8081` |
| CachyOS | `localhost:8080` |

Auto-detection:

```ts
async function findCEFPort(): Promise<number> {
  for (const port of [8080, 8081]) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return port;
    } catch {}
  }
  throw new Error("Steam CEF not found on any known port. Is Steam running?");
}
```

## Kernel Differences

| OS | Kernel |
|---|---|
| **SteamOS** | Valve's `jupiter` kernel — fork of mainline with Deck-specific patches, custom TDP controls, `amdgpu` patches for Van Gogh APU |
| **Bazzite** | `fsync`/`futex2` patched kernel for broader hardware. Deck-specific if on Deck hardware |
| **CachyOS** | BORE scheduler kernel with custom patches. Not Deck-specific |

## Distribution (standalone Linux binary)

The standalone binary (`bun build --compile`) means no runtime dependencies:

```bash
bun build ./apps/loadout/src/index.ts \
  --compile \
  --target=bun-linux-x64 \
  --minify \
  --outfile ./dist/loadout-linux-x64
```

(This is what `scripts/build.sh` / `bun run build` drives.) A single
self-contained binary — users don't need Bun, Node, or Python installed.

## Compatibility Summary

| Concern | SteamOS | Bazzite | CachyOS |
|---|---|---|---|
| Overlay user service | Survives updates | Survives updates | Always fine |
| Backend system service | Re-run installer after major update | Survives (layered) | Always fine |
| Native Steam paths | Standard | Varies | Varies |
| Flatpak Steam paths | Unlikely | Common | Common |
| Hardware sysfs (PowerTools-style) | Deck paths exist | Deck only on Deck | No Deck paths |
| Post-update survival | Only home dir | Layers survive | Everything |
| Dev via SSH | Works, fiddly | Easy | Easy |
| SELinux | No | Yes (default) | No |

## Development Workflow

- **Desktop Linux** — Cleanest. Run Steam natively, loader connects. QAM only available in Big Picture mode
- **Remote dev on device** — SSH available. VS Code Remote works. Bun fast enough for direct dev
- **Type-checking off-device** — `bun run typecheck`/unit tests run on any OS with Bun, but the app only builds and runs on Linux, and the overlay needs a Linux box with Steam to test

## CI Testing

Test against three Steam versions:
1. **SteamOS stable** (oldest) — the baseline
2. **SteamOS beta** — early warning
3. **Latest Steam** (Bazzite/CachyOS) — CachyOS users are the canary
