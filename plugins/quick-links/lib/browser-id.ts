/**
 * Pure browser-id classification helper. Lives in `lib/` so it's
 * testable without any backend mocks.
 */

/**
 * Browser ids the issue-121 banner specifically asks about: Chrome /
 * Firefox in any flavour (native, flatpak, librewolf-as-firefox-fork).
 * The banner suppresses when ANY installed shortcut matches one of
 * these — keeps the banner from nagging a user who set up Brave or
 * Edge as their primary browser.
 */
export function isChromeOrFirefoxBrowserId(browserId: string): boolean {
  return (
    browserId.includes("firefox") ||
    browserId.includes("librewolf") ||
    browserId.includes("chrome")
  );
}
