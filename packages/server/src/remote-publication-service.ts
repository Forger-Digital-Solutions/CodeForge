import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { ChangeDelivery } from "./delivery-state.js";
import type { WorkspaceService } from "./workspace-service.js";
import { validateSafeBranchName } from "./workspace-service.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { GitHubClientError, GitHubPullRequestClient, normalizeGitHubRemote, type RemotePullRequestProvider, type RemoteRepositoryIdentity } from "./github-pr-client.js";
import { PUBLICATION_ERRORS, publicationBinding, RemotePublicationStore, remoteBranchFor, type PublicationErrorCode, type RemotePublication, type RemotePublicationReceipt } from "./remote-publication-state.js";

const execFile = promisify(execFileCallback);
const TERMINAL = new Set(["remote_pr_ready", "blocked", "failed", "cancelled", "remote_diverged"]);
const SAFE_REMOTE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

export interface RemotePublicationServiceOptions {
  persistence?: ISessionPersistence;
  workspaceService: WorkspaceService;
  getDelivery: (id: string) => Promise<ChangeDelivery | undefined>;
  /** Credential retrieval is deliberately separate from durable publication data. */
  getGitHubToken?: () => Promise<string> | string;
  pullRequests?: RemotePullRequestProvider;
  /** Test/enterprise seam; production accepts only canonical github.com remotes. */
  resolveRepository?: (remoteUrl: string, remoteName: string) => RemoteRepositoryIdentity | undefined;
  afterPush?: (publication: RemotePublication) => Promise<void> | void;
  afterPullRequestCreated?: (publication: RemotePublication) => Promise<void> | void;
}

function failure(code: PublicationErrorCode): Error { const error = new Error(code); (error as Error & { code: PublicationErrorCode }).code = code; return error; }
function isCode(value: unknown): value is PublicationErrorCode { return typeof value === "string" && Object.values(PUBLICATION_ERRORS).includes(value as PublicationErrorCode); }

/**
 * CF-11's narrow remote boundary. It can push one immutable, certified delivery SHA and create
 * one open GitHub PR. It intentionally has no merge, approval, release, or deployment methods.
 */
export class RemotePublicationService {
  private readonly store: RemotePublicationStore;
  private readonly active = new Map<string, AbortController>();
  private readonly providers: RemotePullRequestProvider;

  constructor(private readonly options: RemotePublicationServiceOptions) {
    this.store = new RemotePublicationStore(options.persistence);
    this.providers = options.pullRequests ?? new GitHubPullRequestClient(options.getGitHubToken ?? (() => ""));
  }

  async getPublication(id: string): Promise<RemotePublication | undefined> { return await this.store.get(id); }
  async getPublicationForDelivery(deliveryId: string): Promise<RemotePublication | undefined> { return await this.store.findByDelivery(deliveryId); }
  async listPublications(deliveryId?: string): Promise<RemotePublication[]> { return await this.store.list(deliveryId); }

