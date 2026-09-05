import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ICloudDatabase, PublicationRecord, PublicationState, PublicationLease } from "@codeforge/cloud-db";
import {
  GitHubAppAuthorizationService,
  GitHubAppClient,
  GitHubAppError,
  GitHubAuthorizationError,
  GITHUB_AUTHORIZATION_ERRORS,
  type GitHubAppConfiguration,
} from "@codeforge/cloud-auth";
import { PublicationArtifactStore, MAX_PUBLICATION_ARTIFACT_BYTES } from "./artifact-store.js";
import { CloudPublicationMaterializer, isSafeBranchName } from "./publication-executor.js";
import { GitTransportService, publicationRefFor } from "./git-transport.js";
import { GitHubPRClient } from "./github-pr-client.js";
import { PUBLICATION_ERROR_CODES, PublicationError, type PublicationErrorCode } from "./publication-errors.js";

export interface PublicationServiceConfig {
  db: ICloudDatabase;
  authorization: GitHubAppAuthorizationService;
  appConfig: GitHubAppConfiguration;
  artifactStorageDir?: string;
  maxArtifactBytes?: number;
  leaseDurationMs?: number;
  /** Identifies this API/worker process in the durable lease. */
  workerId?: string;
  githubWebBase?: string;
  githubApiBase?: string;
  /** Test seam: maps durable repository identity to a controlled bare remote. */
  resolveRemoteUrl?: (repository: { repositoryId: number; owner: string; name: string }) => string;
  transport?: GitTransportService;
  pullRequests?: GitHubPRClient;
  tokenBroker?: Pick<GitHubAppClient, "mintRepositoryToken">;
  materializer?: CloudPublicationMaterializer;
  artifactStore?: PublicationArtifactStore;
  /** Test seam: invoked after each named side-effect boundary so crashes can be simulated. */
  onBoundary?: (boundary: PublicationBoundary, publication: PublicationRecord) => Promise<void> | void;
}

export type PublicationBoundary = "artifact_stored" | "validated" | "authorized" | "pushed" | "pr_created";

export interface CreatePublicationInput {
  deliveryId: string;
  repositoryId: number;
  targetBranch: string;
  baseSha: string;
  targetSha: string;
  certifiedHead: string;
  certifiedTree: string;
  artifactSha256: string;
  artifactBytes: number;
}

/** Everything a client is ever allowed to see. No credential, no path, no Git output. */
export interface PublicationView {
  id: string;
  deliveryId: string;
  repositoryId: number;
  targetBranch: string;
  certifiedHead: string;
  certifiedTree: string;
  artifactSha256: string;
  artifactBytes: number;
  artifactState: PublicationRecord["artifactState"];
  state: PublicationState;
  pushRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  errorCode?: PublicationErrorCode | string;
  attemptCount: number;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  receipt?: PublicationReceipt;
}

/** The Cloud-authoritative record of what was published. Derived only from durable state. */
export interface PublicationReceipt {
  publicationId: string;
  deliveryId: string;
  repositoryId: number;
  repositoryFullName: string;
  targetBranch: string;
  certifiedTargetSha: string;
  publishedCommit: string;
  publishedTree: string;
  publicationRef: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  completedAt: string;
}

const TERMINAL_STATES: ReadonlySet<PublicationState> = new Set<PublicationState>([
  "completed",
  "failed_permanent",
  "authorization_revoked",
  "target_diverged",
]);

const RETRYABLE_STATES: ReadonlySet<PublicationState> = new Set<PublicationState>([
  "failed_retryable",
]);

/**
 * Cloud-authoritative publication execution.
 *
 * The trust boundary lives entirely inside this class: Desktop supplies a bounded artifact and safe
 * metadata, and every privileged decision — repository authorization, token minting, remote target
 * re-check, push, PR — happens here, under a durable DB lease with a fencing token.
 */
