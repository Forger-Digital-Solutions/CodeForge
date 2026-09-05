import crypto from "node:crypto";

export const GITHUB_PUBLICATION_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

export interface GitHubAppConfiguration {
  appId: string;
  privateKeyPem: string;
  apiBase?: string;
  now?: () => Date;
  /** Bounded upstream call timeout. Prevents an unresponsive GitHub from pinning an executor. */
  requestTimeoutMs?: number;
}

export interface GitHubInstallationAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
}

export interface GitHubInstallation {
  id: number;
  account: GitHubInstallationAccount;
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspendedAt?: string | null;
}

export interface GitHubInstallationRepository {
  id: number;
  nodeId?: string;
  owner: string;
  name: string;
  private: boolean;
}

export interface EphemeralInstallationToken {
  token: string;
  expiresAt: string;
  repositoryId: number;
  permissions: typeof GITHUB_PUBLICATION_PERMISSIONS;
}

export type GitHubAppErrorCode =
  | "GITHUB_APP_CONFIG_INVALID"
  | "GITHUB_INSTALLATION_INVALID"
  | "GITHUB_INSTALLATION_SUSPENDED"
  | "GITHUB_INSTALLATION_PERMISSION_INSUFFICIENT"
  | "GITHUB_INSTALLATION_REPOSITORY_UNAUTHORIZED"
  | "GITHUB_INSTALLATION_TOKEN_FAILED"
  | "GITHUB_TEMPORARY_FAILURE";

export class GitHubAppError extends Error {
  constructor(readonly code: GitHubAppErrorCode, message: string) {
    super(message);
    this.name = "GitHubAppError";
  }
}

const encode = (value: string) => Buffer.from(value).toString("base64url");

/** A short-lived RS256 GitHub App assertion. The key is consumed only in Cloud process memory. */
export function createGitHubAppJwt(config: GitHubAppConfiguration): string {
  if (!/^\d+$/.test(config.appId) || !config.privateKeyPem.includes("BEGIN") || config.privateKeyPem.length > 20_000) throw new GitHubAppError("GITHUB_APP_CONFIG_INVALID", "Invalid GitHub App configuration");
  const now = Math.floor((config.now?.().getTime() ?? Date.now()) / 1000);
  const body = `${encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }))}`;
  try {
    const signer = crypto.createSign("RSA-SHA256"); signer.update(body); signer.end();
    return `${body}.${signer.sign(config.privateKeyPem, "base64url")}`;
  } catch {
    throw new GitHubAppError("GITHUB_APP_CONFIG_INVALID", "Invalid GitHub App private key");
  }
}

interface InstallationPayload {
  id?: number;
  account?: { id?: number; login?: string; type?: string };
  repository_selection?: string;
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}
interface RepositoryPayload { id?: number; node_id?: string; name?: string; private?: boolean; owner?: { login?: string } }

const MAX_REPOSITORY_PAGES = 20;

/**
 * The single Cloud-side credential broker. Nothing outside this class ever sees the App private
 * key, the App JWT, or an installation access token; callers receive only the short-lived token
 * value they must use immediately and discard.
 */
