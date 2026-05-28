/**
 * Pure parser for a single Steam appmanifest_*.acf (Valve KeyValues)
 * file. Extracts `appid` + `name` from the top-level block. The full
 * grammar is more elaborate, but the two fields we need always appear
 * at the head of the file in practice.
 */

export interface AcfManifest {
  appId: string;
  name: string;
}

export function parseAcf(content: string): AcfManifest | null {
  const appIdMatch = content.match(/"appid"\s+"(\d+)"/);
  const nameMatch = content.match(/"name"\s+"([^"]+)"/);
  if (!appIdMatch || !nameMatch) return null;
  return { appId: appIdMatch[1], name: nameMatch[1] };
}
