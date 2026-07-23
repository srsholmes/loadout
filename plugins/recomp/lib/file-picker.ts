/**
 * File-picker wrapper for the recomp plugin.
 *
 * The actual zenity/kdialog/yad plumbing now lives in
 * `@loadout/file-picker` so other plugins (store-bridge,
 * sound-loader, theme-loader) can share it. This module keeps the
 * recomp-specific defaults (the ROM-picker title / filter label)
 * and back-compat exports so the rest of the plugin doesn't have
 * to know about the move.
 */
import { pickFile } from "@loadout/file-picker";

export { pickFile };

/**
 * ROM-picker convenience: same defaults the recomp UI used before
 * the shared-package extraction. Routes through `pickFile` with the
 * "Select ROM file" title + "ROM files" filter label so the dialog
 * matches its old appearance.
 */
export async function pickRomFile(
  extensions?: string[],
): Promise<string | null> {
  return pickFile({
    title: "Select ROM file",
    extensions,
    filterLabel: "ROM files",
  });
}
