import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createPublicationArtifact, type PublicationArtifact } from "./publication-artifact.js";
import type { ChangeDelivery } from "./delivery-state.js";
import type { WorkspaceService } from "./workspace-service.js";

const execFile = promisify(execFileCallback);

export const CLOUD_PUBLICATION_ERRORS = {
  CLOUD_NOT_CONFIGURED: "CLOUD_NOT_CONFIGURED",
  CLOUD_IDENTITY_REQUIRED: "CLOUD_IDENTITY_REQUIRED",
  DELIVERY_NOT_LOCAL_READY: "DELIVERY_NOT_LOCAL_READY",
  REMOTE_NOT_CONFIGURED: "REMOTE_NOT_CONFIGURED",
  REMOTE_UNSUPPORTED: "REMOTE_UNSUPPORTED",
  REPOSITORY_AUTHORIZATION_REQUIRED: "REPOSITORY_AUTHORIZATION_REQUIRED",
  CLOUD_REQUEST_FAILED: "CLOUD_REQUEST_FAILED",
  PUBLICATION_TIMEOUT: "PUBLICATION_TIMEOUT",
} as const;
export type CloudPublicationErrorCode = (typeof CLOUD_PUBLICATION_ERRORS)[keyof typeof CLOUD_PUBLICATION_ERRORS];

export class CloudPublicationError extends Error {
  constructor(readonly code: CloudPublicationErrorCode | string, readonly status?: number) {
    super(code);
    this.name = "CloudPublicationError";
  }
}

export type CloudPublicationState =
  | "awaiting_artifact"
  | "artifact_uploaded"
  | "validating"
  | "validated"
  | "waiting_for_lease"
  | "authorizing"
  | "checking_target"
  | "pushing"
  | "pushed"
  | "creating_pr"
  | "pr_created"
  | "completed"
  | "failed_retryable"
  | "failed_permanent"
  | "authorization_revoked"
  | "target_diverged";

export interface CloudPublicationReceipt {
  publicationId: string;
  deliveryId: string;
  repositoryFullName: string;
  targetBranch: string;
  publishedCommit: string;
  publishedTree: string;
  publicationRef: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  completedAt: string;
}

/** Exactly the Cloud-authoritative view. Desktop adds nothing of its own to a publication result. */
export interface CloudPublicationView {
  id: string;
  deliveryId: string;
  repositoryId: number;
  targetBranch: string;
  certifiedHead: string;
  certifiedTree: string;
  state: CloudPublicationState;
  pushRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  errorCode?: string;
  attemptCount: number;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  receipt?: CloudPublicationReceipt;
}

export interface RepositoryAuthorizationView {
  repositoryId: number;
  owner: string;
  name: string;
  fullName: string;
  authorized: boolean;
  authorizationState: string;
  installationStatus?: string;
}

export interface CloudPublicationClientConfig {
  cloudApiUrl: string;
  /** Cloud identity token. Returns undefined when the user is not signed in to CodeForge Cloud. */
  getAuthToken: () => string | undefined | Promise<string | undefined>;
  workspaceService: WorkspaceService;
  getDelivery: (id: string) => ChangeDelivery | undefined;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

export const TERMINAL_CLOUD_PUBLICATION_STATES: readonly CloudPublicationState[] = [
  "completed",
  "failed_permanent",
  "authorization_revoked",
  "target_diverged",
];

/**
 * Desktop's entire share of CF-11B publication.
 *
 * It certifies locally (CF-10), packages the certified commit as a bounded read-only Git bundle,
 * hands that to Cloud, and then only observes. It never obtains an installation token, never pushes
 * to GitHub, never creates a pull request, and never reports success from local Git: the terminal
 * state always comes from the Cloud record.
 */
export class CloudPublicationClient {
  private readonly cloudApiUrl: string;
  private readonly getAuthToken: CloudPublicationClientConfig["getAuthToken"];
  private readonly workspaceService: WorkspaceService;
  private readonly getDelivery: (id: string) => ChangeDelivery | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(config: CloudPublicationClientConfig) {
    this.cloudApiUrl = config.cloudApiUrl.replace(/\/$/, "");
    this.getAuthToken = config.getAuthToken;
    this.workspaceService = config.workspaceService;
    this.getDelivery = config.getDelivery;
    this.fetchFn = config.fetchFn ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
  }

  /** Which repository (by immutable GitHub id) Cloud will accept for this delivery's workspace. */
  async resolveRepositoryAuthorization(deliveryId: string): Promise<RepositoryAuthorizationView> {
    const delivery = this.assertDelivery(deliveryId);
    const workspace = this.workspaceService.getWorkspace(delivery.deliveryWorkspaceId ?? delivery.workspaceId);
    if (!workspace) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const identity = await this.readOriginIdentity(workspace.rootPath);
    const authorizations = await this.request<RepositoryAuthorizationView[]>("/v1/github-app/repositories", { method: "GET" });
    const match = authorizations.find((item) => item.authorized && item.fullName.toLowerCase() === identity.fullName.toLowerCase());
    if (!match) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.REPOSITORY_AUTHORIZATION_REQUIRED, 403);
    return match;
  }

