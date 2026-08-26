/**
 * Ship an InputPlumber *device* config for handhelds InputPlumber doesn't
 * recognise yet.
 *
 * ## Why this exists
 *
 * InputPlumber only builds a CompositeDevice for hardware one of its configs
 * matches, and matching is on the exact `/sys/class/dmi/id/product_name`
 * (`glob_match`, but no shipped OneXPlayer config uses a wildcard). A device
 * it hasn't got a config for produces *no* composite device — so
 * `listCompositeDevicePaths()` comes back empty, the wake-button picker has
 * nothing to offer, and overlay input intercept has nothing to act on. Every
 * InputPlumber-dependent feature is inert, on hardware that is otherwise
 * completely conventional.
 *
 * That is the OneXPlayer X2 Mini Pro's situation as of InputPlumber 0.78.1:
 * a stock `045e:028e` XInput pad and the same `1a86:fe00` OneXPlayer MCU the
 * Apex and X1 configs already use, and no config naming it.
 *
 * ## Why a drop-in works
 *
 * `get_devices_paths()` reads `/etc/inputplumber/devices.d` *before*
 * `/usr/share/inputplumber/devices`, and files are sorted by filename with
 * directory order breaking ties. So a file here with the same basename an
 * upstream config would use *shadows* it rather than adding a second config
 * that matches the same machine. That is why {@link X2_MINI_PRO} pins
 * `50-onexplayer_x2.yaml` and not something Loadout-branded: the day
 * InputPlumber ships its own, ours quietly takes precedence instead of
 * racing it, and {@link isSupersededByUpstream} can tell the user to drop it.
 *
 * NOTE the capability-map search order is *inverted* from this one
 * (`/usr/share` first, `/etc/inputplumber/capability_maps.d` second), so the
 * same trick does not work for capability maps. This module deliberately
 * ships none — see below.
 *
 * ## What is deliberately left out
 *
 * Only what makes a composite device exist: the gamepad, the MCU's HID
 * interface, and the MCU's keyboard interface. Not included, because neither
 * can be verified without the hardware and both can make things worse:
 *
 * - **The `AT Translated Set 2 keyboard` source.** The Apex config claims it
 *   for volume keys. Claiming the system keyboard on a board we have never
 *   run means a wrong guess costs the user their keyboard, not a feature.
 * - **A capability map for the back paddles.** On the X2 the MCU's intercept
 *   mode no longer carries them; Handheld Daemon remaps them to keycodes so
 *   they arrive as KEY_F15/KEY_F16 on the MCU keyboard interface. Two
 *   problems: that mapping is applied by *HHD's* init, and we would be
 *   relying on the kernel `hid-oxp` driver to do the same — untested — and
 *   KEY_F16 is already the overlay's wake key (KEY_F15 is a capture
 *   sentinel), so claiming them would change behaviour that may already
 *   work. That needs a decision and an `evtest`, not a default.
 */

/** InputPlumber's drop-in directory for device configs. */
export const DEVICES_D = "/etc/inputplumber/devices.d";

/** Where InputPlumber's own configs live, checked to spot upstream catching
 *  up with us. */
export const UPSTREAM_DEVICES_DIR = "/usr/share/inputplumber/devices";

const SCHEMA =
  "https://raw.githubusercontent.com/ShadowBlip/InputPlumber/main/rootfs/usr/share/inputplumber/schema/composite_device_v1.json";

export interface DeviceConfig {
  /** Exact `/sys/class/dmi/id/product_name` this applies to. */
  productName: string;
  /** Exact `/sys/class/dmi/id/sys_vendor`. */
  sysVendor: string;
  /** Shown in the UI. */
  label: string;
  /** Basename, matching what upstream would ship so this shadows it. */
  filename: string;
  yaml: string;
}