  async createPublication(deliveryId: string): Promise<RemotePublication> {
    const delivery = await this.assertDelivery(deliveryId);
    const existing = await this.store.findByDelivery(deliveryId);
    if (existing) return existing;
    const workspace = this.options.workspaceService.getWorkspace(delivery.workspaceId);
    if (!workspace?.branch || !delivery.deliveryBranch || !delivery.deliveryRevision || !delivery.deliveryTree) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const id = `publication-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const publication: RemotePublication = {
      kind: "remote_publication", id, deliveryId: delivery.id, missionId: delivery.missionId, sessionId: delivery.sessionId, workspaceId: delivery.workspaceId,
      status: "local_ready", remoteName: "origin", targetBranch: workspace.branch, localDeliveryBranch: delivery.deliveryBranch,
      localDeliveryHead: delivery.deliveryRevision, localDeliveryTree: delivery.deliveryTree, remoteBranch: remoteBranchFor(id, delivery.id), expectedRemoteSha: delivery.deliveryRevision,
      createdAt: now, updatedAt: now,
    };
    if (!validateSafeBranchName(publication.remoteBranch)) throw failure(PUBLICATION_ERRORS.REMOTE_BRANCH_DIVERGED);
    // Identity is captured before authorization. A remote URL swap after this point invalidates
    // the bound authorization instead of redirecting a previously approved publication.
    if (!SAFE_REMOTE_NAME.test(publication.remoteName)) throw failure(PUBLICATION_ERRORS.REMOTE_NOT_CONFIGURED);
    const deliveryWorkspace = this.options.workspaceService.getWorkspace(delivery.deliveryWorkspaceId ?? "");
    if (!deliveryWorkspace) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const remotes = (await this.git(deliveryWorkspace.rootPath, ["remote"])).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes(publication.remoteName)) throw failure(PUBLICATION_ERRORS.REMOTE_NOT_CONFIGURED);
    const remoteUrl = (await this.git(deliveryWorkspace.rootPath, ["remote", "get-url", publication.remoteName])).trim();
    const repository = this.options.resolveRepository?.(remoteUrl, publication.remoteName) ?? normalizeGitHubRemote(remoteUrl);
    if (!repository) throw failure(PUBLICATION_ERRORS.REMOTE_UNSUPPORTED);
    publication.remoteUrl = remoteUrl; publication.repository = repository;
    await this.save(publication); return publication;
  }

  async authorize(publicationId: string, actorId: string): Promise<RemotePublication> {
    const publication = await this.require(publicationId);
    if (publication.status !== "local_ready" && publication.status !== "authorization_required") throw failure(PUBLICATION_ERRORS.PUBLICATION_AUTHORIZATION_STALE);
    const delivery = await this.assertDelivery(publication.deliveryId);
    if (!actorId || actorId.length > 160) throw failure(PUBLICATION_ERRORS.PUBLICATION_AUTHORIZATION_STALE);
    publication.authorization = { actorId, nonce: crypto.randomUUID(), authorizedAt: new Date().toISOString(), binding: publicationBinding(delivery.id, delivery.deliveryRevision!, delivery.deliveryTree!, `${publication.repository?.canonical ?? ""}:${publication.targetBranch}`) };
    publication.status = "remote_authorized"; publication.error = undefined; await this.save(publication); return publication;
  }

  async cancel(publicationId: string): Promise<boolean> {
    const publication = await this.store.get(publicationId);
    if (!publication || TERMINAL.has(publication.status)) return false;
    this.active.get(publicationId)?.abort(PUBLICATION_ERRORS.PUBLICATION_CANCELLED);
    publication.status = "cancelled"; publication.error = PUBLICATION_ERRORS.PUBLICATION_CANCELLED; await this.save(publication); return true;
  }

  async resume(publicationId: string): Promise<RemotePublication> {
    const publication = await this.require(publicationId);
    if (TERMINAL.has(publication.status)) return publication;
    if (!publication.authorization) { publication.status = "authorization_required"; await this.save(publication); return publication; }
    if (this.active.has(publicationId)) throw failure(PUBLICATION_ERRORS.PUBLICATION_LEASE_CONFLICT);
    const controller = new AbortController(); this.active.set(publicationId, controller);
    try { await this.publish(publication, controller.signal); }
    catch (error) {
      // A process-loss seam deliberately leaves the last durable record untouched so a recreated
      // service must reconcile the external side effect instead of trusting in-memory progress.
      if (error instanceof Error && error.message === "PROCESS_TERMINATED") throw error;
      if (!TERMINAL.has(publication.status)) await this.fail(publication, this.errorCode(error));
    }
    finally { this.active.delete(publicationId); }
    return publication;
  }

  private async publish(publication: RemotePublication, signal: AbortSignal): Promise<void> {
    this.throwIfCancelled(signal);
    const delivery = await this.assertDelivery(publication.deliveryId);
    const workspace = this.options.workspaceService.getWorkspace(delivery.deliveryWorkspaceId ?? "");
    if (!workspace) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const binding = publicationBinding(delivery.id, delivery.deliveryRevision!, delivery.deliveryTree!, `${publication.repository?.canonical ?? ""}:${publication.targetBranch}`);
    if (publication.authorization?.binding !== binding) throw failure(PUBLICATION_ERRORS.PUBLICATION_AUTHORIZATION_STALE);
    await this.assertDeliveryIdentity(delivery, workspace.rootPath);
    const lease = this.options.workspaceService.acquireLease(workspace.id, publication.id, "write");
    publication.leaseId = lease.leaseId; this.save(publication);
    let processTerminated = false;
    try {
      publication.status = "validating_remote"; this.save(publication);
      // Git transport can authenticate independently (for example through an SSH agent).  Do not
      // allow it to make a remote side effect unless the separate GitHub publication authority is
      // available first.
      await this.providers.assertReady?.(signal);
      await this.validateRemote(publication, workspace.rootPath, delivery, signal);
      this.throwIfCancelled(signal);
      publication.status = "publishing_branch"; this.save(publication);
      await this.pushOrReconcile(publication, workspace.rootPath, signal);
      this.throwIfCancelled(signal);
      if (!publication.pushCompletedAt) { publication.pushCompletedAt = new Date().toISOString(); await this.options.afterPush?.(publication); this.save(publication); }
      publication.status = "creating_pr"; this.save(publication);
      await this.createOrReconcilePullRequest(publication, delivery, signal);
      this.throwIfCancelled(signal);
      publication.status = "remote_pr_ready"; publication.error = undefined; publication.receipt = this.receipt(publication, delivery); this.save(publication);
    } catch (error) {
      processTerminated = error instanceof Error && error.message === "PROCESS_TERMINATED";
      throw error;
    } finally {
      this.options.workspaceService.releaseLease(lease.leaseId, publication.id);
      // In a real crash no cleanup/save occurs. Preserve that boundary for deterministic recovery
      // tests without turning an uncertain distributed operation into a completed one.
      if (!processTerminated) { publication.leaseId = undefined; this.save(publication); }
    }
  }

  private async validateRemote(publication: RemotePublication, cwd: string, delivery: ChangeDelivery, signal: AbortSignal): Promise<void> {
    if (!SAFE_REMOTE_NAME.test(publication.remoteName)) throw failure(PUBLICATION_ERRORS.REMOTE_NOT_CONFIGURED);
    const remotes = (await this.git(cwd, ["remote"], signal)).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes(publication.remoteName)) throw failure(PUBLICATION_ERRORS.REMOTE_NOT_CONFIGURED);
    const url = (await this.git(cwd, ["remote", "get-url", publication.remoteName], signal)).trim();
    const repository = this.options.resolveRepository?.(url, publication.remoteName) ?? normalizeGitHubRemote(url);
    if (!repository) throw failure(PUBLICATION_ERRORS.REMOTE_UNSUPPORTED);
    if (publication.remoteUrl !== url || publication.repository?.canonical !== repository.canonical) throw failure(PUBLICATION_ERRORS.PUBLICATION_AUTHORIZATION_STALE);
    publication.remoteUrl = url; publication.repository = repository;
    const target = await this.remoteSha(cwd, publication.remoteName, publication.targetBranch, signal);
    const expected = await this.deliveryBase(cwd, delivery, signal);
    if (!target || target !== expected) throw failure(PUBLICATION_ERRORS.REMOTE_TARGET_DIVERGED);
    publication.capturedTargetSha = target; this.save(publication);
  }

  private async pushOrReconcile(publication: RemotePublication, cwd: string, signal: AbortSignal): Promise<void> {
    const remoteSha = await this.remoteSha(cwd, publication.remoteName, publication.remoteBranch, signal);
    if (remoteSha && remoteSha !== publication.expectedRemoteSha) throw failure(PUBLICATION_ERRORS.REMOTE_BRANCH_DIVERGED);
    if (remoteSha === publication.expectedRemoteSha) return;
    try { await this.git(cwd, ["push", publication.remoteName, `${publication.expectedRemoteSha}:refs/heads/${publication.remoteBranch}`], signal); }
    catch { throw failure(PUBLICATION_ERRORS.REMOTE_PUSH_FAILED); }
    const confirmed = await this.remoteSha(cwd, publication.remoteName, publication.remoteBranch, signal);
    if (confirmed !== publication.expectedRemoteSha) throw failure(PUBLICATION_ERRORS.REMOTE_PUSH_FAILED);
  }

  private async createOrReconcilePullRequest(publication: RemotePublication, delivery: ChangeDelivery, signal: AbortSignal): Promise<void> {
    const repository = publication.repository!;
    if (publication.pr) {
      if (publication.pr.state !== "open" || publication.pr.head !== publication.remoteBranch || publication.pr.base !== publication.targetBranch || publication.pr.headSha && publication.pr.headSha !== publication.expectedRemoteSha) throw failure(PUBLICATION_ERRORS.REMOTE_PR_CONFLICT);
      return;
    }
    const existing = await this.providers.findOpenPullRequest(repository, publication.remoteBranch, publication.targetBranch, signal);
    if (existing) {
      if (existing.head !== publication.remoteBranch || existing.base !== publication.targetBranch || existing.headSha && existing.headSha !== publication.expectedRemoteSha) throw failure(PUBLICATION_ERRORS.REMOTE_PR_CONFLICT);
      publication.pr = existing; this.save(publication); return;
    }
    const review = delivery.reviewPackage!;
    const body = [review.prBody, "", `CodeForge delivery: ${delivery.id}`, `Published commit: ${publication.expectedRemoteSha}`, `Published tree: ${publication.localDeliveryTree}`].join("\n");
    const pr = await this.providers.createPullRequest({ repository, head: publication.remoteBranch, base: publication.targetBranch, title: review.title.slice(0, 120), body, signal });
    if (pr.state !== "open" || pr.head !== publication.remoteBranch || pr.base !== publication.targetBranch || pr.headSha && pr.headSha !== publication.expectedRemoteSha) throw failure(PUBLICATION_ERRORS.REMOTE_PR_CONFLICT);
    await this.options.afterPullRequestCreated?.(publication); publication.pr = pr; this.save(publication);
  }

  private async assertDeliveryIdentity(delivery: ChangeDelivery, cwd: string): Promise<void> {
    if (delivery.status !== "ready" || !delivery.deliveryRevision || !delivery.deliveryTree || !delivery.sourceTree || delivery.sourceTree !== delivery.deliveryTree || !delivery.policySnapshot || !delivery.reviewPackage || delivery.reviewPackage.verdict !== "pass" || delivery.secretFindings?.length || !delivery.verification.length || delivery.verification.some((item) => item.exitCode !== 0)) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const head = (await this.git(cwd, ["rev-parse", "HEAD"])).trim(); const tree = (await this.git(cwd, ["rev-parse", "HEAD^{tree}"])).trim();
    if (head !== delivery.deliveryRevision || tree !== delivery.deliveryTree || !delivery.commits.length || delivery.commits.some((commit) => !commit.sha)) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    const order = (await this.git(cwd, ["rev-list", "--reverse", `${delivery.commits[0]!.sha!}^..HEAD`])).trim().split(/\r?\n/).filter(Boolean);
    if (JSON.stringify(order) !== JSON.stringify(delivery.commits.map((commit) => commit.sha))) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
  }
  private async deliveryBase(cwd: string, delivery: ChangeDelivery, signal: AbortSignal): Promise<string> { return (await this.git(cwd, ["rev-parse", `${delivery.commits[0]!.sha!}^`], signal)).trim(); }
  private async remoteSha(cwd: string, remote: string, branch: string, signal: AbortSignal): Promise<string | undefined> { const value = (await this.git(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], signal)).trim(); return value ? value.split(/\s+/)[0] : undefined; }
  private receipt(publication: RemotePublication, delivery: ChangeDelivery): RemotePublicationReceipt { return { publicationId: publication.id, deliveryId: delivery.id, repository: publication.repository!.canonical, targetBranch: publication.targetBranch, capturedTargetSha: publication.capturedTargetSha!, remoteBranch: publication.remoteBranch, publishedSha: publication.expectedRemoteSha, publishedTree: publication.localDeliveryTree, verificationReceipt: `${delivery.id}:verification`, reviewReceipt: delivery.reviewerRunId ?? `${delivery.id}:review`, secretGateReceipt: `${delivery.id}:secret-gate-passed`, prProvider: "github", prNumber: publication.pr!.number, prUrl: publication.pr!.url, createdAt: new Date().toISOString(), terminalState: "remote_pr_ready" }; }
  private async assertDelivery(id: string): Promise<ChangeDelivery> { const delivery = await this.options.getDelivery(id); if (!delivery) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY); if (delivery.status !== "ready") throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY); return delivery; }
  private async require(id: string): Promise<RemotePublication> { const publication = await this.store.get(id); if (!publication) throw failure(PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY); return publication; }
  private async git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> { return (await execFile("git", args, { cwd, signal, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" } })).stdout; }
  private throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw failure(PUBLICATION_ERRORS.PUBLICATION_CANCELLED); }
  private errorCode(error: unknown): PublicationErrorCode { const code = (error as { code?: unknown })?.code; if (isCode(code)) return code; if (error instanceof GitHubClientError) return error.code; return PUBLICATION_ERRORS.REMOTE_PR_CREATE_FAILED; }
  private fail(publication: RemotePublication, code: PublicationErrorCode): void { publication.error = code; publication.status = code === PUBLICATION_ERRORS.PUBLICATION_CANCELLED ? "cancelled" : code === PUBLICATION_ERRORS.REMOTE_TARGET_DIVERGED || code === PUBLICATION_ERRORS.REMOTE_BRANCH_DIVERGED ? "remote_diverged" : "blocked"; this.save(publication); }
  private save(publication: RemotePublication): void { publication.updatedAt = new Date().toISOString(); this.store.save(publication); }
}

export function createRemotePublicationService(options: RemotePublicationServiceOptions): RemotePublicationService { return new RemotePublicationService(options); }
