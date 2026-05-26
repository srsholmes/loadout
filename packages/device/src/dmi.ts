import { readFile } from "node:fs/promises";

export interface DmiInfo {
  sysVendor: string;
  productName: string;
  productFamily: string;
  boardName: string;
}

const DMI_BASE = "/sys/class/dmi/id";

async function readField(field: string): Promise<string> {
  try {
    const raw = await readFile(`${DMI_BASE}/${field}`, "utf-8");
    return raw.trim();
  } catch {
    return "";
  }
}

export async function readDmi(): Promise<DmiInfo> {
  const [sysVendor, productName, productFamily, boardName] = await Promise.all([
    readField("sys_vendor"),
    readField("product_name"),
    readField("product_family"),
    readField("board_name"),
  ]);
  return { sysVendor, productName, productFamily, boardName };
}
