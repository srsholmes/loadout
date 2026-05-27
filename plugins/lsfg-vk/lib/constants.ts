// Shared constants for the lsfg-vk plugin UI. Extracted from app.tsx
// alongside `lib/types.ts` as part of the D-010 decomposition.

import type { LsfgSettings } from "./types";

/** Picker filter sentinel — show every game in the library. */
export const ALL_COLLECTIONS = "__all__";
/** Picker filter sentinel — hide non-Steam shortcuts. */
export const STEAM_ONLY = "__steam_only__";

/**
 * Frame-generation multiplier picker options. Tuple form is what the
 * segmented-control + QAM widget both consume.
 */
export const MULTIPLIER_OPTIONS: Array<[number, string]> = [
  [0, "Off"],
  [2, "2×"],
  [3, "3×"],
  [4, "4×"],
];

/**
 * Present-mode override options shown in the advanced settings select.
 * FIFO is the Vulkan default and what most drivers expect.
 */
export const PRESENT_MODE_OPTIONS: Array<{
  value: LsfgSettings["experimental_present_mode"];
  label: string;
}> = [
  { value: "fifo", label: "FIFO (default)" },
  { value: "mailbox", label: "Mailbox" },
  { value: "immediate", label: "Immediate" },
];
