import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ICloudDatabase,
  GitHubInstallationRecord,
  GitHubRepositoryAuthorizationRecord,
} from "@codeforge/cloud-db";
import { GitHubAppClient, GitHubAppError, type GitHubAppConfiguration } from "./github-app.js";

export const GITHUB_AUTHORIZATION_ERRORS = {
  AUTHORIZATION_STATE_INVALID: "AUTHORIZATION_STATE_INVALID",
  AUTHORIZATION_STATE_EXPIRED: "AUTHORIZATION_STATE_EXPIRED",
  AUTHORIZATION_STATE_REPLAYED: "AUTHORIZATION_STATE_REPLAYED",
  AUTHORIZATION_USER_MISMATCH: "AUTHORIZATION_USER_MISMATCH",
  INSTALLATION_OWNED_BY_OTHER_USER: "INSTALLATION_OWNED_BY_OTHER_USER",
  INSTALLATION_NOT_FOUND: "INSTALLATION_NOT_FOUND",
  INSTALLATION_REVOKED: "INSTALLATION_REVOKED",
  REPOSITORY_NOT_AUTHORIZED: "REPOSITORY_NOT_AUTHORIZED",
  GITHUB_AUTH_FAILED: "GITHUB_AUTH_FAILED",
  GITHUB_TEMPORARY_FAILURE: "GITHUB_TEMPORARY_FAILURE",
} as const;
export type GitHubAuthorizationErrorCode = (typeof GITHUB_AUTHORIZATION_ERRORS)[keyof typeof GITHUB_AUTHORIZATION_ERRORS];

export class GitHubAuthorizationError extends Error {
  constructor(readonly code: GitHubAuthorizationErrorCode, message?: string) {
    super(message ?? code);
    this.name = "GitHubAuthorizationError";
  }
}

export interface GitHubAppAuthorizationConfig {
  db: ICloudDatabase;
  appConfig: GitHubAppConfiguration;
  /** GitHub App installation/setup URL. The `state` query parameter is appended by this service. */
  installationUrl?: string;
  stateTtlSeconds?: number;
  client?: GitHubAppClient;
}

export interface GitHubAppAuthorizationStartResult {
  state: string;
  installationUrl: string;
  expiresInSeconds: number;
}

export interface GitHubAppAuthorizationCallbackResult {
  codeForgeUserId: string;
  installation: GitHubInstallationRecord;
  repositories: GitHubRepositoryAuthorizationRecord[];
}

/** The subset of authorization state that may cross the Cloud boundary to Desktop/UI. */
export interface RepositoryAuthorizationView {
  repositoryId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  authorizationState: GitHubRepositoryAuthorizationRecord["authorizationState"];
  installationStatus: GitHubInstallationRecord["status"];
  authorized: boolean;
  observedAt: string;
}

export interface ResolvedRepositoryAuthorization {
  authorization: GitHubRepositoryAuthorizationRecord;
  installation: GitHubInstallationRecord;
}

function mapGitHubError(error: unknown): never {
  if (error instanceof GitHubAuthorizationError) throw error;
  if (error instanceof GitHubAppError) {
    throw new GitHubAuthorizationError(
      error.code === "GITHUB_TEMPORARY_FAILURE" ? GITHUB_AUTHORIZATION_ERRORS.GITHUB_TEMPORARY_FAILURE : GITHUB_AUTHORIZATION_ERRORS.GITHUB_AUTH_FAILED,
    );
  }
  throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.GITHUB_TEMPORARY_FAILURE);
}

/**
 * CF-11B repository authorization.
 *
 * Identity OAuth (`github-oauth.ts`) stays identity-only; nothing here widens its scopes. Write
 * access is granted exclusively by installing the GitHub App, and the durable grant is keyed on
 * GitHub's immutable numeric repository id — never on owner/name.
 */
export class GitHubAppAuthorizationService {
  private readonly db: ICloudDatabase;
  private readonly installationUrl: string;
  private readonly stateTtlSeconds: number;
  private readonly client: GitHubAppClient;

  constructor(config: GitHubAppAuthorizationConfig) {
    this.db = config.db;
    this.installationUrl = config.installationUrl ?? "https://github.com/apps/codeforge/installations/new";
    this.stateTtlSeconds = config.stateTtlSeconds ?? 600;
    this.client = config.client ?? new GitHubAppClient(config.appConfig);
  }

