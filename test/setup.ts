import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

if (typeof window === "undefined") {
  GlobalRegistrator.register();
}

expect.extend(matchers);
