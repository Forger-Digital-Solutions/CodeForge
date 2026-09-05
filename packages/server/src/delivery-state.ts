import crypto from "node:crypto";
import type { SessionPersistence, WorkItem } from "@codeforge/sessions";

export const DELIVERY_ERRORS = {
  DELIVERY_SOURCE_NOT_CERTIFIED: "DELIVERY_SOURCE_NOT_CERTIFIED",
  DELIVERY_POLICY_INVALID: "DELIVERY_POLICY_INVALID",
  DELIVERY_POLICY_STALE: "DELIVERY_POLICY_STALE",
  DELIVERY_COMMIT_PLAN_INVALID: "DELIVERY_COMMIT_PLAN_INVALID",
  DELIVERY_COMMIT_PLAN_INCOMPLETE: "DELIVERY_COMMIT_PLAN_INCOMPLETE",
  DELIVERY_TREE_MISMATCH: "DELIVERY_TREE_MISMATCH",
  DELIVERY_SECRET_DETECTED: "DELIVERY_SECRET_DETECTED",
  DELIVERY_VERIFICATION_FAILED: "DELIVERY_VERIFICATION_FAILED",
  DELIVERY_REVIEW_BLOCKED: "DELIVERY_REVIEW_BLOCKED",
  DELIVERY_CODE_REPAIR_REQUIRED: "DELIVERY_CODE_REPAIR_REQUIRED",
  DELIVERY_WORKTREE_DIRTY: "DELIVERY_WORKTREE_DIRTY",
  DELIVERY_TARGET_DIVERGED: "DELIVERY_TARGET_DIVERGED",
  DELIVERY_RECOVERY_REVALIDATION_REQUIRED: "DELIVERY_RECOVERY_REVALIDATION_REQUIRED",
  DELIVERY_CANCELLED: "DELIVERY_CANCELLED",
} as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERRORS)[keyof typeof DELIVERY_ERRORS];

export type DeliveryStatus = "created" | "analyzing" | "packaging" | "reviewing" | "verifying" | "ready" | "blocked" | "cancelled" | "failed";
export type RepositoryPolicyKind = "instruction" | "verification" | "formatting" | "commit" | "ownership" | "dependency" | "release" | "security" | "documentation";

export interface RepositoryPolicy {
  kind: RepositoryPolicyKind;
  source: string;
  evidence: string;
  scope: string;
  trust: "repository_guidance";
  commands?: string[];
}

export interface RepositoryPolicySnapshot {
  id: string;
  revision: string;
  policies: RepositoryPolicy[];
  digest: string;
  createdAt: string;
}

export interface DependencyRiskRecord {
  name: string;
  version: string;
  package: string;
  runtime: boolean;
  sourceFiles: string[];
  lockfilePresent: boolean;
}

export interface ChangeImpact {
  scope: "local" | "package" | "cross_package" | "repository";
  compatibility: "internal" | "backward_compatible" | "potentially_breaking" | "breaking" | "unknown";
  dependencyImpact: boolean;
  migrationImpact: boolean;
  securityImpact: boolean;
  configImpact: boolean;
}

export interface ChangesetAnalysis {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  affectedPackages: string[];
  publicApiChanges: string[];
  dependencies: DependencyRiskRecord[];
  migrations: string[];
  configuration: string[];
  securitySensitiveAreas: string[];
  tests: string[];
  documentation: string[];
  impact: ChangeImpact;
}

export interface DeliveryCommit {
  id: string;
  title: string;
  paths: string[];
  sha?: string;
}

export interface CommitPlan {
  commits: DeliveryCommit[];
}

export interface DeliveryVerification {
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  revision: string;
}

/** Non-sensitive classification evidence captured when delivery secret gating blocks. */
export interface DeliverySecretFinding {
  type: string;
  line: number;
}

export interface ReviewPackage {
  title: string;
  summary: string;
  testing: DeliveryVerification[];
  risks: string[];
  migration: string[];
  configuration: string[];
  rollback: string;
  knownLimitations: string[];
  prBody: string;
  verdict: "pass" | "blocked" | "code_repair_required";
  findings: string[];
}