  /** Step 1: an authenticated user asks for repository authorization; we mint durable one-time state. */
  async startAuthorization(codeForgeUserId: string, deviceSessionId?: string): Promise<GitHubAppAuthorizationStartResult> {
    const state = randomBytes(32).toString("base64url");
    await this.db.createGitHubAppCallbackState({
      state,
      codeForgeUserId,
      ...(deviceSessionId ? { deviceSessionId } : {}),
      expiresInSeconds: this.stateTtlSeconds,
    });
    const url = new URL(this.installationUrl);
    url.searchParams.set("state", state);
    return { state, installationUrl: url.toString(), expiresInSeconds: this.stateTtlSeconds };
  }

  /**
   * Step 2: GitHub redirects back. The state is consumed atomically before anything else runs, so a
   * replayed callback — or an attacker who merely guesses an installation id — cannot authorize.
   * `expectedUserId`, when the callback arrives on an authenticated channel, must match the binding.
   */
  async handleCallback(params: {
    state: string;
    installationId: number;
    expectedUserId?: string;
    deviceSessionId?: string;
  }): Promise<GitHubAppAuthorizationCallbackResult> {
    if (typeof params.state !== "string" || params.state.length < 16 || params.state.length > 512) {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_STATE_INVALID);
    }
    if (!Number.isSafeInteger(params.installationId) || params.installationId <= 0) {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_STATE_INVALID);
    }

    const existing = await this.db.getGitHubAppCallbackState(params.state);
    const consumed = await this.db.consumeGitHubAppCallbackState(params.state);
    if (!consumed) {
      if (!existing) throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_STATE_INVALID);
      if (existing.consumedAt) throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_STATE_REPLAYED);
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_STATE_EXPIRED);
    }

    const codeForgeUserId = consumed.codeForgeUserId;
    if (params.expectedUserId && !constantTimeEquals(params.expectedUserId, codeForgeUserId)) {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_USER_MISMATCH);
    }
    if (consumed.deviceSessionId && params.deviceSessionId && !constantTimeEquals(consumed.deviceSessionId, params.deviceSessionId)) {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.AUTHORIZATION_USER_MISMATCH);
    }

    let installation;
    let repositories;
    try {
      installation = await this.client.getInstallation(params.installationId);
      repositories = await this.client.listInstallationRepositories(params.installationId);
    } catch (error) {
      mapGitHubError(error);
    }

    const record = await this.upsertInstallation(codeForgeUserId, installation);
    const authorizations = await this.syncRepositories(record, repositories);
    return { codeForgeUserId, installation: record, repositories: authorizations };
  }

  /**
   * Resolves the durable grant for a publication. Returns only when the repository id is
   * authorized, its installation is active, and the installation belongs to the calling user.
   */
  async resolveRepositoryAuthorization(codeForgeUserId: string, repositoryId: number): Promise<ResolvedRepositoryAuthorization> {
    const authorization = await this.db.getGitHubRepositoryAuthorization(repositoryId);
    if (!authorization || authorization.authorizationState !== "authorized") {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.REPOSITORY_NOT_AUTHORIZED);
    }
    const installation = await this.db.getGitHubInstallationById(authorization.installationId);
    if (!installation) throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_NOT_FOUND);
    if (installation.codeForgeUserId !== codeForgeUserId) {
      // Deliberately indistinguishable from "not authorized": a caller must not be able to probe
      // which repository ids other accounts have connected.
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.REPOSITORY_NOT_AUTHORIZED);
    }
    if (installation.status !== "active") throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_REVOKED);
    return { authorization, installation };
  }

  /** Credential-free authorization view for Desktop/UI. */
  async describeRepositoryAuthorization(codeForgeUserId: string, repositoryId: number): Promise<RepositoryAuthorizationView | undefined> {
    const authorization = await this.db.getGitHubRepositoryAuthorization(repositoryId);
    if (!authorization) return undefined;
    const installation = await this.db.getGitHubInstallationById(authorization.installationId);
    if (!installation || installation.codeForgeUserId !== codeForgeUserId) return undefined;
    return {
      repositoryId: authorization.repositoryId,
      owner: authorization.owner,
      name: authorization.name,
      fullName: authorization.fullName,
      private: authorization.private,
      authorizationState: authorization.authorizationState,
      installationStatus: installation.status,
      authorized: authorization.authorizationState === "authorized" && installation.status === "active",
      observedAt: authorization.observedAt,
    };
  }

  async listUserInstallations(codeForgeUserId: string): Promise<GitHubInstallationRecord[]> {
    return this.db.listGitHubInstallationsByUser(codeForgeUserId);
  }

  async listUserRepositoryAuthorizations(codeForgeUserId: string): Promise<RepositoryAuthorizationView[]> {
    const installations = await this.db.listGitHubInstallationsByUser(codeForgeUserId);
    const views: RepositoryAuthorizationView[] = [];
    for (const installation of installations) {
      for (const authorization of await this.db.listGitHubRepositoryAuthorizations(installation.id)) {
        views.push({
          repositoryId: authorization.repositoryId,
          owner: authorization.owner,
          name: authorization.name,
          fullName: authorization.fullName,
          private: authorization.private,
          authorizationState: authorization.authorizationState,
          installationStatus: installation.status,
          authorized: authorization.authorizationState === "authorized" && installation.status === "active",
          observedAt: authorization.observedAt,
        });
      }
    }
    return views;
  }

  /** Revocation (App uninstalled or suspended): the installation and every grant under it stop. */
  async revokeInstallation(installationRowId: string): Promise<void> {
    await this.db.updateGitHubInstallationStatus(installationRowId, "revoked");
    for (const authorization of await this.db.listGitHubRepositoryAuthorizations(installationRowId)) {
      await this.db.updateGitHubRepositoryAuthorizationState(authorization.id, "revoked");
    }
  }

  /** Re-reads GitHub's own view and reconciles the durable grants against it. */
  async refreshInstallation(installationRowId: string): Promise<GitHubRepositoryAuthorizationRecord[]> {
    const installation = await this.db.getGitHubInstallationById(installationRowId);
    if (!installation) throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_NOT_FOUND);
    if (installation.status !== "active") throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_REVOKED);
    try {
      const repositories = await this.client.listInstallationRepositories(installation.installationId);
      return await this.syncRepositories(installation, repositories);
    } catch (error) {
      mapGitHubError(error);
    }
  }

  private async upsertInstallation(
    codeForgeUserId: string,
    installation: { id: number; account: { id: number; login: string; type: "User" | "Organization" }; repositorySelection: "all" | "selected" },
  ): Promise<GitHubInstallationRecord> {
    const existing = await this.db.getGitHubInstallationByInstallationId(installation.id);
    if (!existing) {
      return this.db.createGitHubInstallation({
        installationId: installation.id,
        githubAccountId: installation.account.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        codeForgeUserId,
        repositorySelection: installation.repositorySelection,
      });
    }
    if (existing.codeForgeUserId !== codeForgeUserId) {
      throw new GitHubAuthorizationError(GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_OWNED_BY_OTHER_USER);
    }
    await this.db.updateGitHubInstallationAccount({
      id: existing.id,
      githubAccountId: installation.account.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repositorySelection,
    });
    if (existing.status !== "active") await this.db.updateGitHubInstallationStatus(existing.id, "active");
    return (await this.db.getGitHubInstallationById(existing.id))!;
  }

  /**
   * Grants are matched on repository id. A rename updates the cached owner/name on the same row;
   * a repository that disappears from the installation is marked deleted rather than left live.
   */
  private async syncRepositories(
    installation: GitHubInstallationRecord,
    repositories: Array<{ id: number; owner: string; name: string; private: boolean }>,
  ): Promise<GitHubRepositoryAuthorizationRecord[]> {
    const seen = new Set<number>();
    const result: GitHubRepositoryAuthorizationRecord[] = [];

    for (const repository of repositories) {
      seen.add(repository.id);
      const existing = await this.db.getGitHubRepositoryAuthorization(repository.id);
      if (existing) {
        await this.db.updateGitHubRepositoryAuthorizationMetadata({
          id: existing.id,
          installationId: installation.id,
          owner: repository.owner,
          name: repository.name,
          fullName: `${repository.owner}/${repository.name}`,
          private: repository.private,
        });
        if (existing.authorizationState !== "authorized") {
          await this.db.updateGitHubRepositoryAuthorizationState(existing.id, "authorized");
        }
        result.push((await this.db.getGitHubRepositoryAuthorization(repository.id))!);
        continue;
      }
      result.push(await this.db.createGitHubRepositoryAuthorization({
        installationId: installation.id,
        repositoryId: repository.id,
        owner: repository.owner,
        name: repository.name,
        fullName: `${repository.owner}/${repository.name}`,
        private: repository.private,
      }));
    }

    for (const existing of await this.db.listGitHubRepositoryAuthorizations(installation.id)) {
      if (!seen.has(existing.repositoryId) && existing.authorizationState === "authorized") {
        await this.db.updateGitHubRepositoryAuthorizationState(existing.id, "deleted");
      }
    }
    return result;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
