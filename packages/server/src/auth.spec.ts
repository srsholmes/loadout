import { describe, it, expect } from "bun:test";
import { createSessionAuth } from "./auth";

describe("createSessionAuth", () => {
  it("generates a 64-char hex token", () => {
    const { token } = createSessionAuth();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates ?token= query parameter", () => {
    const auth = createSessionAuth();
    const req = new Request(`http://x/ws?token=${auth.token}`);
    expect(auth.validateRequest(req)).toBe(true);
  });

  it("validates Authorization: Bearer header", () => {
    const auth = createSessionAuth();
    const req = new Request("http://x/api/plugins", {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    expect(auth.validateRequest(req)).toBe(true);
  });

  it("rejects mismatched tokens", () => {
    const auth = createSessionAuth();
    expect(auth.validateRequest(new Request("http://x/?token=wrong"))).toBe(false);
    expect(auth.validateRequest(new Request("http://x/"))).toBe(false);
  });
});
