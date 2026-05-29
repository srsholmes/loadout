// Shared constants for the lsfg-vk plugin (UI + backend).

import type { LsfgSettings } from "./types";

export const PLUGIN_ID = "lsfg-vk";

/** Profile name keyed in conf.toml `[[game]] exe = "..."` and exported as LSFG_PROCESS. */
export const PROFILE = "steam-loader-lsfg-vk";

/**
 * The token we put into Steam launch-options strings. We prefer the
 * tilde form (`~/lsfg`) over the absolute path because it's portable
 * across users + matches what users typically configure by hand. Steam
 * launches launch-options through `/bin/sh -c`, which expands `~` at
 * exec time, so the literal tilde works.
 */
export const WRAPPER_TOKEN = "~/lsfg";

export const DEFAULTS: LsfgSettings = {
  multiplier: 2,
  flow_scale: 0.8,
  performance_mode: false,
  hdr_mode: false,
  experimental_present_mode: "fifo",
  verbose_logging: false,
};

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
