/**
 * Shared test render utilities for React component tests (bun test +
 * happy-dom, via the `test/bun-test-setup.ts` preload).
 */
import { render as rtlRender, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

export { screen, within, waitFor, act } from "@testing-library/react";
export { fireEvent } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";

export function render(ui: ReactElement, options?: RenderOptions): RenderResult {
  return rtlRender(ui, options);
}
