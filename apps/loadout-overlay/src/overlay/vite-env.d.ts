/// <reference types="vite/client" />

/** Product version, injected at build time by `vite.config.ts` from
 *  `apps/loadout-overlay/package.json`. Single source for every UI version
 *  display (Settings → About, sidebar badge, error reports). */
declare const __OVERLAY_VERSION__: string | undefined;
