/**
 * @loadout/devices — shared handheld device knowledge.
 *
 * Centralises the static handheld database + TDP ranges (`devices`) and the
 * DMI identity probe (`dmi`) so any plugin can answer "which device is this"
 * and "what are its power limits" without duplicating the table. Pure helpers
 * live in `devices`; the only I/O (reading /sys/class/dmi) lives in `dmi`.
 */

export * from "./devices";
export * from "./dmi";
