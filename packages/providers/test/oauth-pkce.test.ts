import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generatePkcePair,
  generateState,
  buildAuthUrl,
  parseCallback,
  exchangeCodeForKey,
  OAuthStateMismatchError,
} from "../src/openrouter-oauth.js";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("OpenRouter OAuth PKCE core", () => {
  it("generates an S256 challenge = base64url(sha256(verifier))", async () => {
    const pair = await generatePkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const expected = b64url(createHash("sha256").update(pair.codeVerifier).digest());
    expect(pair.codeChallenge).toBe(expected);
    // base64url only (no +, /, =)
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique verifiers and states across calls", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(generateState()).not.toBe(generateState());
  });

  it("builds an auth URL with callback, S256 challenge, and carried state", () => {
    const url = buildAuthUrl({ callbackUrl: "http://127.0.0.1:8765/cb", codeChallenge: "CHAL", state: "STATE123" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(u.searchParams.get("callback_url")!);
    expect(callback.searchParams.get("state")).toBe("STATE123");
  });

  it("parseCallback returns the code when state matches", () => {
    const code = parseCallback("http://127.0.0.1:8765/cb?state=S1&code=abc123", "S1");
    expect(code).toBe("abc123");
  });

  it("parseCallback rejects a mismatched state (CSRF protection)", () => {
    expect(() => parseCallback("http://127.0.0.1:8765/cb?state=EVIL&code=abc", "S1")).toThrow(OAuthStateMismatchError);
  });

  it("parseCallback throws when the code is missing", () => {
    expect(() => parseCallback("http://127.0.0.1:8765/cb?state=S1", "S1")).toThrow(/code/);
  });

  it("exchangeCodeForKey posts code + verifier and returns the key", async () => {
    let sentBody: any = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ key: "sk-or-v1-REDACTED" }), { status: 200 });
    }) as unknown as typeof fetch;
    const key = await exchangeCodeForKey({ code: "authcode", codeVerifier: "verifier", fetchFn });
    expect(key).toBe("sk-or-v1-REDACTED");
    expect(sentBody.code).toBe("authcode");
    expect(sentBody.code_verifier).toBe("verifier");
    expect(sentBody.code_challenge_method).toBe("S256");
  });

  it("exchangeCodeForKey throws (status only, no body leak) on HTTP error", async () => {
    const fetchFn = (async () => new Response("secret-context", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCodeForKey({ code: "x", codeVerifier: "y", fetchFn })).rejects.toThrow(/HTTP 400/);
    await expect(exchangeCodeForKey({ code: "x", codeVerifier: "y", fetchFn })).rejects.not.toThrow(/secret-context/);
  });
});
