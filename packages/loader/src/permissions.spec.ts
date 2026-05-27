import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createSandboxedFetch,
  isDomainAllowed,
} from "./sandboxed-fetch";
import { withSandboxedFetch } from "./plugin-manager";

describe("isDomainAllowed", () => {
  it("allows exact domain match", () => {
    expect(isDomainAllowed("example.com", ["example.com"])).toBe(true);
  });

  it("allows subdomain of allowed domain", () => {
    expect(isDomainAllowed("api.example.com", ["example.com"])).toBe(true);
  });

  it("rejects unrelated domain", () => {
    expect(isDomainAllowed("evil.com", ["example.com"])).toBe(false);
  });

  it("rejects domain that shares suffix but is not a subdomain", () => {
    expect(isDomainAllowed("notexample.com", ["example.com"])).toBe(false);
  });

  it("returns false for empty allowed list", () => {
    expect(isDomainAllowed("anything.com", [])).toBe(false);
  });

  // Audit A-020: plugins shouldn't need to list both `localhost` and
  // `127.0.0.1` — they describe the same loopback host.
  it("treats 127.0.0.1 and localhost as aliases", () => {
    expect(isDomainAllowed("127.0.0.1", ["localhost"])).toBe(true);
    expect(isDomainAllowed("localhost", ["127.0.0.1"])).toBe(true);
    expect(isDomainAllowed("::1", ["localhost"])).toBe(true);
    expect(isDomainAllowed("localhost", ["::1"])).toBe(true);
  });

  it("does not treat non-loopback hosts as loopback aliases", () => {
    expect(isDomainAllowed("evil.com", ["localhost"])).toBe(false);
    expect(isDomainAllowed("127.0.0.2", ["localhost"])).toBe(false);
  });
});

describe("createSandboxedFetch", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("allows fetch to a declared domain", async () => {
    const sandboxed = createSandboxedFetch("test-plugin", {
      network: ["icanhazdadjoke.com"],
    });

    // Should not throw — the domain is allowed.
    // The actual fetch may fail due to mocked globalThis.fetch, but
    // the permission check itself should pass without throwing.
    let permissionError = false;
    try {
      await sandboxed("https://icanhazdadjoke.com/");
    } catch (err) {
      if ((err as Error).message.includes("[permissions]")) {
        permissionError = true;
      }
      // Other errors (network, mock) are fine — we only care about permission checks
    }
    expect(permissionError).toBe(false);
  });

  it("blocks fetch when no permissions are declared", async () => {
    const sandboxed = createSandboxedFetch("no-perms-plugin", undefined);

    try {
      await sandboxed("https://evil.com/steal-data");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("no-perms-plugin");
      expect(msg).toContain("evil.com");
      expect(msg).toContain("no network permissions declared");
      expect(msg).toContain("permissions");
    }

    expect(warnSpy).toHaveBeenCalled();
  });

  it("blocks fetch when network permissions is an empty array", async () => {
    const sandboxed = createSandboxedFetch("empty-perms-plugin", {
      network: [],
    });

    try {
      await sandboxed("https://example.com/api");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("empty-perms-plugin");
      expect(msg).toContain("no network permissions declared");
    }
  });

  it("blocks fetch to undeclared domain with clear error", async () => {
    const sandboxed = createSandboxedFetch("limited-plugin", {
      network: ["allowed.com"],
    });

    try {
      await sandboxed("https://blocked.com/secret");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("limited-plugin");
      expect(msg).toContain("blocked.com");
      expect(msg).toContain("not in its allowed domains");
      expect(msg).toContain("allowed.com");
      expect(msg).toContain('Add "blocked.com"');
    }

    expect(warnSpy).toHaveBeenCalled();
  });

  // Audit A-020: plugins that ship with `network: ["localhost"]` should
  // be able to reach `http://127.0.0.1:<port>/…` (and vice versa) without
  // an extra entry. Only the permission check matters; the underlying
  // fetch is allowed to fail for network reasons.
  it("allows fetch to 127.0.0.1 when permission is 'localhost'", async () => {
    const sandboxed = createSandboxedFetch("loopback-plugin", {
      network: ["localhost"],
    });

    let permissionError = false;
    try {
      await sandboxed("http://127.0.0.1:33820/x");
    } catch (err) {
      if ((err as Error).message.includes("[permissions]")) {
        permissionError = true;
      }
    }
    expect(permissionError).toBe(false);

    permissionError = false;
    try {
      await sandboxed("http://localhost:33820/x");
    } catch (err) {
      if ((err as Error).message.includes("[permissions]")) {
        permissionError = true;
      }
    }
    expect(permissionError).toBe(false);
  });

  it("allows fetch to a subdomain of a declared domain", async () => {
    const sandboxed = createSandboxedFetch("sub-plugin", {
      network: ["example.com"],
    });

    let permissionError = false;
    try {
      await sandboxed("https://api.example.com/data");
    } catch (err) {
      if ((err as Error).message.includes("[permissions]")) {
        permissionError = true;
      }
    }
    expect(permissionError).toBe(false);
  });

  it("works with URL objects", async () => {
    const sandboxed = createSandboxedFetch("url-plugin", {
      network: ["allowed.com"],
    });

    try {
      await sandboxed(new URL("https://blocked.com/test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("blocked.com");
    }
  });

  it("works with Request objects", async () => {
    const sandboxed = createSandboxedFetch("req-plugin", {
      network: ["allowed.com"],
    });

    try {
      await sandboxed(new Request("https://blocked.com/test"));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("blocked.com");
    }
  });
});

describe("withSandboxedFetch", () => {
  it("scopes fetch so bare fetch() calls go through sandbox", async () => {
    const sandboxed = createSandboxedFetch("scoped-plugin", {
      network: ["allowed-only.com"],
    });

    let caught = false;
    await withSandboxedFetch(sandboxed, async () => {
      try {
        await fetch("https://unauthorized.com/data");
      } catch (err) {
        caught = true;
        expect((err as Error).message).toContain("unauthorized.com");
        expect((err as Error).message).toContain("scoped-plugin");
      }
    });

    expect(caught).toBe(true);
  });

  it("allows sandboxed fetch for permitted domains", async () => {
    const sandboxed = createSandboxedFetch("ok-plugin", {
      network: ["example.com"],
    });

    let permissionError = false;
    await withSandboxedFetch(sandboxed, async () => {
      try {
        await fetch("https://example.com/api");
      } catch (err) {
        if ((err as Error).message.includes("[permissions]")) {
          permissionError = true;
        }
      }
    });

    expect(permissionError).toBe(false);
  });

  it("restores context even if the function throws", async () => {
    const sandboxed = createSandboxedFetch("throw-plugin", { network: [] });

    try {
      await withSandboxedFetch(sandboxed, () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // After the throw, bare fetch should not be sandboxed by throw-plugin
    let caughtPermissionError = false;
    try {
      await fetch("https://example.com");
    } catch (err) {
      if ((err as Error).message.includes("throw-plugin")) {
        caughtPermissionError = true;
      }
    }
    expect(caughtPermissionError).toBe(false);
  });
});