export class GitHubAppClient {
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly configuration: GitHubAppConfiguration, private readonly fetchFn: typeof fetch = fetch) {
    this.apiBase = configuration.apiBase ?? "https://api.github.com";
    this.requestTimeoutMs = configuration.requestTimeoutMs ?? 20_000;
  }

  async getInstallation(installationId: number): Promise<GitHubInstallation> {
    const data = await this.request(`/app/installations/${this.id(installationId)}`, { method: "GET" }) as InstallationPayload;
    if (
      !Number.isSafeInteger(data.id) || (data.id ?? 0) <= 0 ||
      !Number.isSafeInteger(data.account?.id) || (data.account?.id ?? 0) <= 0 ||
      !data.account?.login ||
      (data.account.type !== "User" && data.account.type !== "Organization") ||
      (data.repository_selection !== "all" && data.repository_selection !== "selected") ||
      !data.permissions
    ) throw new GitHubAppError("GITHUB_INSTALLATION_INVALID", "GitHub returned malformed installation metadata");
    if (data.suspended_at) throw new GitHubAppError("GITHUB_INSTALLATION_SUSPENDED", "GitHub App installation is suspended");
    return {
      id: data.id!,
      account: { id: data.account.id!, login: data.account.login, type: data.account.type },
      repositorySelection: data.repository_selection,
      permissions: data.permissions,
      suspendedAt: data.suspended_at ?? null,
    };
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubInstallationRepository[]> {
    const id = this.id(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const data = await this.request(`/app/installations/${id}/repositories?per_page=100&page=${page}`, { method: "GET" }) as { repositories?: RepositoryPayload[] };
      if (!Array.isArray(data.repositories)) throw new GitHubAppError("GITHUB_INSTALLATION_INVALID", "GitHub returned malformed installation repositories");
      repositories.push(...data.repositories.map((item) => this.repository(item)));
      if (data.repositories.length < 100) break;
    }
    return repositories;
  }

  /**
   * Mints a token scoped to exactly one repository id with only `contents:write` and
   * `pull_requests:write`. The repository is re-checked against the live installation first, so a
   * stale durable authorization row alone can never widen access.
   */
  async mintRepositoryToken(installationId: number, repository: { id: number }): Promise<EphemeralInstallationToken> {
    const installation = await this.getInstallation(installationId);
    if (installation.permissions.contents !== "write" || installation.permissions.pull_requests !== "write") throw new GitHubAppError("GITHUB_INSTALLATION_PERMISSION_INSUFFICIENT", "GitHub App lacks publication permissions");
    const visible = await this.listInstallationRepositories(installationId);
    if (!visible.some((item) => item.id === repository.id)) throw new GitHubAppError("GITHUB_INSTALLATION_REPOSITORY_UNAUTHORIZED", "Repository is not authorized by this installation");
    const data = await this.request(`/app/installations/${this.id(installationId)}/access_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_ids: [repository.id], permissions: GITHUB_PUBLICATION_PERMISSIONS }),
    }) as { token?: string; expires_at?: string; permissions?: Record<string, string> };
    if (!data.token || !data.expires_at || Number.isNaN(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now() || data.permissions?.contents !== "write" || data.permissions?.pull_requests !== "write") throw new GitHubAppError("GITHUB_INSTALLATION_TOKEN_FAILED", "GitHub returned an invalid installation token");
    return { token: data.token, expiresAt: data.expires_at, repositoryId: repository.id, permissions: GITHUB_PUBLICATION_PERMISSIONS };
  }

  private id(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new GitHubAppError("GITHUB_INSTALLATION_INVALID", "Invalid installation identifier"); return value; }
  private repository(data: RepositoryPayload): GitHubInstallationRepository { if (!Number.isSafeInteger(data.id) || (data.id ?? 0) <= 0 || !data.owner?.login || !data.name || typeof data.private !== "boolean") throw new GitHubAppError("GITHUB_INSTALLATION_INVALID", "GitHub returned malformed repository metadata"); return { id: data.id!, nodeId: data.node_id, owner: data.owner.login, name: data.name, private: data.private }; }

  /**
   * Every upstream failure is collapsed into a fixed code and message. Neither the JWT nor GitHub's
   * response body (which can echo an Authorization header) is ever surfaced to a caller.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      response = await this.fetchFn(new URL(path, this.apiBase).toString(), {
        ...init,
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${createGitHubAppJwt(this.configuration)}`, ...(init.headers ?? {}) },
      });
    } catch (error) {
      if (error instanceof GitHubAppError) throw error;
      throw new GitHubAppError("GITHUB_TEMPORARY_FAILURE", "GitHub App request failed");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new GitHubAppError("GITHUB_INSTALLATION_INVALID", `GitHub App request rejected (${response.status})`);
      if (response.status === 429 || response.status >= 500) throw new GitHubAppError("GITHUB_TEMPORARY_FAILURE", `GitHub App request failed (${response.status})`);
      throw new GitHubAppError("GITHUB_INSTALLATION_TOKEN_FAILED", `GitHub App request failed (${response.status})`);
    }
    try { return await response.json(); } catch { throw new GitHubAppError("GITHUB_INSTALLATION_TOKEN_FAILED", "GitHub App returned invalid JSON"); }
  }
}
