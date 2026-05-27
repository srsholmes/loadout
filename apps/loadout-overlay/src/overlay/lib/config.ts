/**
 * Backend server configuration.
 *
 * In dev mode, Vite's proxy handles /api and /ws routing to the Bun server.
 * In prod (Electrobun overlay), we use absolute URLs to localhost:33820.
 */

export const BACKEND_URL = import.meta.env.DEV ? "" : "http://localhost:33820";
export const BACKEND_WS = import.meta.env.DEV
  ? `ws://${window.location.host}`
  : "ws://localhost:33820";
export const BACKEND_PORT = 33820;
