export interface GitHubAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

/**
 * The three GitHub endpoints the OAuth + profile legs need. Overridable ONLY for dev/test rigs that
 * double the identity provider locally (no production OAuth app exists on a dev machine): production
 * code paths, real PKCE, real token exchange, real profile fetch — only github.com itself is stood
 * in for. configureGitHubEndpoints refuses insecure overrides in production-like deployments.
 */
export interface GitHubEndpoints {
  authorize: string;
  token: string;
  /** Base for /user and /user/emails (no trailing slash). */
  apiBase: string;
}

const DEFAULT_ENDPOINTS: GitHubEndpoints = {
  authorize: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
  apiBase: "https://api.github.com",
};

let endpoints: GitHubEndpoints = DEFAULT_ENDPOINTS;

export function configureGitHubEndpoints(
  next: Partial<GitHubEndpoints> | undefined,
  opts: { productionLike?: boolean } = {},
): void {
  if (!next) {
    endpoints = DEFAULT_ENDPOINTS;
    return;
  }
  const merged = { ...DEFAULT_ENDPOINTS, ...next };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string" && value.startsWith("http://") && opts.productionLike) {
      throw new Error(`Refusing insecure GitHub endpoint override for ${key} in a production-like deployment`);
    }
  }
  endpoints = merged;
}

export function getGitHubEndpoints(): GitHubEndpoints {
  return endpoints;
}

export function buildGitHubAuthUrl(options: GitHubAuthUrlOptions): string {
  const url = new URL(getGitHubEndpoints().authorize);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // `user:email` is required to read the account's authorized email addresses: a GitHub user's
  // profile `email` field is null whenever their email is not public, which is the common case.
  // Requesting the scope does not silently escalate anything — GitHub shows the expanded consent
  // to the user, and when it is not granted the email endpoint simply fails and CodeForge falls
  // back to a truthful "email not shared" state.
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
    const res = await fetchFn(getGitHubEndpoints().token, {
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
    const res = await fetchFn(`${getGitHubEndpoints().apiBase}/user`, {
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

export interface GitHubUserEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
}

/**
 * Best authorized email for display: the primary verified address if GitHub reports one, then any
 * verified address, then the primary address, then nothing. Unverified addresses are never shown —
 * an unverified address could be anything the user typed, not an address they control.
 */
export function selectGitHubAuthorizedEmail(emails: GitHubUserEmail[]): string | null {
  const primaryVerified = emails.find((e) => e.primary && e.verified);
  if (primaryVerified) return primaryVerified.email;
  const verified = emails.find((e) => e.verified);
  if (verified) return verified.email;
  const primary = emails.find((e) => e.primary);
  return primary?.email ?? null;
}

/**
 * Fetch the authenticated account's authorized email addresses. Requires the `user:email` scope;
 * when that scope was not granted (or the endpoint fails), this throws and the caller must fall
 * back to the profile's public email — never guess an address.
 */
export async function fetchGitHubUserEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<GitHubUserEmail[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(`${getGitHubEndpoints().apiBase}/user/emails`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "CodeForge-Cloud",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch GitHub user emails: HTTP ${res.status}`);
    }

    const data = (await res.json()) as GitHubUserEmail[];
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}
