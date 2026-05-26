import { randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionAuth {
  token: string;
  validateRequest(req: Request): boolean;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createSessionAuth(): SessionAuth {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    validateRequest(req) {
      const url = new URL(req.url);
      const queryToken = url.searchParams.get("token");
      if (queryToken && safeEqual(queryToken, token)) return true;
      const header = req.headers.get("authorization");
      if (header && header.startsWith("Bearer ")) {
        const provided = header.slice("Bearer ".length);
        if (safeEqual(provided, token)) return true;
      }
      return false;
    },
  };
}
