/**
 * Bun → webview channel schema for the overlay app.
 *
 * One entry per `rpc.send(name, payload)` channel. The Bun side is the
 * only producer, the webview is the only consumer. Adding a new channel
 * = one entry here + one handler each side.
 */

export type WebviewAnalogAxis = "RightStickX" | "RightStickY";

export type WebviewMessages = {
  "overlay-visibility": { isOpen: boolean };
  "overlay-open-plugin": { pluginId: string };
  "overlay-open-settings": Record<string, never>;
  "overlay-open-home": Record<string, never>;
  "overlay-toggle-keyboard": Record<string, never>;
  "overlay-action": { action: string };
  "overlay-scroll": { axis: WebviewAnalogAxis; value: number };
};
