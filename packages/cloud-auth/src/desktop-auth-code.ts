import { createHash, randomBytes } from "node:crypto";

/**
 * Single-use desktop authorization codes: the artifact the Cloud hands back to the desktop loopback
 * listener once GitHub authorization has succeeded.
 *
 * The code is deliberately NOT a session credential. It travels through the browser (and therefore
 * potentially through history, referrer headers, and platform access logs), so it is designed to be
 * worthless to anyone who captures it after the fact:
 *
 *   * short-lived (default 120s),
 *   * single-use (consumption is an atomic database transition),
 *   * bound to the desktop PKCE challenge, so only the process that started the login can redeem it,
 *   * bound to the redirect URI it was issued for,
 *   * stored only as a SHA-256 hash, so a database disclosure yields nothing redeemable.
 */
const DESKTOP_AUTH_CODE_PREFIX = "cfa_";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a fresh high-entropy desktop authorization code (256 bits). */
export function generateDesktopAuthCode(): string {
  return `${DESKTOP_AUTH_CODE_PREFIX}${base64Url(randomBytes(32))}`;
}

/** Hash a desktop authorization code for storage/lookup. Only the hash is ever persisted. */
export function hashDesktopAuthCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function isDesktopAuthCode(value: string): boolean {
  return typeof value === "string" && value.startsWith(DESKTOP_AUTH_CODE_PREFIX);
}
