// Typed channel schema for Bun → webview messages emitted by the
// overlay-electrobun host. Lives in @loadout/types so plugins and
// other external consumers can import the channel surface without
// depending on overlay-electrobun.
//
// One entry per `rpc.send(name, payload)` channel; the Bun side is the
// only producer, the webview is the only consumer. Adding a new channel
// = one entry here + one handler each side.

/** Continuous-analog axes broadcast on the `overlay-scroll` channel.
 *  Mirrors the value space of NavController's analog dispatch — kept as
 *  a string literal so this module has no runtime dependency on the
 *  overlay-electrobun package. */
export type WebviewAnalogAxis = "RightStickX" | "RightStickY";

export type WebviewMessages = {
  "overlay-visibility": { isOpen: boolean };
  "overlay-open-plugin": { pluginId: string };
  /** User bound `Guide+B` / `Guide+X` to `OpenSettings`. Webview
   *  navigates to /settings on receipt. */
  "overlay-open-settings": Record<string, never>;
  /** User bound `Guide+B` / `Guide+X` to `OpenHome`. Webview
   *  navigates to the home dashboard on receipt. */
  "overlay-open-home": Record<string, never>;
  /** User bound `Guide+B` / `Guide+X` to `ToggleKeyboard`. Webview
   *  flips OSK visibility on receipt. From a game (overlay hidden)
   *  the host first opens the overlay, THEN sends this channel — so
   *  the OSK shows on top of the freshly-opened overlay in one
   *  press. */
  "overlay-toggle-keyboard": Record<string, never>;
  "overlay-action": { action: string };
  "overlay-scroll": { axis: WebviewAnalogAxis; value: number };
};