  /**
   * Creates the Cloud publication, uploads the bundle, and asks Cloud to execute. The returned
   * view is Cloud's, not Desktop's.
   */
  async publishDelivery(deliveryId: string): Promise<CloudPublicationView> {
    const delivery = this.assertDelivery(deliveryId);
    const workspace = this.workspaceService.getWorkspace(delivery.deliveryWorkspaceId ?? delivery.workspaceId);
    if (!workspace || !delivery.deliveryRevision || !delivery.deliveryTree || !delivery.commits.length) {
      throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    }
    const targetWorkspace = this.workspaceService.getWorkspace(delivery.workspaceId);
    const targetBranch = targetWorkspace?.branch;
    if (!targetBranch) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);

    const repository = await this.resolveRepositoryAuthorization(deliveryId);
    const targetSha = await this.readDeliveryBase(workspace.rootPath, delivery);

    // The bundle carries the certified commit and nothing else; it is created read-only from the
    // delivery worktree and held only in memory until the upload completes.
    const artifact = await createPublicationArtifact({
      workspacePath: workspace.rootPath,
      publicationId: delivery.id,
      deliveryId: delivery.id,
      missionId: delivery.missionId,
      repository: repository.fullName,
      targetRef: targetBranch,
      targetSha,
      certifiedHead: delivery.deliveryRevision,
      certifiedTree: delivery.deliveryTree,
    });

    try {
      const created = await this.request<CloudPublicationView>("/v1/publications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId: delivery.id,
          repositoryId: repository.repositoryId,
          targetBranch,
          baseSha: targetSha,
          targetSha,
          certifiedHead: delivery.deliveryRevision,
          certifiedTree: delivery.deliveryTree,
          artifactSha256: artifact.manifest.sha256,
          artifactBytes: artifact.manifest.bytes,
        }),
      });

      if (created.state === "awaiting_artifact") await this.uploadArtifact(created.id, artifact);
      return await this.request<CloudPublicationView>(`/v1/publications/${encodeURIComponent(created.id)}/execute`, { method: "POST" });
    } finally {
      // Drop the local artifact reference as soon as the upload boundary is crossed.
      (artifact as { bundle: Uint8Array }).bundle = new Uint8Array(0);
    }
  }

  async getStatus(publicationId: string): Promise<CloudPublicationView> {
    return this.request<CloudPublicationView>(`/v1/publications/${encodeURIComponent(publicationId)}`, { method: "GET" });
  }

  async retry(publicationId: string): Promise<CloudPublicationView> {
    return this.request<CloudPublicationView>(`/v1/publications/${encodeURIComponent(publicationId)}/retry`, { method: "POST" });
  }

  /** Bounded polling: it always terminates, either on a Cloud terminal state or on the deadline. */
  async awaitCompletion(publicationId: string, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<CloudPublicationView> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus(publicationId);
      if (TERMINAL_CLOUD_PUBLICATION_STATES.includes(status.state)) return status;
      if (Date.now() + pollIntervalMs > deadline) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.PUBLICATION_TIMEOUT);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async uploadArtifact(publicationId: string, artifact: PublicationArtifact): Promise<void> {
    await this.request<unknown>(`/v1/publications/${encodeURIComponent(publicationId)}/artifact`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(artifact.manifest.bytes) },
      body: Buffer.from(artifact.bundle) as unknown as RequestInit["body"],
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getAuthToken();
    if (!token) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.CLOUD_IDENTITY_REQUIRED, 401);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.cloudApiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.CLOUD_REQUEST_FAILED);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let code: string = CLOUD_PUBLICATION_ERRORS.CLOUD_REQUEST_FAILED;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
        else if (typeof parsed.error === "string") code = parsed.error;
      } catch {
        // Never surface an unparsed Cloud body: it is not part of the contract.
      }
      throw new CloudPublicationError(code, response.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private assertDelivery(id: string): ChangeDelivery {
    const delivery = this.getDelivery(id);
    if (!delivery || delivery.status !== "ready") throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    return delivery;
  }

  private async readOriginIdentity(cwd: string): Promise<{ owner: string; name: string; fullName: string }> {
    const remotes = (await this.git(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes("origin")) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.REMOTE_NOT_CONFIGURED);
    const url = (await this.git(cwd, ["remote", "get-url", "origin"])).trim();
    const match = url.match(/github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
    if (!match) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.REMOTE_UNSUPPORTED);
    // Only a hint: Cloud answers with repository ids the user actually authorized, so a tampered
    // origin cannot widen anything.
    return { owner: match[1]!, name: match[2]!, fullName: `${match[1]}/${match[2]}` };
  }

  private async readDeliveryBase(cwd: string, delivery: ChangeDelivery): Promise<string> {
    const first = delivery.commits[0]?.sha;
    if (!first) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    return (await this.git(cwd, ["rev-parse", `${first}^`])).trim();
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFile("git", args, { cwd, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    return stdout;
  }
}

export function createCloudPublicationClient(config: CloudPublicationClientConfig): CloudPublicationClient {
  return new CloudPublicationClient(config);
}
