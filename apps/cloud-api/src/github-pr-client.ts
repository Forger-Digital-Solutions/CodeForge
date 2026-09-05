import { PUBLICATION_ERROR_CODES, PublicationError } from "./publication-errors.js";

export interface GitHubPRClientConfig {
  apiBase?: string;
  /** Dependency-injected for tests; production uses global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface PullRequestIdentity {
  number: number;
  url: string;
  nodeId?: string;
  state: string;
  headRef: string;
  baseRef: string;
  headSha?: string;
}

export interface CreatePullRequestRequest {
  owner: string;
  repo: string;
  /** Short branch name of the CodeForge-managed publication ref. */
  head: string;
  base: string;
  title: string;
  body: string;
  /** Only a PR whose head is at this commit may be accepted as ours. */
  expectedHeadSha: string;
  token: string;
}

interface PullRequestPayload {
  number?: number;
  html_url?: string;
  node_id?: string;
  state?: string;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

/**
 * GitHub pull-request execution.
 *
 * Creation is idempotent by reconciliation: the managed head ref is looked up first, so a retry
 * after GitHub accepted a PR but before Cloud committed the result finds that PR instead of
 * opening a second one. Merging is not implemented — there is deliberately no method for it.
 */
export class GitHubPRClient {
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GitHubPRClientConfig = {}) {
    this.apiBase = (config.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  /** Finds an existing PR for the managed head ref, in any state (open, closed, merged). */
  async findByHead(params: { owner: string; repo: string; head: string; token: string }): Promise<PullRequestIdentity | undefined> {
    const query = `?head=${encodeURIComponent(`${params.owner}:${params.head}`)}&state=all&per_page=100`;
    const payload = await this.request(`/repos/${this.segment(params.owner)}/${this.segment(params.repo)}/pulls${query}`, { method: "GET" }, params.token);
    if (!Array.isArray(payload)) throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    for (const entry of payload as PullRequestPayload[]) {
      if (entry.head?.ref === params.head) return this.identity(entry);
    }
    return undefined;
  }

  /**
   * Creates the PR, or returns the one already representing this publication. A GitHub 422 (the
   * "already exists" race) triggers one reconciliation pass rather than a duplicate.
   */
  async createOrReconcile(request: CreatePullRequestRequest): Promise<PullRequestIdentity> {
    const existing = await this.findByHead({ owner: request.owner, repo: request.repo, head: request.head, token: request.token });
    if (existing) return this.assertMatches(existing, request);

    let created: unknown;
    try {
      created = await this.request(
        `/repos/${this.segment(request.owner)}/${this.segment(request.repo)}/pulls`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: request.title, body: request.body, head: request.head, base: request.base }),
        },
        request.token,
      );
    } catch (error) {
      // GitHub rejects a duplicate PR with 422; reconcile instead of failing or retrying blind.
      if (error instanceof PublicationError && error.code === PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED) {
        const reconciled = await this.findByHead({ owner: request.owner, repo: request.repo, head: request.head, token: request.token });
        if (reconciled) return this.assertMatches(reconciled, request);
      }
      throw error;
    }
    return this.assertMatches(this.identity(created as PullRequestPayload), request);
  }

  private assertMatches(pr: PullRequestIdentity, request: CreatePullRequestRequest): PullRequestIdentity {
    if (pr.headRef !== request.head || pr.baseRef !== request.base) throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    if (pr.headSha && pr.headSha !== request.expectedHeadSha) throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    return pr;
  }

  private identity(payload: PullRequestPayload): PullRequestIdentity {
    if (!Number.isSafeInteger(payload.number) || (payload.number ?? 0) <= 0 || !payload.html_url || !payload.head?.ref || !payload.base?.ref) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    }
    let url: URL;
    try {
      url = new URL(payload.html_url);
    } catch {
      throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    return {
      number: payload.number!,
      url: url.toString(),
      nodeId: payload.node_id,
      state: payload.state ?? "unknown",
      headRef: payload.head.ref,
      baseRef: payload.base.ref,
      headSha: payload.head.sha,
    };
  }

  private segment(value: string): string {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    return encodeURIComponent(value);
  }

  /**
   * The token is sent only in the Authorization header and never appears in a thrown message:
   * upstream bodies are discarded and replaced by a fixed code.
   */
  private async request(pathname: string, init: RequestInit, token: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiBase}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Body is read and dropped so the connection is not left dangling, but never surfaced.
      await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) throw new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_AUTH_FAILED);
      if (response.status === 429 || response.status >= 500) throw new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
      throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    }
    try {
      return await response.json();
    } catch {
      throw new PublicationError(PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED);
    }
  }
}
