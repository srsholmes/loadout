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
  # Quoted: these are glob-matched as strings against a %04x-formatted id.
  # Unquoted, 045e is a number to some YAML parsers.
  #
  # \`name\` as well as the ids, and no \`unique: false\`: 045e:028e is the
  # generic XInput id, so an external Xbox pad would otherwise be folded into
  # the handheld's own composite device instead of presenting separately.
  - group: gamepad
    evdev:
      name: Microsoft X-Box 360 pad
      vendor_id: "045e"
      product_id: "028e"
      handler: event*
  # unique: false because the MCU exposes TWO evdev nodes under this one
  # name (input0 keyboard, input1 keyboard+mouse). Left unique, the second
  # forks a second CompositeDevice off this same config — duplicate virtual
  # pads, which is the "works in menus, not in Steam" signature. Upstream's
  # Apex and X1 configs avoid it by pinning phys_path; we don't have this
  # board's topology, so we join instead.
  - group: keyboard
    unique: false
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

/** A DMI pair some upstream config claims. */
export interface UpstreamMatch {
  productName: string;
  sysVendor: string;
}

/**
 * Pull the DMI pairs a config file claims. Tolerant by design: this reads
 * files another project ships, in a schema it can extend, so anything
 * unrecognised yields no matches rather than throwing.
 */
export function parseUpstreamMatches(yamlText: string): UpstreamMatch[] {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yamlText);
  } catch {
    return [];
  }
  const matches = (doc as { matches?: unknown })?.matches;
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((m) => {
    const dmi = (m as { dmi_data?: { product_name?: unknown; sys_vendor?: unknown } })?.dmi_data;
    if (typeof dmi?.product_name !== "string" || typeof dmi?.sys_vendor !== "string") return [];
    return [{ productName: dmi.product_name, sysVendor: dmi.sys_vendor }];
  });
}

/**
 * Whether InputPlumber now ships its own config for this machine, meaning
 * ours should be removed. Ours winning is correct while it is the only
 * config; it is wrong once upstream — which can test the hardware — has one.
 *
 * Deliberately keyed on the DMI upstream claims, not on our filename. We
 * name files the way upstream would so a same-name config is shadowed rather
 * than duplicated, but there is no guarantee they pick that name: their
 * family runs `50-onexplayer_apex.yaml`, `50-onexplayer_x1.yaml`,
 * `50-onexplayer_mini_pro.yaml`, so `50-onexplayer_x2_mini_pro.yaml` is at
 * least as likely as ours. Under a different name both configs load and both
 * match — and a filename check would report "not superseded" in exactly the
 * case where the user most needs telling.
 */
export function isSupersededByUpstream(config: DeviceConfig, upstream: UpstreamMatch[]): boolean {
  return upstream.some(
    (m) => m.productName === config.productName && m.sysVendor === config.sysVendor,
  );
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
