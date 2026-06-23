/**
 * DMI probe — the Apex plugin is a no-op on non-Apex hardware.
 *
 * The kernel exposes DMI strings under /sys/class/dmi/id/. The Apex
 * reports:
 *   sys_vendor   = "ONE-NETBOOK"
 *   product_name = "ONEXPLAYER APEX"
 *
 * Future Apex revisions are expected to keep the "ONEXPLAYER APEX"
 * product_name prefix, hence `startsWith` rather than `===`.
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

export function isApexDmi(info: DmiInfo): boolean {
  return info.sysVendor === "ONE-NETBOOK" && info.productName.startsWith("ONEXPLAYER APEX");
}

export async function isApex(): Promise<boolean> {
  return isApexDmi(await readDmi());
}
