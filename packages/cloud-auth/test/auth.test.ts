import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import {
  AuthService,
  buildCloudGitHubCallbackUrl,
  generatePkcePair,
  hashDesktopAuthCode,
  normalizeDesktopLoopbackRedirectUri,
  signAccessToken,
  verifyAccessToken,
  CLOUD_GITHUB_CALLBACK_PATH,
} from "../src/index.js";

const PUBLIC_URL = "https://cloud.codeforge.test";
const LOOPBACK = "http://127.0.0.1:8765/auth/callback";

describe("AuthService — server-brokered GitHub OAuth", () => {
  let db: CloudDatabase;
  let auth: AuthService;
  const jwtSecret = "super-secret-jwt-key-32-chars-long";

  const createMockGitHubFetch = (profile = { id: 12345, login: "alice", name: "Alice", avatar_url: "https://example.com/alice.png", email: "alice@example.com" }) => {
    return async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_mock_access_token_123", token_type: "bearer", scope: "read:user user:email" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("api.github.com/user")) {
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };
  };

  /** Drive the full flow the way the desktop + browser do, returning every intermediate artifact. */
  async function fullLogin(opts: { redirectUri?: string; deviceName?: string } = {}) {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({
      redirectUri: opts.redirectUri ?? LOOPBACK,
      codeChallenge: pkce.codeChallenge,
      deviceName: opts.deviceName,
    });
    const callback = await auth.handleGitHubCallback({ code: "gh_code", state: start.state });
    const desktopCode = new URL(callback.redirectTo).searchParams.get("code")!;
    const session = await auth.exchangeDesktopAuthCode({
      code: desktopCode,
      codeVerifier: pkce.codeVerifier,
      redirectUri: opts.redirectUri ?? LOOPBACK,
    });
    return { pkce, start, callback, desktopCode, session };
  }

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    auth = new AuthService({
      db,
      jwtSecret,
      gitHubClientId: "gh_client_test_id",
      gitHubClientSecret: "gh_client_test_secret",
      publicUrl: PUBLIC_URL,
      fetchFn: createMockGitHubFetch() as typeof fetch,
    });
  });

  afterEach(() => {
    db.close();
  });

  // --- Architecture: the three callbacks are distinct ------------------------------------------

  it("sends GitHub the fixed public Cloud callback, never the ephemeral desktop loopback", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });

    const authUrl = new URL(start.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://github.com/login/oauth/authorize");

    const sentRedirect = authUrl.searchParams.get("redirect_uri");
    expect(sentRedirect).toBe(`${PUBLIC_URL}${CLOUD_GITHUB_CALLBACK_PATH}`);
    expect(sentRedirect).toBe(start.cloudCallbackUrl);
    // The loopback (and its port) must never be handed to the authorization server — GitHub matches
    // registered callbacks by host AND port, so an ephemeral port could never be registered.
    expect(start.authUrl).not.toContain("127.0.0.1");
    expect(start.authUrl).not.toContain("8765");
  });

  it("never returns the server-owned GitHub PKCE verifier to the client", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });

    expect(Object.keys(start).sort()).toEqual(["authUrl", "cloudCallbackUrl", "state"]);
    expect(JSON.stringify(start)).not.toContain("codeVerifier");

    // The verifier exists, but only in server-side storage.
    const tx = await db.getOAuthTransaction(start.state);
    expect(tx?.gitHubCodeVerifier).toBeTruthy();
    expect(start.authUrl).not.toContain(tx!.gitHubCodeVerifier!);
    // The challenge stored against the transaction is the DESKTOP's, not GitHub's.
    expect(tx?.codeChallenge).toBe(pkce.codeChallenge);
  });

  it("derives the registered GitHub callback purely from server configuration", () => {
    expect(auth.getCloudGitHubCallbackUrl()).toBe(`${PUBLIC_URL}${CLOUD_GITHUB_CALLBACK_PATH}`);
    expect(buildCloudGitHubCallbackUrl("https://example.org/")).toBe(`https://example.org${CLOUD_GITHUB_CALLBACK_PATH}`);
    expect(() => buildCloudGitHubCallbackUrl("http://evil.example.com")).toThrow(/HTTPS/);
    expect(() => buildCloudGitHubCallbackUrl("https://u:p@example.org")).toThrow(/credentials/);
  });

  it("fails closed when no public URL is configured", async () => {
    const unconfigured = new AuthService({ db, jwtSecret, gitHubClientId: "id", fetchFn: createMockGitHubFetch() as typeof fetch });
    const pkce = generatePkcePair();
    await expect(unconfigured.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge })).rejects.toThrow(/CODEFORGE_PUBLIC_URL/);
  });

  // --- Happy path -------------------------------------------------------------------------------

  it("completes the full flow and grants the initial Free tier allowance", async () => {
    const { callback, session } = await fullLogin({ deviceName: "Test Device" });

    expect(callback.redirectTo.startsWith(`${LOOPBACK}?`)).toBe(true);
    expect(session.isNewUser).toBe(true);
    expect(session.user.displayName).toBe("Alice");
    expect(session.accessToken).toBeDefined();
    expect(session.refreshToken).toBeDefined();

    const account = await auth.getAccount(session.user.id);
    expect(account.planId).toBe("free");
    expect(account.creditBalance).toBe(500_000);
    expect(account.entitlements.some((e) => e.featureKey === "HOSTED_FREE")).toBe(true);
  });

  it("puts only a single-use code — never a session credential — in the loopback redirect", async () => {
    const { callback, session, desktopCode } = await fullLogin();
    const target = new URL(callback.redirectTo);

    // The redirect carries exactly two parameters and neither is a token.
    expect([...target.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(callback.redirectTo).not.toContain(session.accessToken);
    expect(callback.redirectTo).not.toContain(session.refreshToken);
    expect(callback.redirectTo).not.toContain("gho_");

    // Only the code's hash is persisted, so a database disclosure yields nothing redeemable.
    const stored = await db.getDesktopAuthCode(hashDesktopAuthCode(desktopCode));
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(desktopCode);
  });

  // --- Open redirect / loopback policy ----------------------------------------------------------

  it("refuses every non-canonical redirect target at OAuth start", async () => {
    const pkce = generatePkcePair();
    const hostile = [
      "https://attacker.example/auth/callback",
      "http://localhost:8765/auth/callback",
      "http://127.0.0.1:8765/other",
      "http://127.0.0.1:8765/auth/callback/",
      "http://127.0.0.1/auth/callback",
      "http://127.0.0.1:0/auth/callback",
      "http://127.0.0.1:1/auth/callback",
      "http://127.0.0.1:80/auth/callback",
      "http://127.0.0.1:65536/auth/callback",
      "https://127.0.0.1:8765/auth/callback",
      "http://[::1]:8765/auth/callback",
      "http://127.0.0.1.evil.example.com:8765/auth/callback",
      "http://user@127.0.0.1:8765/auth/callback",
      "http://127.0.0.1@evil.example.com:8765/auth/callback",
      "http://192.168.1.10:8765/auth/callback",
      "http://10.0.0.5:8765/auth/callback",
      "//evil.example.com/auth/callback",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///auth/callback",
      "ftp://127.0.0.1:8765/auth/callback",
      "http://127.0.0.1:8765/auth/callback?next=https://evil.example",
      "http://127.0.0.1:8765/auth/callback#https://evil.example",
      "http://127.0.0.1:8765/auth/../auth/callback/../../evil",
      "http://127.0.0.1:8765/auth/callback%2f..%2f..",
      "http://127.0.0.1:8765/auth/callback%252f..",
      "http://127.0.0.1%2eevil.example.com:8765/auth/callback",
    ];

    for (const redirectUri of hostile) {
      await expect(
        auth.startOAuth({ redirectUri, codeChallenge: pkce.codeChallenge }),
        `expected rejection for ${redirectUri}`,
      ).rejects.toThrow();
    }
  });

  it("rejects CRLF and control characters in the redirect target", () => {
    const crlf = `http://127.0.0.1:8765/auth/callback${String.fromCharCode(13)}${String.fromCharCode(10)}X-Injected: 1`;
    expect(() => normalizeDesktopLoopbackRedirectUri(crlf)).toThrow(/control characters/);
    expect(() => normalizeDesktopLoopbackRedirectUri(`http://127.0.0.1:8765/auth/callback${String.fromCharCode(0)}`)).toThrow(/control characters/);
  });

  it("accepts the full ephemeral port range and canonicalizes the stored target", () => {
    for (const port of [1024, 49152, 55000, 65535]) {
      expect(normalizeDesktopLoopbackRedirectUri(`http://127.0.0.1:${port}/auth/callback`)).toBe(`http://127.0.0.1:${port}/auth/callback`);
    }
    expect(() => normalizeDesktopLoopbackRedirectUri("http://127.0.0.1:1023/auth/callback")).toThrow(/non-privileged/);
  });

  it("redirects only to the stored target — callback input cannot steer the browser", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:49152/auth/callback", codeChallenge: pkce.codeChallenge });

    // handleGitHubCallback takes ONLY code + state; there is no redirect parameter to poison.
    const callback = await auth.handleGitHubCallback({ code: "gh_code", state: start.state });
    expect(new URL(callback.redirectTo).host).toBe("127.0.0.1:49152");
  });

  // --- State / PKCE / replay --------------------------------------------------------------------

  it("rejects unknown, tampered, and replayed OAuth state", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });

    await expect(auth.handleGitHubCallback({ code: "c", state: "wrong_state" })).rejects.toThrow(/not found/);
    await expect(auth.handleGitHubCallback({ code: "c", state: `${start.state}x` })).rejects.toThrow(/not found/);
    await expect(auth.handleGitHubCallback({ code: "", state: start.state })).rejects.toThrow(/missing/);

    await auth.handleGitHubCallback({ code: "c", state: start.state });
    await expect(auth.handleGitHubCallback({ code: "c", state: start.state })).rejects.toThrow(/already consumed/);
  });

  it("binds the desktop code to the desktop PKCE verifier", async () => {
    const pkce = generatePkcePair();
    const other = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });
    const callback = await auth.handleGitHubCallback({ code: "c", state: start.state });
    const code = new URL(callback.redirectTo).searchParams.get("code")!;

    await expect(auth.exchangeDesktopAuthCode({ code, codeVerifier: other.codeVerifier })).rejects.toThrow(/PKCE/);
  });

  it("rejects a desktop code exchanged against a different redirect binding", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: "http://127.0.0.1:49152/auth/callback", codeChallenge: pkce.codeChallenge });
    const callback = await auth.handleGitHubCallback({ code: "c", state: start.state });
    const code = new URL(callback.redirectTo).searchParams.get("code")!;

    await expect(
      auth.exchangeDesktopAuthCode({ code, codeVerifier: pkce.codeVerifier, redirectUri: "http://127.0.0.1:49999/auth/callback" }),
    ).rejects.toThrow(/redirect URI mismatch/);
  });

  it("rejects tampered and unknown desktop codes", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });
    const callback = await auth.handleGitHubCallback({ code: "c", state: start.state });
    const code = new URL(callback.redirectTo).searchParams.get("code")!;

    await expect(auth.exchangeDesktopAuthCode({ code: `${code}x`, codeVerifier: pkce.codeVerifier })).rejects.toThrow(/not found/);
    await expect(auth.exchangeDesktopAuthCode({ code: "cfa_totally_made_up", codeVerifier: pkce.codeVerifier })).rejects.toThrow(/not found/);
    await expect(auth.exchangeDesktopAuthCode({ code: "", codeVerifier: pkce.codeVerifier })).rejects.toThrow(/required/);
  });

  it("makes desktop codes single-use", async () => {
    const { desktopCode, pkce } = await fullLogin();
    await expect(auth.exchangeDesktopAuthCode({ code: desktopCode, codeVerifier: pkce.codeVerifier })).rejects.toThrow(/already consumed/);
  });

  it("expires desktop codes", async () => {
    const shortLived = new AuthService({
      db,
      jwtSecret,
      gitHubClientId: "gh_client_test_id",
      gitHubClientSecret: "gh_client_test_secret",
      publicUrl: PUBLIC_URL,
      desktopAuthCodeExpiresInSeconds: -1, // already expired when minted
      fetchFn: createMockGitHubFetch() as typeof fetch,
    });
    const pkce = generatePkcePair();
    const start = await shortLived.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });
    const callback = await shortLived.handleGitHubCallback({ code: "c", state: start.state });
    const code = new URL(callback.redirectTo).searchParams.get("code")!;

    await expect(shortLived.exchangeDesktopAuthCode({ code, codeVerifier: pkce.codeVerifier })).rejects.toThrow(/expired/);
  });

  it("lets exactly one of N concurrent exchanges of the same code win", async () => {
    const pkce = generatePkcePair();
    const start = await auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: pkce.codeChallenge });
    const callback = await auth.handleGitHubCallback({ code: "c", state: start.state });
    const code = new URL(callback.redirectTo).searchParams.get("code")!;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => auth.exchangeDesktopAuthCode({ code, codeVerifier: pkce.codeVerifier })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });

  it("requires a plausible S256 challenge to start an attempt", async () => {
    for (const bad of ["", "short", "!".repeat(64), "a".repeat(129)]) {
      await expect(auth.startOAuth({ redirectUri: LOOPBACK, codeChallenge: bad })).rejects.toThrow(/code_challenge/);
    }
  });

  // --- Session lifecycle ------------------------------------------------------------------------

  it("rotates refresh tokens and detects reuse", async () => {
    const { session } = await fullLogin();

    const rotated = await auth.refreshSession({ refreshToken: session.refreshToken });
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    const payload = auth.verifyToken(rotated.accessToken);
    expect(payload.sub).toBe(session.user.id);

    await expect(auth.refreshSession({ refreshToken: session.refreshToken })).rejects.toThrow(/replay detected/);
  });

  it("revokes the device session on logout", async () => {
    const { session } = await fullLogin();
    await auth.logout(session.refreshToken);
    await expect(auth.refreshSession({ refreshToken: session.refreshToken })).rejects.toThrow(/revoked/);
  });

  it("returns the same account for a repeat login and does not re-provision", async () => {
    const first = await fullLogin();
    const second = await fullLogin();
    expect(second.session.user.id).toBe(first.session.user.id);
    expect(second.session.isNewUser).toBe(false);

    const account = await auth.getAccount(second.session.user.id);
    expect(account.creditBalance).toBe(500_000);
  });

  it("verifies and rejects tampered or expired JWT access tokens", () => {
    const token = signAccessToken({ sub: "user-123", sid: "sess-456", planId: "free", displayName: "User" }, jwtSecret, 3600);

    const verified = verifyAccessToken(token, jwtSecret);
    expect(verified.sub).toBe("user-123");
    expect(verified.sid).toBe("sess-456");

    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tamperedSignature`;
    expect(() => verifyAccessToken(tampered, jwtSecret)).toThrow(/Invalid JWT signature/);

    const expiredToken = signAccessToken({ sub: "user-123", sid: "sess-456" }, jwtSecret, -10);
    expect(() => verifyAccessToken(expiredToken, jwtSecret)).toThrow(/expired/);
  });
});
