import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

(globalThis as any).__SPATIAL_NAV__ = null;

afterEach(() => {
  document.body.innerHTML = "";
});
