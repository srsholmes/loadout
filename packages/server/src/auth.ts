import { randomBytes } from "node:crypto";

export interface SessionAuth {
  token: string;
  validateRequest(req: Request): boolean;
}

export function createSessionAuth(): SessionAuth {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    validateRequest(req) {
      const url = new URL(req.url);
      const queryToken = url.searchParams.get("token");
      if (queryToken === token) return true;
      const header = req.headers.get("authorization");
      if (header === `Bearer ${token}`) return true;
      return false;
    },
  };
}