export interface ChangeDelivery {
  kind: "change_delivery";
  id: string;
  sessionId: string;
  missionId: string;
  workspaceId: string;
  sourceRevision: string;
  targetRevision: string;
  status: DeliveryStatus;
  policySnapshot?: RepositoryPolicySnapshot;
  analysis?: ChangesetAnalysis;
  deliveryWorkspaceId?: string;
  deliveryBranch?: string;
  deliveryRevision?: string;
  sourceTree?: string;
  deliveryTree?: string;
  /** Persisted before the first mutating commit so recovery can reconcile Git rather than replay it. */
  commitPlan?: CommitPlan;
  packagingBasePrepared?: boolean;
  leaseId?: string;
  reviewerRunId?: string;
  commits: DeliveryCommit[];
  verification: DeliveryVerification[];
  secretFindings?: DeliverySecretFinding[];
  reviewPackage?: ReviewPackage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryEvent {
  type: string;
  sessionId: string;
  deliveryId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function deliveryDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateCommitPlan(plan: CommitPlan, changedPaths: string[]): { valid: boolean; error?: DeliveryErrorCode } {
  if (!plan.commits.length || plan.commits.some((commit) => !validCommitTitle(commit.title) || !commit.paths.length)) {
    return { valid: false, error: DELIVERY_ERRORS.DELIVERY_COMMIT_PLAN_INVALID };
  }
  const expected = new Set(changedPaths);
  const assigned = new Set<string>();
  for (const commit of plan.commits) {
    for (const item of commit.paths) {
      if (!expected.has(item) || assigned.has(item)) return { valid: false, error: DELIVERY_ERRORS.DELIVERY_COMMIT_PLAN_INVALID };
      assigned.add(item);
    }
  }
  return assigned.size === expected.size ? { valid: true } : { valid: false, error: DELIVERY_ERRORS.DELIVERY_COMMIT_PLAN_INCOMPLETE };
}

export function validCommitTitle(title: string): boolean {
  return Boolean(title) && title.length <= 120 && !/[\u0000-\u001f\u007f]/.test(title) && !/(?:OPENAI|OPENROUTER|OPENCODE|ANTHROPIC|API[_-]?KEY|PASSWORD|TOKEN)/i.test(title);
}

export class DeliveryStore {
  constructor(private readonly persistence?: SessionPersistence, private readonly onEvent?: (event: DeliveryEvent) => void) {}

  save(delivery: ChangeDelivery): void {
    this.persistence?.upsertWorkItem({
      kind: "change_delivery", id: delivery.id, sessionId: delivery.sessionId, missionId: delivery.missionId,
      workspaceId: delivery.workspaceId, status: delivery.status, sourceRevision: delivery.sourceRevision,
      targetRevision: delivery.targetRevision, deliveryJson: JSON.stringify({
        policySnapshot: delivery.policySnapshot, analysis: delivery.analysis, deliveryWorkspaceId: delivery.deliveryWorkspaceId,
        deliveryBranch: delivery.deliveryBranch, deliveryRevision: delivery.deliveryRevision, sourceTree: delivery.sourceTree,
        deliveryTree: delivery.deliveryTree, commits: delivery.commits, verification: delivery.verification, secretFindings: delivery.secretFindings,
        reviewPackage: delivery.reviewPackage, commitPlan: delivery.commitPlan, packagingBasePrepared: delivery.packagingBasePrepared,
        leaseId: delivery.leaseId, reviewerRunId: delivery.reviewerRunId,
      }), ...(delivery.error ? { error: delivery.error } : {}), createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
    } as unknown as WorkItem);
  }

  get(id: string): ChangeDelivery | undefined {
    const item = this.persistence?.getWorkItem(id) as unknown as (WorkItem & Record<string, unknown>) | undefined;
    if (!item || item.kind !== "change_delivery") return undefined;
    const detail = typeof item.deliveryJson === "string" ? JSON.parse(item.deliveryJson) as Partial<ChangeDelivery> : {};
    return {
      kind: "change_delivery", id: item.id, sessionId: item.sessionId!, missionId: String(item.missionId), workspaceId: String(item.workspaceId),
      status: item.status as DeliveryStatus, sourceRevision: String(item.sourceRevision), targetRevision: String(item.targetRevision),
      commits: detail.commits ?? [], verification: detail.verification ?? [], policySnapshot: detail.policySnapshot,
      analysis: detail.analysis, deliveryWorkspaceId: detail.deliveryWorkspaceId, deliveryBranch: detail.deliveryBranch,
      deliveryRevision: detail.deliveryRevision, sourceTree: detail.sourceTree, deliveryTree: detail.deliveryTree, secretFindings: detail.secretFindings,
      reviewPackage: detail.reviewPackage, commitPlan: detail.commitPlan, packagingBasePrepared: detail.packagingBasePrepared,
      leaseId: detail.leaseId, reviewerRunId: detail.reviewerRunId, ...(typeof item.error === "string" ? { error: item.error } : {}),
      createdAt: String(item.createdAt), updatedAt: String(item.updatedAt),
    };
  }

  list(sessionId?: string): ChangeDelivery[] {
    const items = sessionId ? this.persistence?.getWorkItems(sessionId) ?? [] : this.persistence?.getWorkItemsByKind("change_delivery") ?? [];
    return items.filter((item) => item.kind === "change_delivery").map((item) => this.get(item.id)!).filter(Boolean);
  }

  emit(delivery: ChangeDelivery, type: string, payload: Record<string, unknown> = {}): void {
    const event: DeliveryEvent = { type, sessionId: delivery.sessionId, deliveryId: delivery.id, timestamp: new Date().toISOString(), payload };
    this.persistence?.appendEvent(event);
    this.onEvent?.(event);
  }
}