export class PublicationService {
  private readonly db: ICloudDatabase;
  private readonly authorization: GitHubAppAuthorizationService;
  private readonly artifactStore: PublicationArtifactStore;
  private readonly materializer: CloudPublicationMaterializer;
  private readonly transport: GitTransportService;
  private readonly pullRequests: GitHubPRClient;
  private readonly tokenBroker: Pick<GitHubAppClient, "mintRepositoryToken">;
  private readonly leaseDurationMs: number;
  private readonly workerId: string;
  private readonly maxArtifactBytes: number;
  private readonly githubWebBase: string;
  private readonly resolveRemoteUrl?: PublicationServiceConfig["resolveRemoteUrl"];
  private readonly onBoundary?: PublicationServiceConfig["onBoundary"];

  constructor(config: PublicationServiceConfig) {
    this.db = config.db;
    this.authorization = config.authorization;
    this.maxArtifactBytes = config.maxArtifactBytes ?? MAX_PUBLICATION_ARTIFACT_BYTES;
    this.artifactStore = config.artifactStore ?? new PublicationArtifactStore({
      rootDir: config.artifactStorageDir ?? path.join(os.tmpdir(), "codeforge-publication-artifacts"),
      maxBytes: this.maxArtifactBytes,
    });
    this.materializer = config.materializer ?? new CloudPublicationMaterializer();
    this.transport = config.transport ?? new GitTransportService();
    this.pullRequests = config.pullRequests ?? new GitHubPRClient({ apiBase: config.githubApiBase });
    this.tokenBroker = config.tokenBroker ?? new GitHubAppClient(config.appConfig);
    this.leaseDurationMs = config.leaseDurationMs ?? 5 * 60 * 1000;
    this.workerId = config.workerId ?? `cloud-api-${randomUUID()}`;
    this.githubWebBase = (config.githubWebBase ?? "https://github.com").replace(/\/$/, "");
    this.resolveRemoteUrl = config.resolveRemoteUrl;
    this.onBoundary = config.onBoundary;
  }

  async init(): Promise<void> {
    await this.artifactStore.init();
  }

  // --- Creation -------------------------------------------------------------------------------

  /**
   * Creates a publication for a certified delivery. Repeating the request for the same
   * (user, delivery) returns the existing record when the certified identity is unchanged and a
   * stable conflict otherwise — a client retry can never fan out into two remote operations.
   */
  async createPublication(userId: string, input: CreatePublicationInput): Promise<PublicationRecord> {
    this.assertSha(input.baseSha, PUBLICATION_ERROR_CODES.ARTIFACT_METADATA_MISMATCH);
    this.assertSha(input.targetSha, PUBLICATION_ERROR_CODES.TARGET_COMMIT_MISSING);
    this.assertSha(input.certifiedHead, PUBLICATION_ERROR_CODES.CERTIFIED_COMMIT_MISMATCH);
    this.assertSha(input.certifiedTree, PUBLICATION_ERROR_CODES.CERTIFIED_TREE_MISMATCH);
    if (!/^[0-9a-f]{64}$/.test(input.artifactSha256)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH);
    if (!Number.isSafeInteger(input.artifactBytes) || input.artifactBytes <= 0) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
    if (input.artifactBytes > this.maxArtifactBytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_TOO_LARGE);
    if (!isSafeBranchName(input.targetBranch)) throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
    if (!input.deliveryId || input.deliveryId.length > 200 || /[\r\n\0]/.test(input.deliveryId)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_METADATA_MISMATCH);
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new PublicationError(PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED);

    // Authorization is resolved from the durable grant keyed on the immutable repository id, and
    // must belong to the calling user.
    const resolved = await this.resolveAuthorization(userId, input.repositoryId);

    const existing = await this.db.getPublicationByDeliveryId(userId, input.deliveryId);
    if (existing) {
      const sameIdentity =
        existing.repositoryId === input.repositoryId &&
        existing.certifiedHead === input.certifiedHead &&
        existing.certifiedTree === input.certifiedTree &&
        existing.targetBranch === input.targetBranch &&
        existing.targetSha === input.targetSha &&
        existing.artifactSha256 === input.artifactSha256 &&
        existing.artifactBytes === input.artifactBytes;
      if (!sameIdentity) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_IDEMPOTENCY_CONFLICT);
      return existing;
    }

