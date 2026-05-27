/**
 * Session Token Authentication
 *
 * Generates a random session token at server startup and validates
 * incoming requests against it. Protects API and WebSocket endpoints
 * from cross-origin attacks while leaving static assets accessible.
 */

let sessionToken: string = "";

/**
 * Generate a new random session token. Call once at server startup.
 * Returns the generated token.
 */
export function generateSessionToken(): string {
  sessionToken = crypto.randomUUID();
  return sessionToken;
}

/**
 * Return the current session token.
 */
export function getSessionToken(): string {
  return sessionToken;
}

/**
 * Extract the token from a request — checks Authorization header first,
 * then falls back to ?token= query parameter.
 */
function extractToken(req: Request): string | null {
  // Check Authorization: Bearer <token> header
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  // Check ?token= query parameter
  try {
    const url = new URL(req.url);
    const tokenParam = url.searchParams.get("token");
    if (tokenParam) {
      return tokenParam;
    }
  } catch {
    // malformed URL
  }

  return null;
}

/**
 * Check whether a request path requires authentication.
 * Static asset routes and the health check are public.
 * API routes and WebSocket upgrades require a valid token.
 */
function isPublicRoute(pathname: string): boolean {
  // Health check and token bootstrap
  if (pathname === "/up") return true;
  if (pathname === "/api/token") return true;

  // Overlay HTML and JS
  if (pathname === "/" || pathname === "/overlay" || pathname === "/overlay/") return true;
  if (pathname === "/overlay/app.js") return true;

  // Plugin app bundles (static JS assets)
  if (/^\/plugins\/[^/]+\/app-bundle\.js$/.test(pathname)) return true;

  // Plugin-bundled static assets (screenshots, icons, fonts, etc.)
  if (/^\/plugins\/[^/]+\/assets\/.+$/.test(pathname)) return true;

  // Inject bundles (SDK + plugin bundles for CEF injection)
  if (pathname.startsWith("/inject/")) return true;

  // Local Steam grid artwork (served from userdata/<id>/config/grid/).
  // Public so plugin frontends can use these URLs in <img src> without
  // round-tripping a query-string token. The route handler itself
  // path-validates the id / userId / type; nothing else under userdata
  // is reachable via this prefix.
  if (
    /^\/api\/steam-grid\/\d+\/(?:\d+\/)?(header|capsule|hero|logo)$/.test(
      pathname,
    )
  )
    return true;

  return false;
}

/**
 * Validate whether a request should be allowed through.
 *
 * - Public routes (static assets, health check) always pass.
 * - API routes require a valid session token via Bearer header or query param.
 * - WebSocket upgrades require a valid token via query param.
 */
export function validateRequest(req: Request): boolean {
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return false;
  }

  // Public routes don't need auth
  if (isPublicRoute(pathname)) {
    return true;
  }

  // Everything else requires a valid token
  const token = extractToken(req);
  return token === sessionToken && sessionToken !== "";
}
