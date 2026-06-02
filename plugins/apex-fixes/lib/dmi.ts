/**
 * DMI (Desktop Management Interface) probe.
 *
 * The APEX plugin is a no-op on non-APEX hardware. Every apply/revert
 * route short-circuits through `isOxpApex()`; the UI also reads this
 * to decide whether to render the stub "not on APEX" banner.
 *
 * DMI strings are exposed by the kernel under /sys/class/dmi/id/. We
 * only rely on sys_vendor + product_name — the APEX reports:
 *
 *   sys_vendor  = "ONE-NETBOOK"
 *   product_name = "ONEXPLAYER APEX"
 *
 * Future APEX revisions are expected to keep the "ONEXPLAYER APEX"
 * product_name prefix, hence the `startsWith` check rather than `===`.
 */

import { readFile } from "node:fs/promises";

export interface DmiInfo {
  sysVendor: string;
  productName: string;
  productFamily: string;
  boardName: string;
}

const DMI_BASE = "/sys/class/dmi/id";

async function readDmiField(field: string): Promise<string> {
  try {
    const raw = await readFile(`${DMI_BASE}/${field}`, "utf-8");
    return raw.trim();
  } catch {
    return "";
  }
}

export async function readDmi(): Promise<DmiInfo> {
  const [sysVendor, productName, productFamily, boardName] = await Promise.all([
    readDmiField("sys_vendor"),
    readDmiField("product_name"),
    readDmiField("product_family"),
    readDmiField("board_name"),
  ]);
  return { sysVendor, productName, productFamily, boardName };
}

export function isApexDmi(info: DmiInfo): boolean {
  return (
    info.sysVendor === "ONE-NETBOOK" &&
    info.productName.startsWith("ONEXPLAYER APEX")
  );
}

export async function isOxpApex(): Promise<boolean> {
  return isApexDmi(await readDmi());
}
