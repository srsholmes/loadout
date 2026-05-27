import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion, installLegendary } from "./install-legendary";

describe("parseVersion", () => {
  it("pulls the version out of legendary's standard banner", () => {
    expect(parseVersion("legendary version 0.20.34, codename Snowflake"))
      .toBe("0.20.34");
  });

  it("strips a trailing comma when the banner runs together", () => {
    expect(parseVersion("legendary version 0.21.0,")).toBe("0.21.0");
  });

  it("returns the second token when no 'version' keyword is present", () => {
    expect(parseVersion("foo 1.2.3 bar")).toBe("1.2.3");
  });
});

// installLegendary's `resolveRelease` is internal; we exercise it
// through the public function by stubbing fetch + downloadFile and
// asserting which URL was hit. The actual download is mocked into a
// noop write so the test doesn't touch the network.
const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
}
let fetchCalls: FetchCall[] = [];

function stubFetchSequence(handlers: Array<(url: string) => Response>) {
  let i = 0;
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string) => {
    fetchCalls.push({ url });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

let xdgRoot: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), "install-legendary-spec-"));
  process.env.XDG_DATA_HOME = xdgRoot;
  fetchCalls = [];
});

afterEach(async () => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  await rm(xdgRoot, { recursive: true, force: true });
});

describe("installLegendary — resolveRelease", () => {
  const releasePayload = {
    tag_name: "v0.20.34",
    assets: [
      {
        name: "legendary",
        browser_download_url: "https://github.com/x/y/releases/download/v0.20.34/legendary",
        size: 10,
      },
    ],
  };
  function releaseResp(): Response {
    return new Response(JSON.stringify(releasePayload), { status: 200 });
  }
  function binaryResp(): Response {
    return new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5, 6]), {
      status: 200,
      headers: { "content-length": "10" },
    });
  }

  it("hits /releases/latest when no pinnedVersion is set", async () => {
    stubFetchSequence([releaseResp, binaryResp]);
    await installLegendary(() => {}, {}).catch(() => {
      // sanity-check exec fails because /tmp/.../bin/legendary isn't real;
      // we only care about the release lookup URL here.
    });
    expect(fetchCalls[0]?.url).toContain("/releases/latest");
  });

  it("hits /releases/tags/<tag> when pinnedVersion is set", async () => {
    stubFetchSequence([releaseResp, binaryResp]);
    await installLegendary(() => {}, { pinnedVersion: "v0.20.34" }).catch(
      () => {},
    );
    expect(fetchCalls[0]?.url).toContain("/releases/tags/v0.20.34");
  });

  it("falls through to /releases/latest when pinnedVersion === 'latest'", async () => {
    stubFetchSequence([releaseResp, binaryResp]);
    await installLegendary(() => {}, { pinnedVersion: "latest" }).catch(() => {});
    expect(fetchCalls[0]?.url).toContain("/releases/latest");
  });

  it("rejects malformed pinnedVersion before any network call", async () => {
    stubFetchSequence([releaseResp, binaryResp]);
    await expect(
      installLegendary(() => {}, { pinnedVersion: "v0.20.34 && rm -rf /" }),
    ).rejects.toThrow(/malformed/i);
    expect(fetchCalls.length).toBe(0);
  });

  it("throws an actionable error when the pinned tag 404s", async () => {
    stubFetchSequence([() => new Response("not found", { status: 404 })]);
    await expect(
      installLegendary(() => {}, { pinnedVersion: "v999.0.0" }),
    ).rejects.toThrow(/Pinned legendary version "v999.0.0" not found/);
  });
});
