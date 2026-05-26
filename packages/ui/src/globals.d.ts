declare global {
  interface Window {
    __LOADOUT_TOKEN__?: string;
    __LOADOUT_BACK_INTERCEPTORS__?: Array<() => boolean>;
  }
}

export {};
