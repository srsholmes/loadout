# Runtime dependencies

Loadout ships a self-contained binary and a bundled CEF overlay, so there's no
Bun/Node/Python to install. A small set of **system tools** is still shelled
out to, and this page is the canonical list of them.

`scripts/install.sh` checks every tool on this page. Missing **required** tools
are reported in Phase 1 and installed in Phase 2; missing **optional** tools are
reported with the feature they gate and left alone.

To check an existing install by hand:

```sh
for t in xdotool xprop xrandr pgrep tar curl systemctl; do
    command -v "$t" >/dev/null || echo "MISSING: $t"
done
```

## Required

Loadout does not work correctly without these.

| Tool | Used by | What breaks without it |
|---|---|---|
| `xdotool` | `gamescope-atoms.ts` | **The overlay is invisible in Gaming Mode.** It resolves the overlay's own X window id, and every gamescope atom write targets a window id — so `prepare()` and `show()` return early and gamescope is never told the window exists. The overlay still takes the controller and freezes Steam, so the device looks broken with no error anywhere. |
| `xprop` | `gamescope-atoms.ts` | No fallback path for atom reads/writes when libxcb isn't usable (`OVERLAY_FORCE_XPROP=1`, or `xcb_connect` failing). |
| `xrandr` | `screen-size.ts`, `_positionOnPrimary` | The overlay can't probe the gamescope inner-X resolution, falls back to 1280×800, and pointer input lands away from where it's drawn ([#106](https://github.com/srsholmes/loadout/issues/106)). |
| `pgrep` | `loadout-overlay.service` | The unit's `ExecStart` uses it to read Steam's environ and detect gamescope, before the app starts — so display detection falls through to a hardcoded `:0`. |
| `tar` | `lib/updater.ts` | In-app self-update can't unpack a release tarball. |
| `curl` | update checks, plugin fetches | Update checks and plugin-bundle downloads fail. |
| `systemctl` | both units | Neither service can be managed. |

### Package names

| Distro | Packages |
|---|---|
| Arch / CachyOS / SteamOS | `xdotool xorg-xprop xorg-xrandr procps-ng tar curl` |
| Fedora / Bazzite | `xdotool xorg-x11-utils xrandr procps-ng tar curl` |
| Debian / Ubuntu | `xdotool x11-utils x11-xserver-utils procps tar curl` |
| openSUSE | `xdotool xprop xrandr procps tar curl` |

On **SteamOS** the root filesystem is read-only, so installing means
`sudo steamos-readonly disable` first — and a major OS update can revert it.
On **Bazzite**, `rpm-ostree install` needs a reboot to take effect. The
installer prints the right command for both rather than running it.

In practice SteamOS and Bazzite already ship all of the above; Arch-family
installs (CachyOS included) are where a required tool actually goes missing,
because nothing else on the system pulls in `xdotool`.

## Optional

Each of these gates exactly one plugin or feature. Nothing else is affected if
it's absent.

| Tool | Gates |
|---|---|
| `zenity` / `kdialog` / `yad` (any one) | Native file dialogs — the recomp ROM picker (`@loadout/file-picker`) |
| `inputplumber` | Controller wake button in games (installer Phase 2 offers to install it) |
| `busctl` | InputPlumber and bluetooth DBus calls (ships with systemd) |
| `flatpak` | flatpak-manager, and flatpak entries in quick-links |
| `nmcli` | network-info, and the wifi plugin's connection controls |
| `iw` | wifi plugin radio recovery |
| `unzip` | sound-loader packs, recomp archives |
| `zip` | sound-loader pack export |
| `bsdtar` | recomp disc-image extraction |
| `podman`, `distrobox` | recomp build environment (and the SteamOS webkit closure build) |
| `legendary` | store-bridge — Epic Games library |
| `openrgb` | rgb-control |
| `ectool` | fan-control |
| `lsusb` | APEX fingerprint-reader detection |
| `udevadm` | InputPlumber udev rule reloads (ships with systemd) |

## Bundled, not required

These come inside the release archive and never need installing:

- **CEF / Electrobun** — `libcef.so`, `libNativeWrapper.so` and friends, under
  `~/.local/share/loadout-overlay/bin/`
- **ryzenadj** — built and bundled by the tdp-control plugin
- **libwebkit2gtk-4.1 closure** — SteamOS only, built once from a Fedora
  container via podman and cached (see
  [os-compatibility.md](os-compatibility.md))
