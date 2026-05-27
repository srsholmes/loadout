import type { PluginPermissions } from "@loadout/types";

// Capture the real fetch once at module load — before any sandboxing
const originalFetch = globalThis.fetch;

/**
 * Create a sandboxed fetch function that only allows requests to domains
 * listed in the plugin's `permissions.network` array.
 *
 * If no network permissions are declared (undefined or empty array),
 * ALL network requests are blocked.
 */
export function createSandboxedFetch(
  pluginId: string,
  permissions: PluginPermissions | undefined,
): typeof globalThis.fetch {
  const allowedDomains = permissions?.network ?? [];

  const sandboxedFetch = function sandboxedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveUrl(input);

    if (!url) {
      return Promise.reject(
        new Error(
          `[permissions] Plugin "${pluginId}" attempted a network request with an invalid URL.`,
        ),
      );
    }

    const hostname = url.hostname;

    if (!isDomainAllowed(hostname, allowedDomains)) {
      const msg =
        allowedDomains.length === 0
          ? `[permissions] Plugin "${pluginId}" attempted to fetch "${hostname}" but has no network permissions declared. ` +
            `Add "permissions": { "network": ["${hostname}"] } to plugin.json to allow this request.`
          : `[permissions] Plugin "${pluginId}" attempted to fetch "${hostname}" which is not in its allowed domains [${allowedDomains.join(", ")}]. ` +
            `Add "${hostname}" to the "permissions.network" array in plugin.json to allow this request.`;

      console.warn(msg);
      return Promise.reject(new Error(msg));
    }

    // Always call the real fetch, not globalThis.fetch (which may be swapped)
    return originalFetch(input, init);
  };

  // Bun's fetch type includes a static `preconnect` method — carry it through
  // so that the sandboxed version satisfies `typeof globalThis.fetch`.
  sandboxedFetch.preconnect = originalFetch.preconnect;

  return sandboxedFetch as typeof globalThis.fetch;
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input);
    }
    if (input instanceof URL) {
      return input;
    }
    // Request object
    return new URL(input.url);
  } catch {
    return null;
  }
}

// Audit A-020: plugins that declare `network: ["localhost"]` previously
// got blocked when the URL used the `127.0.0.1` literal (and vice versa).
// Treat the two as the same loopback host so plugin authors don't have to
// list both.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Check whether a hostname matches any of the allowed domain patterns.
 * Supports exact match, subdomain matching (e.g. "example.com" allows
 * "api.example.com"), and loopback aliasing (`localhost` ↔ `127.0.0.1` ↔ `::1`).
 */
function isDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const isLoopbackHost = LOOPBACK_HOSTS.has(hostname);
  for (const domain of allowedDomains) {
    if (hostname === domain) return true;
    if (hostname.endsWith(`.${domain}`)) return true;
    if (isLoopbackHost && LOOPBACK_HOSTS.has(domain)) return true;
  }
  return false;
}

export { isDomainAllowed, resolveUrl };