    return this.db.createPublication({
      deliveryId: input.deliveryId,
      userId,
      repositoryId: input.repositoryId,
      installationId: resolved.installation.id,
      targetBranch: input.targetBranch,
      baseSha: input.baseSha,
      targetSha: input.targetSha,
      certifiedHead: input.certifiedHead,
      certifiedTree: input.certifiedTree,
      artifactSha256: input.artifactSha256,
      artifactBytes: input.artifactBytes,
    });
  }

  // --- Artifact upload ------------------------------------------------------------------------

  /**
   * Streams the bundle into bounded storage. The declared length and digest are enforced during the
   * stream, and the durable transition to `artifact_uploaded` only happens once the artifact is
   * atomically in place — a partial upload is deleted and leaves the publication unexecutable.
   */
  async uploadArtifact(userId: string, publicationId: string, source: AsyncIterable<Uint8Array> | Readable): Promise<PublicationView> {
    const publication = await this.requireOwned(userId, publicationId);
    if (publication.artifactState === "stored" || publication.state !== "awaiting_artifact") {
      throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_ALREADY_STORED);
    }
    const stored = await this.artifactStore.store({
      publicationId: publication.id,
      expectedBytes: publication.artifactBytes,
      expectedSha256: publication.artifactSha256,
      source,
    });
    const marked = await this.db.markPublicationArtifactStored({ publicationId: publication.id, artifactKey: stored.key });
    if (!marked) {
      await this.artifactStore.delete(stored.key);
      throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_ALREADY_STORED);
    }
    const updated = (await this.db.getPublicationById(publication.id))!;
    await this.onBoundary?.("artifact_stored", updated);
    return this.toView(updated);
  }

  // --- Status ---------------------------------------------------------------------------------

  async getStatus(userId: string, publicationId: string): Promise<PublicationView> {
    return this.toView(await this.requireOwned(userId, publicationId));
  }

  async listForUser(userId: string): Promise<PublicationView[]> {
    const records = await this.db.listPublicationsByUser(userId);
    return Promise.all(records.map((record) => this.toView(record)));
  }

  // --- Execution ------------------------------------------------------------------------------

  /** Idempotent: a completed publication is returned untouched, and only one worker may execute. */
  async execute(userId: string, publicationId: string): Promise<PublicationView> {
    const publication = await this.requireOwned(userId, publicationId);
    if (publication.state === "completed") return this.toView(publication);
    if (publication.artifactState !== "stored") throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_MISSING);
    if (TERMINAL_STATES.has(publication.state)) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_NOT_RETRYABLE);
    return this.runExecution(publication);
  }

  async retry(userId: string, publicationId: string): Promise<PublicationView> {
    const publication = await this.requireOwned(userId, publicationId);
    if (publication.state === "completed") return this.toView(publication);
    if (!RETRYABLE_STATES.has(publication.state) && publication.state !== "failed_retryable") {
      throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_NOT_RETRYABLE);
    }
    if (publication.artifactState !== "stored") throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_MISSING);
    return this.runExecution(publication, { allowTerminalRestart: true });
  }

  /**
   * Restart reconciliation. Publications whose lease expired mid-flight are re-driven from durable
   * state; nothing is reconstructed from logs and no token is persisted for recovery.
   */
  async recoverAbandonedPublications(limit = 10): Promise<PublicationView[]> {
    const stale = await this.db.listReclaimablePublications(new Date().toISOString());
    const results: PublicationView[] = [];
    for (const record of stale.slice(0, limit)) {
      try {
        results.push(await this.runExecution(record));
      } catch {
        results.push(this.toViewSync((await this.db.getPublicationById(record.id)) ?? record));
      }
    }
    return results;
  }

  private async runExecution(publication: PublicationRecord, options: { allowTerminalRestart?: boolean } = {}): Promise<PublicationView> {
    if (options.allowTerminalRestart) await this.db.incrementPublicationAttempt(publication.id);

    const lease = await this.db.acquirePublicationLease({
      publicationId: publication.id,
      owner: `${this.workerId}:${randomUUID()}`,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!lease) {
      const current = (await this.db.getPublicationById(publication.id)) ?? publication;
      if (current.state === "completed") return this.toView(current);
      throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_UNAVAILABLE);
    }

    try {
      await this.executeUnderLease(publication.id, lease);
    } catch (error) {
      await this.recordFailure(publication.id, lease, error);
    } finally {
      // A stale worker's release is itself fenced, so it cannot clear a newer owner's lease.
      await this.db.releasePublicationLease({ publicationId: lease.publicationId, owner: lease.owner, fence: lease.fence });
    }
    const finalRecord = (await this.db.getPublicationById(publication.id))!;
    return this.toView(finalRecord);
  }

  private async executeUnderLease(publicationId: string, lease: PublicationLease): Promise<void> {
    const publication = (await this.db.getPublicationById(publicationId))!;
    if (publication.state === "completed") return;

    // 1. Authorization is re-resolved under the lease: a revocation between create and execute
    //    stops the publication before any credential is minted.
    const resolved = await this.resolveAuthorization(publication.userId, publication.repositoryId);
    if (resolved.installation.id !== publication.installationId) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED);
    }

    // 2. Verify the artifact in a disposable bare repository. No checkout, no hooks, no execution.
    await this.transition(lease, "validating");
    const key = publication.artifactKey ?? this.artifactStore.keyForPublication(publication.id);
    const bundle = await this.artifactStore.read(key, { bytes: publication.artifactBytes, sha256: publication.artifactSha256 });

    const remoteUrl = this.remoteUrlFor({ repositoryId: resolved.authorization.repositoryId, owner: resolved.authorization.owner, name: resolved.authorization.name });
    const pushRef = publicationRefFor(publication.id);

    let pushed: { remoteSha: string; alreadyPresent: boolean } | undefined;

    await this.materializer.verify({
      manifest: {
        version: 1,
        publicationId: publication.id,
        deliveryId: publication.deliveryId,
        targetRef: publication.targetBranch,
        targetSha: publication.targetSha,
        certifiedHead: publication.certifiedHead,
        certifiedTree: publication.certifiedTree,
        bytes: publication.artifactBytes,
        sha256: publication.artifactSha256,
      },
      bundle,
      maxBytes: this.maxArtifactBytes,
      withRepository: async (bareRepositoryPath) => {
        await this.transition(lease, "validated");
        await this.onBoundary?.("validated", (await this.db.getPublicationById(publication.id))!);

        // 3. Mint the repository-scoped, least-privilege token. It exists only in this scope.
        await this.transition(lease, "authorizing");
        await this.renew(lease);
        let token: string;
        try {
          const minted = await this.tokenBroker.mintRepositoryToken(resolved.installation.installationId, { id: resolved.authorization.repositoryId });
          token = minted.token;
        } catch (error) {
          throw this.mapGitHubAppError(error);
        }
        await this.onBoundary?.("authorized", (await this.db.getPublicationById(publication.id))!);

        // 4. Push. The transport re-checks the remote target immediately before mutating.
        await this.transition(lease, "checking_target");
        await this.transition(lease, "pushing");
        const result = await this.transport.publishCertifiedCommit({
          sourceRepositoryPath: bareRepositoryPath,
          remoteUrl,
          token,
          certifiedHead: publication.certifiedHead,
          pushRef,
          targetBranch: publication.targetBranch,
          expectedTargetSha: publication.targetSha,
        });
        pushed = { remoteSha: result.remoteSha, alreadyPresent: result.alreadyPresent };

        if (!(await this.db.recordPublicationPush({ publicationId: publication.id, owner: lease.owner, fence: lease.fence, pushRef: result.pushRef }))) {
          throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE);
        }
        await this.onBoundary?.("pushed", (await this.db.getPublicationById(publication.id))!);

        // 5. Create or reconcile exactly one PR against the certified target branch.
        await this.transition(lease, "creating_pr");
        await this.renew(lease);
        const head = pushRef.slice("refs/heads/".length);
        const pr = await this.pullRequests.createOrReconcile({
          owner: resolved.authorization.owner,
          repo: resolved.authorization.name,
          head,
          base: publication.targetBranch,
          title: `CodeForge delivery ${publication.deliveryId}`,
          body: [
            "Published by CodeForge Cloud from a certified delivery.",
            "",
            `Publication: ${publication.id}`,
            `Delivery: ${publication.deliveryId}`,
            `Certified commit: ${publication.certifiedHead}`,
            `Certified tree: ${publication.certifiedTree}`,
            `Target branch: ${publication.targetBranch} @ ${publication.targetSha}`,
          ].join("\n"),
          expectedHeadSha: publication.certifiedHead,
          token,
        });
        if (!(await this.db.recordPublicationPullRequest({
          publicationId: publication.id,
          owner: lease.owner,
          fence: lease.fence,
          pullRequestNumber: pr.number,
          pullRequestUrl: pr.url,
          ...(pr.nodeId ? { pullRequestNodeId: pr.nodeId } : {}),
        }))) {
          throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE);
        }
        await this.onBoundary?.("pr_created", (await this.db.getPublicationById(publication.id))!);
      },
    });

    if (!pushed) throw new PublicationError(PUBLICATION_ERROR_CODES.GIT_PUSH_REJECTED);

    // 6. Completion is itself fenced and requires both durable side effects to be recorded.
    if (!(await this.db.completePublication({ publicationId: publication.id, owner: lease.owner, fence: lease.fence }))) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE);
    }
    // The bundle has served its purpose; only Git objects on GitHub remain.
    await this.artifactStore.delete(key);
  }

  private async transition(lease: PublicationLease, state: PublicationState): Promise<void> {
    const ok = await this.db.updatePublicationState({ publicationId: lease.publicationId, owner: lease.owner, fence: lease.fence, state });
    if (!ok) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE);
  }

  private async renew(lease: PublicationLease): Promise<void> {
    const ok = await this.db.renewPublicationLease({ publicationId: lease.publicationId, owner: lease.owner, fence: lease.fence, leaseDurationMs: this.leaseDurationMs });
    if (!ok) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE);
  }

  private async recordFailure(publicationId: string, lease: PublicationLease, error: unknown): Promise<void> {
    const code = this.classify(error);
    // A stale worker records nothing: the fence check inside updatePublicationState rejects it.
    if (code === PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_STALE) return;
    const state = this.stateForFailure(code);
    await this.db.updatePublicationState({ publicationId, owner: lease.owner, fence: lease.fence, state, errorCode: code, failureReason: code });
  }

  private stateForFailure(code: PublicationErrorCode): PublicationState {
    if (code === PUBLICATION_ERROR_CODES.PROMOTION_TARGET_DIVERGED) return "target_diverged";
    if (code === PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED || code === PUBLICATION_ERROR_CODES.INSTALLATION_REVOKED) return "authorization_revoked";
    if (
      code === PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE ||
      code === PUBLICATION_ERROR_CODES.GIT_PUSH_REJECTED ||
      code === PUBLICATION_ERROR_CODES.PULL_REQUEST_RECONCILIATION_FAILED ||
      code === PUBLICATION_ERROR_CODES.PUBLICATION_LEASE_UNAVAILABLE ||
      code === PUBLICATION_ERROR_CODES.GITHUB_AUTH_FAILED
    ) return "failed_retryable";
    return "failed_permanent";
  }

  private classify(error: unknown): PublicationErrorCode {
    if (error instanceof PublicationError) return error.code;
    if (error instanceof GitHubAuthorizationError) return this.mapAuthorizationCode(error.code);
    if (error instanceof GitHubAppError) return (this.mapGitHubAppError(error)).code;
    return PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE;
  }

  private mapAuthorizationCode(code: string): PublicationErrorCode {
    switch (code) {
      case GITHUB_AUTHORIZATION_ERRORS.REPOSITORY_NOT_AUTHORIZED:
        return PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED;
      case GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_REVOKED:
        return PUBLICATION_ERROR_CODES.INSTALLATION_REVOKED;
      case GITHUB_AUTHORIZATION_ERRORS.INSTALLATION_NOT_FOUND:
        return PUBLICATION_ERROR_CODES.INSTALLATION_NOT_FOUND;
      case GITHUB_AUTHORIZATION_ERRORS.GITHUB_TEMPORARY_FAILURE:
        return PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE;
      default:
        return PUBLICATION_ERROR_CODES.GITHUB_AUTH_FAILED;
    }
  }

  private mapGitHubAppError(error: unknown): PublicationError {
    if (error instanceof PublicationError) return error;
    if (error instanceof GitHubAppError) {
      if (error.code === "GITHUB_TEMPORARY_FAILURE") return new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
      if (error.code === "GITHUB_INSTALLATION_REPOSITORY_UNAUTHORIZED") return new PublicationError(PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED);
      if (error.code === "GITHUB_INSTALLATION_SUSPENDED") return new PublicationError(PUBLICATION_ERROR_CODES.INSTALLATION_REVOKED);
      return new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_AUTH_FAILED);
    }
    return new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
  }

  private async resolveAuthorization(userId: string, repositoryId: number) {
    try {
      return await this.authorization.resolveRepositoryAuthorization(userId, repositoryId);
    } catch (error) {
      if (error instanceof GitHubAuthorizationError) throw new PublicationError(this.mapAuthorizationCode(error.code), 403);
      throw error;
    }
  }

  /** The push target is constructed here, from durable identity — never supplied by a client. */
  private remoteUrlFor(repository: { repositoryId: number; owner: string; name: string }): string {
    if (this.resolveRemoteUrl) return this.resolveRemoteUrl(repository);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repository.owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repository.name)) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED);
    }
    return `${this.githubWebBase}/${repository.owner}/${repository.name}.git`;
  }

  private async requireOwned(userId: string, publicationId: string): Promise<PublicationRecord> {
    const publication = await this.db.getPublicationById(publicationId);
    if (!publication) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_NOT_FOUND, 404);
    // Ownership failure is reported as "not found" so publication ids cannot be enumerated.
    if (publication.userId !== userId) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_NOT_FOUND, 404);
    return publication;
  }

  private assertSha(value: string, code: PublicationErrorCode): void {
    if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new PublicationError(code);
  }

  private async toView(record: PublicationRecord): Promise<PublicationView> {
    const view = this.toViewSync(record);
    if (record.state === "completed" && record.pushRef && record.pullRequestNumber && record.pullRequestUrl) {
      const authorization = await this.db.getGitHubRepositoryAuthorization(record.repositoryId);
      view.receipt = {
        publicationId: record.id,
        deliveryId: record.deliveryId,
        repositoryId: record.repositoryId,
        repositoryFullName: authorization?.fullName ?? "",
        targetBranch: record.targetBranch,
        certifiedTargetSha: record.targetSha,
        publishedCommit: record.certifiedHead,
        publishedTree: record.certifiedTree,
        publicationRef: record.pushRef,
        pullRequestNumber: record.pullRequestNumber,
        pullRequestUrl: record.pullRequestUrl,
        completedAt: record.completedAt ?? record.updatedAt,
      };
    }
    return view;
  }

  private toViewSync(record: PublicationRecord): PublicationView {
    return {
      id: record.id,
      deliveryId: record.deliveryId,
      repositoryId: record.repositoryId,
      targetBranch: record.targetBranch,
      certifiedHead: record.certifiedHead,
      certifiedTree: record.certifiedTree,
      artifactSha256: record.artifactSha256,
      artifactBytes: record.artifactBytes,
      artifactState: record.artifactState,
      state: record.state,
      ...(record.pushRef ? { pushRef: record.pushRef } : {}),
      ...(record.pullRequestNumber ? { pullRequestNumber: record.pullRequestNumber } : {}),
      ...(record.pullRequestUrl ? { pullRequestUrl: record.pullRequestUrl } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      attemptCount: record.attemptCount,
      canRetry: RETRYABLE_STATES.has(record.state),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    };
  }
}
