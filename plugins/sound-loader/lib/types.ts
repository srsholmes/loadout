// ---------------------------------------------------------------------------
// Window-attached globals used by the sound-loader app to share the
// active + original SoundEngine across module instances. Each plugin
// bundle has its own module scope, so a module-level singleton would
// collide between the load-on-startup init() and the later mount()
// import. Stashing the active and original sound modules on `window`
// keeps both copies in sync.
//
// These globals are sound-loader-specific — declared here (with the
// consumer) rather than in the shared `types/window-globals.d.ts`
// catch-all so the ownership is obvious.
// ---------------------------------------------------------------------------

/** Methods the sound engine exposes — every one optional so a custom pack can omit any. */
export interface SoundEngine {
  getSoundVolume?: () => number;
  playNav?: () => void;
  playSelect?: () => void;
  playBack?: () => void;
  playToggleOn?: () => void;
  playToggleOff?: () => void;
  playSliderTick?: () => void;
  playError?: () => void;
  playSideMenuIn?: () => void;
  playSideMenuOut?: () => void;
  playTabTransition?: () => void;
}

declare global {
  interface Window {
    /** Active sound engine — swapped by sound-loader when packs change. */
    __SL_SOUNDS__?: SoundEngine;
    /** First-seen sound module, captured so we can restore defaults. */
    __SL_ORIGINAL_SOUNDS__?: SoundEngine;
  }
}

// ---------------------------------------------------------------------------
// Community sound-pack registry (live from api.deckthemes.com via lib/sounds-cache)
// ---------------------------------------------------------------------------

export interface CommunityPackEntry {
  /** deckthemes uuid — primary key for install/uninstall and dedupe. */
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  /** Canonical download URL (api.deckthemes.com/blobs/<id>) — install source. */
  downloadUrl: string;
  /** Hotlinkable preview image URL, or null. CEF loads it directly; we don't bundle/cache. */
  previewImageUrl: string | null;
  /** Parsed GitHub URL from `source` (display only); null for "[Zip Deploy]" packs. */
  githubUrl: string | null;
  /** Upstream "last_changed" string (for display/sorting). */
  lastChanged: string;
  manifestVersion: number;
  /** True for music-only packs (different UX from UI sound packs). */
  music: boolean;
}
