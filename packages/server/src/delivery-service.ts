import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import type { SessionPersistence } from "@codeforge/sessions";
import { SecretScanner, containsSecret } from "@codeforge/secrets";
import type { AutonomousMission } from "./mission-state.js";
import type { ForgeWorkspace, WorkspaceService } from "./workspace-service.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { ReviewResult } from "@codeforge/agent";
import { runVerification } from "@codeforge/workflow";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { ChangesetAnalyzer } from "./changeset-analyzer.js";
import { RepositoryPolicyService, verificationCommands } from "./repository-policy-service.js";
import { DELIVERY_ERRORS, DeliveryStore, validCommitTitle, validateCommitPlan, type ChangeDelivery, type CommitPlan, type DeliveryErrorCode, type DeliveryEvent, type DeliveryVerification, type ReviewPackage } from "./delivery-state.js";
import { createForgeVerifyPersistenceObserver } from "./forge-verify-persistence.js";

const execFile = promisify(execFileCallback);
const TERMINAL = new Set(["ready", "blocked", "cancelled", "failed"]);

export interface DeliveryReviewerResult { verdict: "pass" | "blocked" | "code_repair_required"; findings: string[] }
export interface DeliveryServiceOptions {
  workspaceService: WorkspaceService;
  persistence?: SessionPersistence;
  findMission: (missionId: string) => AutonomousMission | undefined;
  policyService?: RepositoryPolicyService;
  analyzer?: ChangesetAnalyzer;
  /** Production delivery review is executed through this existing bounded agent runtime. */
  getAgentRuntime?: (sessionId: string) => AgentRuntime;
  /** Deterministic test seam only; production supplies getAgentRuntime. */
  reviewer?: (delivery: ChangeDelivery) => Promise<DeliveryReviewerResult>;
  onEvent?: (event: DeliveryEvent) => void;
}
export interface CreateDeliveryInput { missionId: string; deliveryId?: string; commitPlan?: CommitPlan }

function allPaths(delivery: ChangeDelivery): string[] {
  const analysis = delivery.analysis;
  if (!analysis) return [];
  const paths = [...analysis.added, ...analysis.modified, ...analysis.deleted, ...analysis.renamed.flatMap((item) => [item.from, item.to])];
  return [...new Set(paths)].sort();
}

function defaultCommitPlan(paths: string[]): CommitPlan {
  const tests = paths.filter((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file));
  const code = paths.filter((file) => !tests.includes(file));
  const commits = [];
  if (code.length) commits.push({ id: "implementation", title: "feat: deliver certified mission change", paths: code });
  if (tests.length) commits.push({ id: "tests", title: "test: cover certified mission change", paths: tests });
  return { commits };
}

/**
 * Local-only delivery packaging.  It never invokes a remote Git command and it never alters the
 * target checkout: all history operations are constrained to a CodeForge delivery worktree.
 */
export class DeliveryService {
  private readonly store: DeliveryStore;
  private readonly policy: RepositoryPolicyService;
  private readonly analyzer: ChangesetAnalyzer;
  private readonly scanner = new SecretScanner();
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(private readonly options: DeliveryServiceOptions) {
    this.store = new DeliveryStore(options.persistence, options.onEvent);
    this.policy = options.policyService ?? new RepositoryPolicyService();
    this.analyzer = options.analyzer ?? new ChangesetAnalyzer();
  }

  getDelivery(id: string): ChangeDelivery | undefined { return this.store.get(id); }
  listDeliveries(sessionId?: string): ChangeDelivery[] { return this.store.list(sessionId); }

