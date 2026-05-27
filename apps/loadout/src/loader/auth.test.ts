import { describe, expect, it, beforeEach } from "bun:test";
import { generateSessionToken, getSessionToken, validateRequest } from "./auth";

describe("auth", () => {
  let token: string;

  beforeEach(() => {
    token = generateSessionToken();
  });

  describe("generateSessionToken", () => {
    it("should return a non-empty string", () => {
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("should return a valid UUID format", () => {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(token).toMatch(uuidRegex);
    });

    it("should generate a different token each time", () => {
      const token2 = generateSessionToken();
      expect(token).not.toBe(token2);
    });
  });

  describe("getSessionToken", () => {
    it("should return the most recently generated token", () => {
      expect(getSessionToken()).toBe(token);
      const newToken = generateSessionToken();
      expect(getSessionToken()).toBe(newToken);
      expect(getSessionToken()).not.toBe(token);
    });
  });

  describe("validateRequest — static asset routes (no auth required)", () => {
    it("should allow /up without auth", () => {
      const req = new Request("http://localhost:33820/up");
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow / without auth", () => {
      const req = new Request("http://localhost:33820/");
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /overlay without auth", () => {
      const req = new Request("http://localhost:33820/overlay");
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /overlay/ without auth", () => {
      const req = new Request("http://localhost:33820/overlay/");
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /overlay/app.js without auth", () => {
      const req = new Request("http://localhost:33820/overlay/app.js");
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /plugins/my-plugin/app-bundle.js without auth", () => {
      const req = new Request(
        "http://localhost:33820/plugins/my-plugin/app-bundle.js"
      );
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /plugins/tdp-control/app-bundle.js without auth", () => {
      const req = new Request(
        "http://localhost:33820/plugins/tdp-control/app-bundle.js"
      );
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /plugins/theme-loader/assets/screenshots/x.jpg without auth", () => {
      const req = new Request(
        "http://localhost:33820/plugins/theme-loader/assets/screenshots/abc123.jpg"
      );
      expect(validateRequest(req)).toBe(true);
    });

    it("should allow /plugins/my-plugin/assets/icon.png without auth", () => {
      const req = new Request(
        "http://localhost:33820/plugins/my-plugin/assets/icon.png"
      );
      expect(validateRequest(req)).toBe(true);
    });
  });

  describe("validateRequest — API routes (auth required)", () => {
    it("should reject /api/rpc without token", () => {
      const req = new Request("http://localhost:33820/api/rpc", {
        method: "POST",
      });
      expect(validateRequest(req)).toBe(false);
    });

    it("should reject /api/plugins without token", () => {
      const req = new Request("http://localhost:33820/api/plugins");
      expect(validateRequest(req)).toBe(false);
    });

    it("should accept /api/rpc with valid Bearer token", () => {
      const req = new Request("http://localhost:33820/api/rpc", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(validateRequest(req)).toBe(true);
    });

    it("should accept /api/plugins with valid Bearer token", () => {
      const req = new Request("http://localhost:33820/api/plugins", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(validateRequest(req)).toBe(true);
    });

    it("should accept /api/rpc with valid token in query param", () => {
      const req = new Request(
        `http://localhost:33820/api/rpc?token=${token}`,
        { method: "POST" }
      );
      expect(validateRequest(req)).toBe(true);
    });

    it("should reject /api/rpc with invalid Bearer token", () => {
      const req = new Request("http://localhost:33820/api/rpc", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(validateRequest(req)).toBe(false);
    });

    it("should reject /api/rpc with invalid query param token", () => {
      const req = new Request(
        "http://localhost:33820/api/rpc?token=wrong-token",
        { method: "POST" }
      );
      expect(validateRequest(req)).toBe(false);
    });

    it("should reject /api/rpc with empty Authorization header", () => {
      const req = new Request("http://localhost:33820/api/rpc", {
        method: "POST",
        headers: { Authorization: "" },
      });
      expect(validateRequest(req)).toBe(false);
    });

    it("should reject /api/rpc with malformed Authorization header", () => {
      const req = new Request("http://localhost:33820/api/rpc", {
        method: "POST",
        headers: { Authorization: "Basic abc123" },
      });
      expect(validateRequest(req)).toBe(false);
    });
  });

  describe("validateRequest — WebSocket upgrade", () => {
    it("should reject /ws without token", () => {
      const req = new Request("http://localhost:33820/ws");
      expect(validateRequest(req)).toBe(false);
    });

    it("should accept /ws with valid token in query param", () => {
      const req = new Request(`http://localhost:33820/ws?token=${token}`);
      expect(validateRequest(req)).toBe(true);
    });

    it("should reject /ws with invalid token in query param", () => {
      const req = new Request("http://localhost:33820/ws?token=wrong-token");
      expect(validateRequest(req)).toBe(false);
    });

    it("should accept /ws with valid Bearer token header", () => {
      const req = new Request("http://localhost:33820/ws", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(validateRequest(req)).toBe(true);
    });
  });

  describe("validateRequest — edge cases", () => {
    it("should reject unknown routes without auth", () => {
      const req = new Request("http://localhost:33820/secret/data");
      expect(validateRequest(req)).toBe(false);
    });

    it("should not allow /plugins/evil/../../etc/passwd", () => {
      const req = new Request(
        "http://localhost:33820/plugins/evil/../../etc/passwd"
      );
      expect(validateRequest(req)).toBe(false);
    });

    it("should not allow /plugins/ without app-bundle.js suffix", () => {
      const req = new Request("http://localhost:33820/plugins/my-plugin/");
      expect(validateRequest(req)).toBe(false);
    });
  });
});
