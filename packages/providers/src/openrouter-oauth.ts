/**
 * OpenRouter OAuth PKCE — pure, testable core (no Electron / no sockets).
 *
 * Flow (see docs/research/provider-model-access-2026.md, checked 2026-08-29):
 *   1. generatePkcePair() → { codeVerifier, codeChallenge (S256) }
 *   2. buildAuthUrl({ callbackUrl, codeChallenge, state }) → open in the system browser
 *   3. user authorizes; browser hits callbackUrl?state=…&code=…
 *   4. validate state, then exchangeCodeForKey({ code, codeVerifier }) → user-controlled API key
 *
 * Security properties: cryptographically-random verifier + state, SHA-256/base64url challenge,
 * single-use verifier, state validation, no token/verifier/code logging (callers must not log).
 */

import { randomBytes as nodeRandomBytes, createHash } from "node:crypto";

const AUTH_BASE = "https://openrouter.ai/auth";
const KEYS_ENDPOINT = "https://openrouter.ai/api/v1/auth/keys";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically-random URL-safe token (default 32 bytes → 43 base64url chars). */
export function randomToken(bytes = 32): string {
  return base64Url(nodeRandomBytes(bytes));
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: "S256";
}

/** Generate a PKCE verifier + S256 challenge = base64url(SHA-256(verifier)). */
export async function generatePkcePair(): Promise<PkcePair> {
  const codeVerifier = randomToken(32);
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, method: "S256" };
}

/** Cryptographically-random state for CSRF protection. */
export function generateState(): string {
  return randomToken(24);
}

export interface BuildAuthUrlOptions {
  callbackUrl: string;
  codeChallenge: string;
  state?: string;
  baseUrl?: string;
}

/**
 * Build the OpenRouter authorization URL. State is carried on our own callback URL so we can
 * validate it on return even though it is not a first-class OpenRouter parameter.
 */
export function buildAuthUrl(opts: BuildAuthUrlOptions): string {
  const callback = opts.state
    ? appendQuery(opts.callbackUrl, { state: opts.state })
    : opts.callbackUrl;
  const url = new URL(opts.baseUrl ?? AUTH_BASE);
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function appendQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export class OAuthStateMismatchError extends Error {
  constructor() {
    super("OAuth state mismatch — possible CSRF; authorization rejected");
    this.name = "OAuthStateMismatchError";
  }
}

/**
 * Parse an incoming callback URL, validating state against the expected value.
 * Returns the authorization code. Throws {@link OAuthStateMismatchError} on state mismatch.
 */
export function parseCallback(callbackUrl: string, expectedState: string): string {
  const u = new URL(callbackUrl);
  const gotState = u.searchParams.get("state");
  // If we issued a state, it MUST come back and match.
  if (expectedState && gotState !== expectedState) {
    throw new OAuthStateMismatchError();
  }
  const code = u.searchParams.get("code");
  if (!code) throw new Error("OAuth callback missing authorization code");
  return code;
}

export interface ExchangeOptions {
  code: string;
  codeVerifier: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Exchange the authorization code + PKCE verifier for a user-controlled API key.
 * Returns the key string. Never log the returned value or the inputs.
 */
export async function exchangeCodeForKey(opts: ExchangeOptions): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetchFn(opts.endpoint ?? KEYS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: opts.code,
        code_verifier: opts.codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Do not echo the body verbatim (may include sensitive context); status only.
      throw new Error(`OpenRouter key exchange failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { key?: string };
    if (!data.key || typeof data.key !== "string") {
      throw new Error("OpenRouter key exchange returned no key");
    }
    return data.key;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("OpenRouter key exchange timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
