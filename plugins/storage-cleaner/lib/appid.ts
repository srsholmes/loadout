/**
 * Validate that an appId is strictly numeric to prevent path traversal attacks.
 * Steam app IDs are always numeric (e.g. "730", "440").
 */
export function isValidAppId(appId: string): boolean {
  return /^\d+$/.test(appId);
}
