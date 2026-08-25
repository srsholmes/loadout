/**
 * DMI probe.
 *
 * The kernel exposes DMI strings under /sys/class/dmi/id/. An Apex reports:
 *   sys_vendor   = "ONE-NETBOOK"
 *   product_name = "ONEXPLAYER APEX"
 *
 * These predicates are for the handful of cases where a *board-specific*
 * constant is involved — a GPIO pin number, a register map. Prefer detecting
 * the capability you need: every other plugin in this repo asks "is the file
 * I write present?" rather than "which device is this?", which is why they
 * work on hardware nobody here has held.
 */

import { readFile } from "node:fs/promises";

export interface DmiInfo {
  sysVendor: string;
  productName: string;
}

const DMI_BASE = "/sys/class/dmi/id";

async function readDmiField(field: string): Promise<string> {
  try {
    return (await readFile(`${DMI_BASE}/${field}`, "utf-8")).trim();
  } catch {
    return "";
  }
}

export async function readDmi(): Promise<DmiInfo> {
  const [sysVendor, productName] = await Promise.all([
    readDmiField("sys_vendor"),
    readDmiField("product_name"),
  ]);
  return { sysVendor, productName };
}

/** OneXPlayer's vendor string. Matched loosely: firmware ships both
 *  "ONE-NETBOOK" and "ONE-NETBOOK Technology Co., Ltd." across models —
 *  battery-tracker already matches the longer one, so a strict equality here
 *  was wrong even for some genuine Apexes. */
const OXP_VENDOR = "ONE-NETBOOK";

export function isApexDmi(info: DmiInfo): boolean {
  return (
    info.sysVendor.includes(OXP_VENDOR) &&
    info.productName.startsWith("ONEXPLAYER APEX")
  );
}

/** Any OneXPlayer-family handheld. Broader than {@link isApexDmi} — use it
 *  when something applies to the family (an EC quirk, a driver name) rather
 *  than to one board's wiring. */
export function isOneXPlayerDmi(info: DmiInfo): boolean {
  return (
    info.sysVendor.includes(OXP_VENDOR) ||
    info.productName.toUpperCase().includes("ONEXPLAYER")
  );
}

export async function isOneXPlayer(): Promise<boolean> {
  return isOneXPlayerDmi(await readDmi());
}

export async function isApex(): Promise<boolean> {
  return isApexDmi(await readDmi());
}

/** Steam Deck DMI signatures (product_name): Jupiter = LCD, Galileo = OLED.
 *  Same identifiers tdp-control uses. A Valve sys_vendor is accepted as a
 *  belt-and-braces fallback for future Deck revisions. */
const DECK_PRODUCTS = ["Jupiter", "Galileo"];

export function isSteamDeckDmi(info: DmiInfo): boolean {
  if (DECK_PRODUCTS.some((p) => info.productName.includes(p))) return true;
  return info.sysVendor.includes("Valve");
}

export async function isSteamDeck(): Promise<boolean> {
  return isSteamDeckDmi(await readDmi());
}