  async resumeDelivery(id: string): Promise<ChangeDelivery> {
    const delivery = this.store.get(id);
    if (!delivery) throw new Error("DELIVERY_NOT_FOUND");
    if (TERMINAL.has(delivery.status)) return delivery;
    const mission = this.options.findMission(delivery.missionId);
    const workspace = mission ? this.options.workspaceService.getWorkspace(mission.workspaceId) : undefined;
    if (!mission || !workspace || mission.status !== "completed" || mission.finalRevision !== delivery.sourceRevision) {
      this.block(delivery, DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
      return delivery;
    }
    const controller = new AbortController();
    this.activeControllers.set(id, controller);
    try { await this.run(delivery, workspace, mission, undefined, controller.signal); } catch (error) { if (!TERMINAL.has(delivery.status)) this.block(delivery, error instanceof Error ? error.message : String(error)); }
    finally { this.activeControllers.delete(id); }
    return delivery;
  }

  async createDelivery(input: CreateDeliveryInput): Promise<ChangeDelivery> {
    const existing = input.deliveryId ? this.store.get(input.deliveryId) : undefined;
    if (existing && TERMINAL.has(existing.status)) return existing;
    const mission = this.options.findMission(input.missionId);
    if (!mission || mission.status !== "completed" || !mission.finalRevision || mission.acceptanceCriteria.some((criterion) => criterion.mandatory && criterion.status !== "proven")) {
      throw new Error(DELIVERY_ERRORS.DELIVERY_SOURCE_NOT_CERTIFIED);
    }
    const workspace = this.options.workspaceService.getWorkspace(mission.workspaceId);
    if (!workspace) throw new Error(DELIVERY_ERRORS.DELIVERY_SOURCE_NOT_CERTIFIED);
    const now = new Date().toISOString();
    const delivery = existing ?? {
      kind: "change_delivery" as const, id: input.deliveryId ?? `delivery-${crypto.randomUUID()}`, sessionId: mission.sessionId, missionId: mission.id,
      workspaceId: workspace.id, sourceRevision: mission.finalRevision, targetRevision: mission.finalRevision, status: "created" as const,
      commits: [], verification: [], createdAt: now, updatedAt: now,
    };
    const controller = new AbortController();
    this.activeControllers.set(delivery.id, controller);
    try {
      await this.run(delivery, workspace, mission, input.commitPlan, controller.signal);
    } catch (error) {
      if (!TERMINAL.has(delivery.status)) this.block(delivery, error instanceof Error ? error.message : String(error));
    } finally { this.activeControllers.delete(delivery.id); }
    return delivery;
  }

  cancelDelivery(id: string): boolean {
    const delivery = this.store.get(id);
    if (!delivery || TERMINAL.has(delivery.status)) return false;
    this.activeControllers.get(id)?.abort(DELIVERY_ERRORS.DELIVERY_CANCELLED);
    delivery.status = "cancelled"; delivery.error = DELIVERY_ERRORS.DELIVERY_CANCELLED;
    this.save(delivery); this.store.emit(delivery, "delivery.cancelled", { branch: delivery.deliveryBranch, retained: true });
    return true;
  }

  private async run(delivery: ChangeDelivery, workspace: ForgeWorkspace, mission: AutonomousMission, proposedPlan?: CommitPlan, signal?: AbortSignal): Promise<void> {
    this.throwIfCancelled(signal);
    delivery.status = "analyzing"; this.save(delivery); this.store.emit(delivery, "delivery.analyzing");
    delivery.policySnapshot = await this.policy.discover(workspace.rootPath, delivery.sourceRevision);
    delivery.analysis = await this.analyzer.analyze(workspace.rootPath, mission.baseRevision, delivery.sourceRevision);
    const diff = await this.git(workspace.rootPath, ["diff", "--binary", `${mission.baseRevision}..${delivery.sourceRevision}`]);
    const secretFindings = this.scanner.scan(diff).map((finding) => ({ type: finding.type, line: finding.line }));
    if (/CF10_SECRET_DO_NOT_DELIVER_[A-Za-z0-9_-]+/.test(diff)) secretFindings.push({ type: "cf10_test_marker", line: 1 });
    if (secretFindings.length || containsSecret(diff)) {
      delivery.secretFindings = secretFindings;
      this.save(delivery);
      this.store.emit(delivery, "delivery.secret.detected", { findingTypes: secretFindings.map((finding) => finding.type) });
      throw new Error(DELIVERY_ERRORS.DELIVERY_SECRET_DETECTED);
    }
    this.save(delivery); this.store.emit(delivery, "delivery.analysis.completed", { changedFiles: allPaths(delivery).length, policyDigest: delivery.policySnapshot.digest });

    const plan = delivery.commitPlan ?? proposedPlan ?? defaultCommitPlan(allPaths(delivery));
    const planCheck = validateCommitPlan(plan, allPaths(delivery));
    if (!planCheck.valid) throw new Error(planCheck.error);
    for (const commit of plan.commits) if (!validCommitTitle(commit.title) || this.scanner.scan(commit.title).length) throw new Error(DELIVERY_ERRORS.DELIVERY_COMMIT_PLAN_INVALID);

    delivery.commitPlan = plan;
    delivery.status = "packaging"; this.save(delivery);
    const child = delivery.deliveryWorkspaceId ? this.options.workspaceService.getWorkspace(delivery.deliveryWorkspaceId) : await this.options.workspaceService.createWorktree({
      parentWorkspaceId: workspace.id, base: "head", runId: delivery.id, label: "delivery", branchNamespace: "delivery", metadata: { missionId: delivery.missionId, sourceRevision: delivery.sourceRevision },
    });
    if (!child) throw new Error(DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
    delivery.deliveryWorkspaceId = child.id; delivery.deliveryBranch = child.branch; this.save(delivery);
    if (!delivery.packagingBasePrepared) {
      await this.git(child.rootPath, ["reset", "--mixed", mission.baseRevision], signal);
      delivery.packagingBasePrepared = true; this.save(delivery);
    }
    await this.reconcileCommits(delivery, child, mission.baseRevision, plan, signal);
    delivery.sourceTree = (await this.git(workspace.rootPath, ["rev-parse", `${delivery.sourceRevision}^{tree}`])).trim();
    this.save(delivery); this.store.emit(delivery, "delivery.packaging.started", { branch: child.branch });
    const lease = this.options.workspaceService.acquireLease(child.id, delivery.id, "write");
    delivery.leaseId = lease.leaseId; this.save(delivery);
    try {
      for (const planned of plan.commits) {
        this.throwIfCancelled(signal);
        const prior = delivery.commits.find((commit) => commit.id === planned.id);
        if (prior?.sha) continue;
        await this.git(child.rootPath, ["add", "--", ...planned.paths], signal);
        this.throwIfCancelled(signal);
        await this.git(child.rootPath, ["commit", "-m", planned.title], signal);
        const sha = (await this.git(child.rootPath, ["rev-parse", "HEAD"], signal)).trim();
        delivery.commits = [...delivery.commits.filter((commit) => commit.id !== planned.id), { ...planned, sha }];
        this.save(delivery); this.store.emit(delivery, "delivery.commit.created", { id: planned.id, sha, paths: planned.paths });
      }
    this.throwIfCancelled(signal);
    const staged = (await this.git(child.rootPath, ["status", "--porcelain"], signal)).trim();
    if (staged) throw new Error(DELIVERY_ERRORS.DELIVERY_WORKTREE_DIRTY);
    delivery.deliveryRevision = (await this.git(child.rootPath, ["rev-parse", "HEAD"])).trim();
    delivery.deliveryTree = (await this.git(child.rootPath, ["rev-parse", "HEAD^{tree}"])).trim();
    if (delivery.sourceTree !== delivery.deliveryTree) throw new Error(DELIVERY_ERRORS.DELIVERY_TREE_MISMATCH);
    this.save(delivery); this.store.emit(delivery, "delivery.tree.equivalent", { sourceTree: delivery.sourceTree, deliveryTree: delivery.deliveryTree });

    const policyCurrent = await this.policy.isCurrent(workspace.rootPath, delivery.policySnapshot, delivery.sourceRevision);
    if (!policyCurrent) throw new Error(DELIVERY_ERRORS.DELIVERY_POLICY_STALE);
    const target = (await this.git(workspace.rootPath, ["rev-parse", "HEAD"])).trim();
    if (target !== delivery.targetRevision) throw new Error(DELIVERY_ERRORS.DELIVERY_TARGET_DIVERGED);

    delivery.status = "verifying"; this.save(delivery);
    const commands = verificationCommands(delivery.policySnapshot);
    if (!commands.length) throw new Error(DELIVERY_ERRORS.DELIVERY_VERIFICATION_FAILED);
    delivery.verification = await this.verify(child.rootPath, commands, delivery.deliveryRevision, signal, delivery.id, delivery.sessionId);
    if (delivery.verification.some((entry) => entry.exitCode !== 0)) throw new Error(DELIVERY_ERRORS.DELIVERY_VERIFICATION_FAILED);
    this.save(delivery); this.store.emit(delivery, "delivery.verification.completed", { commands, passed: true });

    delivery.status = "reviewing"; this.save(delivery);
    const review = await this.review(delivery, child, signal);
    delivery.reviewPackage = this.reviewPackage(delivery, review);
    if (review.verdict === "code_repair_required") throw new Error(DELIVERY_ERRORS.DELIVERY_CODE_REPAIR_REQUIRED);
    if (review.verdict !== "pass") throw new Error(DELIVERY_ERRORS.DELIVERY_REVIEW_BLOCKED);
    const finalStatus = (await this.git(child.rootPath, ["status", "--porcelain"])).trim();
    if (finalStatus) throw new Error(DELIVERY_ERRORS.DELIVERY_WORKTREE_DIRTY);
    const finalTarget = (await this.git(workspace.rootPath, ["rev-parse", "HEAD"])).trim();
    if (finalTarget !== delivery.targetRevision) throw new Error(DELIVERY_ERRORS.DELIVERY_TARGET_DIVERGED);
    this.throwIfCancelled(signal);
    delivery.status = "ready"; delivery.error = undefined; this.save(delivery); this.store.emit(delivery, "delivery.ready", { branch: delivery.deliveryBranch, revision: delivery.deliveryRevision });
    } finally {
      this.options.workspaceService.releaseLease(lease.leaseId, delivery.id);
      delivery.leaseId = undefined; this.save(delivery);
    }
  }

  private reviewPackage(delivery: ChangeDelivery, review: DeliveryReviewerResult): ReviewPackage {
    const analysis = delivery.analysis!;
    const risks = [
      ...(analysis.impact.securityImpact ? ["Security-sensitive areas changed; review evidence required."] : []),
      ...(analysis.impact.dependencyImpact ? ["Dependency manifest changed; inspect recorded dependency impact."] : []),
      ...(analysis.impact.compatibility === "unknown" ? ["Public compatibility is unknown; inspect listed public contracts."] : []),
    ];
    const title = `Delivery: ${delivery.missionId.slice(0, 60)}`;
    const testing = delivery.verification;
    const prBody = [
      "## Summary", `Certified mission ${delivery.missionId} packaged into ${delivery.commits.length} local commit(s).`,
      "## Testing", ...(testing.length ? testing.map((test) => `- \`${test.command}\` (exit ${test.exitCode})`) : ["- No repository-mandated delivery command was discovered; mission verification evidence remains authoritative."]),
      "## Acceptance", "- Mandatory mission acceptance criteria were proven before delivery began.",
      "## Risk", ...(risks.length ? risks.map((risk) => `- ${risk}`) : ["- No additional structured delivery risks detected."]),
      "## Rollback", `- Revert delivery commits on ${delivery.deliveryBranch}; no target history was rewritten.`,
    ].join("\n");
    return { title, summary: `Changed ${allPaths(delivery).length} file(s) across ${analysis.affectedPackages.join(", ")}.`, testing, risks, migration: analysis.migrations,
      configuration: analysis.configuration, rollback: `Revert the ${delivery.commits.length} delivery commit(s); source mission revision ${delivery.sourceRevision} remains retained.`,
      knownLimitations: ["No remote branch, push, or pull request was created."], prBody, verdict: review.verdict, findings: review.findings };
  }

  private async verify(cwd: string, commands: string[], revision: string, signal?: AbortSignal, runId?: string, sessionId?: string): Promise<DeliveryVerification[]> {
    if (!commands.length) return [];
    const report = await runVerification(cwd, commands, { signal, ...(runId ? { runId } : {}), ...(sessionId && this.options.persistence ? { observer: createForgeVerifyPersistenceObserver(this.options.persistence, sessionId) } : {}) });
    this.throwIfCancelled(signal);
    return report.verifiers.map((verifier) => ({
      command: verifier.command,
      cwd,
      exitCode: verifier.exitCode ?? (verifier.failed ? 1 : 0),
      durationMs: verifier.durationMs,
      revision,
    }));
  }

  private async reconcileCommits(delivery: ChangeDelivery, workspace: ForgeWorkspace, baseRevision: string, plan: CommitPlan, signal?: AbortSignal): Promise<void> {
    const shas = (await this.git(workspace.rootPath, ["rev-list", "--reverse", `${baseRevision}..HEAD`], signal)).trim().split("\n").filter(Boolean);
    if (shas.length > plan.commits.length) throw new Error(DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
    const reconciled = [];
    for (const [index, sha] of shas.entries()) {
      const expected = plan.commits[index]!;
      const title = (await this.git(workspace.rootPath, ["log", "-1", "--format=%s", sha], signal)).trim();
      const paths = (await this.git(workspace.rootPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], signal)).trim().split("\n").filter(Boolean).sort();
      if (title !== expected.title || JSON.stringify(paths) !== JSON.stringify([...expected.paths].sort())) throw new Error(DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
      const persisted = delivery.commits[index];
      if (persisted?.sha && persisted.sha !== sha) throw new Error(DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
      reconciled.push({ ...expected, sha });
    }
    if (delivery.commits.length > reconciled.length) throw new Error(DELIVERY_ERRORS.DELIVERY_RECOVERY_REVALIDATION_REQUIRED);
    delivery.commits = reconciled; this.save(delivery);
  }

  private async review(delivery: ChangeDelivery, workspace: ForgeWorkspace, signal?: AbortSignal): Promise<DeliveryReviewerResult> {
    const runtime = this.options.getAgentRuntime?.(delivery.sessionId);
    if (runtime) {
      const runId = `${delivery.id}:delivery-review`;
      delivery.reviewerRunId = runId; this.save(delivery);
      const response = await runtime.executeAgentRun({
        runId, agentId: "reviewer", role: "reviewer", goal: `Review local delivery ${delivery.id}; report only a structured review verdict.`,
        workspaceId: workspace.id, workspacePath: workspace.rootPath,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, structuredOutput: "reviewer", signal,
        taskPlan: JSON.stringify({ policy: delivery.policySnapshot, analysis: delivery.analysis, commits: delivery.commits, verification: delivery.verification, sourceTree: delivery.sourceTree, deliveryTree: delivery.deliveryTree }),
      });
      const structured = response.structuredData as ReviewResult | undefined;
      if (response.status !== "completed" || !structured) return { verdict: "blocked", findings: [response.error ?? "DELIVERY_REVIEWER_RUNTIME_FAILED", ...response.toolExecutions.map((execution) => execution.error).filter((error): error is string => Boolean(error))] };
      return structured.verdict === "pass" ? { verdict: "pass", findings: structured.findings.map((finding) => finding.message) } : { verdict: "code_repair_required", findings: structured.findings.map((finding) => finding.message) };
    }
    return this.options.reviewer ? await this.options.reviewer(delivery) : { verdict: "pass", findings: [] };
  }

  private async git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    this.throwIfCancelled(signal);
    return (await execFile("git", args, { cwd, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" }, signal })).stdout;
  }
  private throwIfCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error(DELIVERY_ERRORS.DELIVERY_CANCELLED); }
  private save(delivery: ChangeDelivery): void { delivery.updatedAt = new Date().toISOString(); this.store.save(delivery); }
  private block(delivery: ChangeDelivery, error: string): void { delivery.status = error === DELIVERY_ERRORS.DELIVERY_CANCELLED ? "cancelled" : "blocked"; delivery.error = error as DeliveryErrorCode; this.save(delivery); this.store.emit(delivery, "delivery.blocked", { error: delivery.error, branch: delivery.deliveryBranch }); }
}

export function createDeliveryService(options: DeliveryServiceOptions): DeliveryService { return new DeliveryService(options); }
