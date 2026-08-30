export interface GitHubAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

export function buildGitHubAuthUrl(options: GitHubAuthUrlOptions): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", options.scope ?? "read:user user:email");
  return url.toString();
}

export interface ExchangeGitHubCodeOptions {
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri?: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export async function exchangeGitHubCode(options: ExchangeGitHubCodeOptions): Promise<{ accessToken: string; tokenType: string; scope: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body: Record<string, string> = {
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
  };
  if (options.clientSecret) body.client_secret = options.clientSecret;
  if (options.redirectUri) body.redirect_uri = options.redirectUri;

  try {
    const res = await fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`GitHub token exchange failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { access_token?: string; token_type?: string; scope?: string; error?: string; error_description?: string };
    if (data.error || !data.access_token) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error || "No access token returned"}`);
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? "bearer",
      scope: data.scope ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface GitHubUserProfile {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
  email?: string;
}

export async function fetchGitHubUserProfile(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<GitHubUserProfile> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "CodeForge-Cloud",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch GitHub user profile: HTTP ${res.status}`);
    }

    return (await res.json()) as GitHubUserProfile;
  } finally {
    clearTimeout(timer);
  }
}
