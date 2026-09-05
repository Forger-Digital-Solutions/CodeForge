export interface RemoteRepositoryIdentity {
  provider: "github";
  owner: string;
  name: string;
  canonical: string;
}

export interface RemotePullRequest {
  number: number;
  id?: string;
  url: string;
  state: "open" | "closed";
  head: string;
  headSha?: string;
  base: string;
}

export interface CreatePullRequestInput {
  repository: RemoteRepositoryIdentity;
  head: string;
  base: string;
  title: string;
  body: string;
  signal?: AbortSignal;
}

/** CF-11 receives only these narrow operations; merge/approval/release authority is absent. */
export interface RemotePullRequestProvider {
  /**
   * Verifies that the narrow publication credential can be obtained before any Git network side
   * effect.  This prevents a locally configured SSH credential from publishing a branch when the
   * separate GitHub API authority is absent.
   */
  assertReady?(signal?: AbortSignal): Promise<void>;
  findOpenPullRequest(repository: RemoteRepositoryIdentity, head: string, base: string, signal?: AbortSignal): Promise<RemotePullRequest | undefined>;
  createPullRequest(input: CreatePullRequestInput): Promise<RemotePullRequest>;
}

export class GitHubClientError extends Error {
  constructor(readonly code: "REMOTE_AUTH_FAILED" | "REMOTE_RATE_LIMITED" | "REMOTE_PROVIDER_UNAVAILABLE" | "REMOTE_PR_CREATE_FAILED", message: string) { super(message); }
}

interface GitHubPullResponse {
  number?: number;
  node_id?: string;
  html_url?: string;
  state?: string;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

function asPullRequest(value: GitHubPullResponse): RemotePullRequest | undefined {
  if (!Number.isInteger(value.number) || !value.html_url || !value.head?.ref || !value.base?.ref) return undefined;
  return { number: value.number!, id: value.node_id, url: value.html_url, state: value.state === "open" ? "open" : "closed", head: value.head.ref, headSha: value.head.sha, base: value.base.ref };
}

/** Minimal HTTP GitHub client. Tokens live only in the caller-provided credential supplier. */
export class GitHubPullRequestClient implements RemotePullRequestProvider {
  constructor(private readonly token: () => Promise<string> | string, private readonly fetchFn: typeof fetch = fetch, private readonly apiBase = "https://api.github.com") {}

  async assertReady(): Promise<void> {
    const token = await this.token();
    if (!token) throw new GitHubClientError("REMOTE_AUTH_FAILED", "GitHub authentication is required");
  }

  async findOpenPullRequest(repository: RemoteRepositoryIdentity, head: string, base: string, signal?: AbortSignal): Promise<RemotePullRequest | undefined> {
    const response = await this.request(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?state=open&head=${encodeURIComponent(`${repository.owner}:${head}`)}&base=${encodeURIComponent(base)}`, { method: "GET", signal });
    const payload = await this.json(response) as GitHubPullResponse[];
    if (!Array.isArray(payload)) throw new GitHubClientError("REMOTE_PR_CREATE_FAILED", "GitHub returned a malformed pull-request list");
    return payload.map(asPullRequest).find((item): item is RemotePullRequest => Boolean(item));
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<RemotePullRequest> {
    const response = await this.request(`/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/pulls`, {
      method: "POST", signal: input.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
    });
    const pull = asPullRequest(await this.json(response) as GitHubPullResponse);
    if (!pull || pull.state !== "open") throw new GitHubClientError("REMOTE_PR_CREATE_FAILED", "GitHub returned a malformed pull request");
    return pull;
  }

  private async request(route: string, init: RequestInit): Promise<Response> {
    const token = await this.token();
    if (!token) throw new GitHubClientError("REMOTE_AUTH_FAILED", "GitHub authentication is required");
    let response: Response;
    try {
      response = await this.fetchFn(new URL(route, this.apiBase).toString(), { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    } catch {
      throw new GitHubClientError("REMOTE_PROVIDER_UNAVAILABLE", "GitHub is unavailable");
    }
    if (response.status === 401 || response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0") throw new GitHubClientError("REMOTE_AUTH_FAILED", "GitHub authentication was rejected");
    if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") throw new GitHubClientError("REMOTE_RATE_LIMITED", "GitHub rate limit reached");
    if (response.status >= 500) throw new GitHubClientError("REMOTE_PROVIDER_UNAVAILABLE", "GitHub is unavailable");
    if (!response.ok) throw new GitHubClientError("REMOTE_PR_CREATE_FAILED", `GitHub pull-request operation failed (${response.status})`);
    return response;
  }

  private async json(response: Response): Promise<unknown> { try { return await response.json(); } catch { throw new GitHubClientError("REMOTE_PR_CREATE_FAILED", "GitHub returned invalid JSON"); } }
}

export function normalizeGitHubRemote(remote: string): RemoteRepositoryIdentity | undefined {
  const trimmed = remote.trim();
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  const match = https ?? ssh;
  if (!match) return undefined;
  const owner = match[1]!; const name = match[2]!;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return undefined;
  return { provider: "github", owner, name, canonical: `github.com/${owner.toLowerCase()}/${name.toLowerCase()}` };
}
