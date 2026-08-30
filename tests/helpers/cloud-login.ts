import { createHash, randomBytes } from "node:crypto";

/**
 * Shared harness for driving the real server-brokered CodeForge Cloud login end to end in tests.
 *
 * It exercises every leg of the production flow — desktop PKCE, `/v1/auth/start`, the GitHub
 * authorization-server callback at `/v1/auth/github/callback`, the 302 to the loopback listener, and
 * the single-use code exchange at `/v1/auth/exchange`. The only thing stubbed is GitHub itself
 * (via an injected `fetchFn` on the server), so the tests still prove the Cloud's own logic.
 */
export interface GitHubProfileFixture {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
  email?: string;
}

export const DEFAULT_GITHUB_PROFILE: GitHubProfileFixture = {
  id: 12345,
  login: "alice",
  name: "Alice",
  avatar_url: "https://example.com/alice.png",
  email: "alice@example.com",
};

/** A `fetch` stand-in that answers GitHub's token and user endpoints. Never reaches the network. */
export function createMockGitHubFetch(profile: GitHubProfileFixture = DEFAULT_GITHUB_PROFILE): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (href.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_mock_token", token_type: "bearer", scope: "read:user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("api.github.com/user")) {
      return new Response(JSON.stringify(profile), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface DesktopPkce {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generate a desktop-owned PKCE pair exactly as the Electron client does. */
export function createDesktopPkce(): DesktopPkce {
  const codeVerifier = base64Url(randomBytes(64)).slice(0, 128);
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export interface CloudLoginTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string; primaryIdentity: string };
  isNewUser: boolean;
}

export interface CloudLoginOptions {
  /** Loopback port the "desktop" claims to be listening on. Defaults to a random ephemeral port. */
  loopbackPort?: number;
  deviceName?: string;
  /** GitHub authorization code the stubbed authorization server hands back. */
  gitHubCode?: string;
  /** Extra headers for every request (used by proxy/trust-proxy tests). */
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export interface CloudLoginStart {
  state: string;
  authUrl: string;
  cloudCallbackUrl: string;
  redirectUri: string;
  pkce: DesktopPkce;
}

/** Leg 1: desktop asks the Cloud to begin an authorization attempt. */
export async function startCloudLogin(baseUrl: string, options: CloudLoginOptions = {}): Promise<CloudLoginStart> {
  const doFetch = options.fetchFn ?? fetch;
  const port = options.loopbackPort ?? 20000 + Math.floor(Math.random() * 40000);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const pkce = createDesktopPkce();

  const res = await doFetch(`${baseUrl}/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify({ redirectUri, codeChallenge: pkce.codeChallenge, deviceName: options.deviceName }),
  });
  if (!res.ok) {
    throw new Error(`auth/start failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { state: string; authUrl: string; cloudCallbackUrl: string };
  return { ...body, redirectUri, pkce };
}

/**
 * Leg 2: the browser follows GitHub's redirect back to the Cloud callback. Returns the single-use
 * desktop authorization code the Cloud put in the `Location` header — i.e. exactly what the loopback
 * listener would observe.
 */
export async function completeGitHubCallback(
  baseUrl: string,
  start: CloudLoginStart,
  options: CloudLoginOptions = {},
): Promise<{ code: string; state: string | null; location: string; status: number }> {
  const doFetch = options.fetchFn ?? fetch;
  const gitHubCode = options.gitHubCode ?? "gh_auth_code_mock";
  const res = await doFetch(`${baseUrl}/v1/auth/github/callback?code=${encodeURIComponent(gitHubCode)}&state=${encodeURIComponent(start.state)}`, {
    redirect: "manual",
    headers: options.headers ?? {},
  });
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || !location) {
    throw new Error(`github callback did not redirect: HTTP ${res.status} ${await res.text()}`);
  }
  const parsed = new URL(location);
  return { code: parsed.searchParams.get("code") ?? "", state: parsed.searchParams.get("state"), location, status: res.status };
}

/** Leg 3: desktop redeems the single-use code with its PKCE verifier. */
export async function exchangeDesktopCode(
  baseUrl: string,
  start: CloudLoginStart,
  code: string,
  options: CloudLoginOptions = {},
): Promise<Response> {
  const doFetch = options.fetchFn ?? fetch;
  return doFetch(`${baseUrl}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: JSON.stringify({
      code,
      codeVerifier: start.pkce.codeVerifier,
      state: start.state,
      redirectUri: start.redirectUri,
    }),
  });
}

/** Run the whole flow and return the minted session. Throws on any non-success leg. */
export async function loginToCloud(baseUrl: string, options: CloudLoginOptions = {}): Promise<CloudLoginTokens & { start: CloudLoginStart; desktopCode: string }> {
  const start = await startCloudLogin(baseUrl, options);
  const { code } = await completeGitHubCallback(baseUrl, start, options);
  const res = await exchangeDesktopCode(baseUrl, start, code, options);
  if (!res.ok) {
    throw new Error(`auth/exchange failed: HTTP ${res.status} ${await res.text()}`);
  }
  const tokens = (await res.json()) as CloudLoginTokens;
  return { ...tokens, start, desktopCode: code };
}
