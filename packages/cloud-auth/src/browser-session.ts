import { createHash, randomBytes } from "node:crypto";

/** Generate the only browser credential ever placed in a cookie; the database stores its hash. */
export function generateBrowserSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBrowserSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