/**
 * OneXPlayer X2 Mini Pro.
 *
 * Sources are matched by USB id rather than `phys_path`: the schema makes
 * `phys_path` optional and the ROG Ally / Legion Go configs already omit it,
 * and we have this device's USB ids from a doctor report but not its bus
 * topology. If a second X2 variant ever collides, pin `phys_path` then.
 */
export const X2_MINI_PRO: DeviceConfig = {
  productName: "ONEXPLAYER X2Mini PRO",
  sysVendor: "ONE-NETBOOK",
  label: "OneXPlayer X2 Mini Pro",
  filename: "50-onexplayer_x2.yaml",
  yaml: `# yaml-language-server: $schema=${SCHEMA}
#
# Installed by Loadout because InputPlumber ships no config matching this
# device, which leaves it with no CompositeDevice at all. Remove it from
# Loadout's InputPlumber plugin, or delete this file and restart
# inputplumber.service.
version: 1
kind: CompositeDevice

name: ONEXPLAYER X2 Mini Pro

single_source: false

# /sys/class/dmi/id/product_name
matches:
  - dmi_data:
      product_name: ONEXPLAYER X2Mini PRO
      sys_vendor: ONE-NETBOOK

source_devices:
  - group: gamepad
    unique: false
    evdev:
      vendor_id: 045e
      product_id: 028e
      handler: event*
  - group: keyboard
    evdev:
      name: HID 1a86:fe00
      handler: event*
  - group: gamepad
    hidraw:
      vendor_id: 0x1a86
      product_id: 0xfe00
      interface_num: 2

options:
  auto_manage: true

target_devices:
  - xbox-elite
  - mouse
  - keyboard
`,
};

/** Every device we can supply a config for. */
export const DEVICE_CONFIGS: readonly DeviceConfig[] = [X2_MINI_PRO];

export interface Dmi {
  productName: string;
  sysVendor: string;
}

/**
 * The config for this machine, or null.
 *
 * Exact match on both DMI fields — deliberately stricter than
 * `packages/devices`' substring matching. A config claims specific USB ids
 * and hands input handling to InputPlumber, so matching a device we did not
 * mean to is a much worse failure than not matching one we did.
 */
export function findDeviceConfig(dmi: Dmi | null): DeviceConfig | null {
  if (!dmi) return null;
  const productName = dmi.productName.trim();
  const sysVendor = dmi.sysVendor.trim();
  return (
    DEVICE_CONFIGS.find((c) => c.productName === productName && c.sysVendor === sysVendor) ?? null
  );
}

/** Absolute path the config is installed to. */
export function configPath(config: DeviceConfig): string {
  return `${DEVICES_D}/${config.filename}`;
}

/**
 * Whether InputPlumber now ships its own config under this basename, meaning
 * ours is shadowing it and should be removed. Ours winning is the correct
 * behaviour while it is the only config; it is the wrong behaviour once
 * upstream — which can test the hardware — has one.
 */
export function isSupersededByUpstream(config: DeviceConfig, upstreamFiles: string[]): boolean {
  return upstreamFiles.includes(config.filename);
}

export interface DeviceConfigStatus {
  /** We have a config for this machine. When false the UI shows nothing. */
  applicable: boolean;
  label: string | null;
  path: string | null;
  /** Our file is on disk. */
  installed: boolean;
  /** InputPlumber is already producing composite devices here. */
  hasCompositeDevices: boolean;
  /** Upstream now ships this filename; ours is shadowing it. */
  superseded: boolean;
}

export const NOT_APPLICABLE: DeviceConfigStatus = {
  applicable: false,
  label: null,
  path: null,
  installed: false,
  hasCompositeDevices: false,
  superseded: false,
};

/**
 * Should the user be offered the install?
 *
 * Only when we have a config, it isn't already installed, and InputPlumber
 * genuinely has nothing — a device that already works must never be offered
 * a config that would take its input handling over.
 */
export function shouldOfferInstall(status: DeviceConfigStatus): boolean {
  return (
    status.applicable && !status.installed && !status.hasCompositeDevices && !status.superseded
  );
}
