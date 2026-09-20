import type { HostedAdmissionMetrics, HostedCapacityLeaseRecord, HostedExecutionRecord, HostedExecutionTreeStats, HostedFanOutLimits, ICloudDatabase } from "@codeforge/cloud-db";

export type HostedCapacityStateCode = "FREE_CAPACITY_QUEUED" | "FREE_CAPACITY_EXHAUSTED" | "USER_CONCURRENCY_LIMIT" | "TASK_CANCELLED" | "DISPATCH_READY" | "RECOVERY_PENDING";

export const MAX_HOSTED_PAYLOAD_CHARS = 1_000_000;

export interface HostedAdmissionAuthorityOptions {
  db: ICloudDatabase;
  workerId: string;
  leaseMs?: number;
  maxUserConcurrent?: number;
  /**
   * Capability scope evaluated per claim: the provider ids this worker can actually execute.
   * A claim never selects an execution for a provider outside the set — claiming work it cannot
   * run would terminalize someone else's request with a fabricated failure.
   */
  claimableProviderIds?: () => string[];
}

export interface HostedAdmissionResult {
  code: HostedCapacityStateCode;
  execution: HostedExecutionRecord;
  created?: boolean;
  lease?: HostedCapacityLeaseRecord;
}

function assertBoundedIdentifier(value: string, name: string, maxLength = 255): void {
  if (value.length < 1 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} must be 1-${maxLength} printable characters`);
}

function assertBoundedPayload(value: string | undefined, name: string): void {
  if (value !== undefined && value.length > MAX_HOSTED_PAYLOAD_CHARS) throw new Error(`${name} exceeds ${MAX_HOSTED_PAYLOAD_CHARS} characters`);
}

export class HostedAdmissionAuthority {
  private readonly db: ICloudDatabase;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxUserConcurrent: number;
  private readonly claimableProviderIds?: () => string[];

  constructor(options: HostedAdmissionAuthorityOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxUserConcurrent = options.maxUserConcurrent ?? 1;
    this.claimableProviderIds = options.claimableProviderIds;
  }

  get id(): string {
    return this.workerId;
  }

  async enqueue(params: { executionId: string; idempotencyKey: string; userId: string; taskId: string; providerId: string; modelId: string; priority?: number; eligibleAt?: string; requestPayload?: string; parentExecutionId?: string; rootExecutionId?: string; fanOutLimits?: HostedFanOutLimits }): Promise<HostedAdmissionResult> {
    assertBoundedIdentifier(params.executionId, "executionId");
    assertBoundedIdentifier(params.idempotencyKey, "idempotencyKey");
    assertBoundedIdentifier(params.taskId, "taskId");
    assertBoundedIdentifier(params.providerId, "providerId", 128);
    assertBoundedIdentifier(params.modelId, "modelId");
    assertBoundedPayload(params.requestPayload, "requestPayload");
    if (params.parentExecutionId) assertBoundedIdentifier(params.parentExecutionId, "parentExecutionId");
    if (params.rootExecutionId) assertBoundedIdentifier(params.rootExecutionId, "rootExecutionId");
    const { execution, created } = await this.db.enqueueHostedExecution({ id: params.executionId, idempotencyKey: params.idempotencyKey, userId: params.userId, taskId: params.taskId, providerId: params.providerId, modelId: params.modelId, priority: params.priority, eligibleAt: params.eligibleAt, requestPayload: params.requestPayload, parentExecutionId: params.parentExecutionId, rootExecutionId: params.rootExecutionId, fanOutLimits: params.fanOutLimits });
    return { code: execution.status === "cancelled" ? "TASK_CANCELLED" : "FREE_CAPACITY_QUEUED", execution, created };
  }

  async claim(now?: Date): Promise<HostedAdmissionResult | undefined> {
    const claimed = await this.db.claimNextHostedExecution({ workerId: this.workerId, leaseMs: this.leaseMs, maxUserConcurrent: this.maxUserConcurrent, providerIds: this.claimableProviderIds?.(), now });
    return claimed ? { code: "DISPATCH_READY", execution: claimed.execution, lease: claimed.lease } : undefined;
  }

  async get(executionId: string, userId: string): Promise<HostedExecutionRecord | undefined> {
    return this.db.getHostedExecution(executionId, userId);
  }

  async list(userId: string, limit?: number): Promise<HostedExecutionRecord[]> {
    return this.db.listHostedExecutions(userId, limit);
  }

  async listChildren(executionId: string, userId: string): Promise<HostedExecutionRecord[]> {
    return this.db.listHostedExecutionChildren(executionId, userId);
  }

  async beginDispatch(executionId: string, leaseToken: string, providerDispatchId?: string): Promise<HostedExecutionRecord> {
    return this.db.markHostedExecutionDispatching({ executionId, workerId: this.workerId, leaseToken, providerDispatchId });
  }

  /** Batched terminal check for the cancellation observer — one query for the whole active set. */
  async listTerminalExecutionIds(executionIds: string[]): Promise<string[]> {
    return this.db.listHostedTerminalExecutionIds(executionIds);
  }

  async listExecutionsByStatus(status: "recovery_pending", limit?: number): Promise<HostedExecutionRecord[]> {
    return this.db.listHostedExecutionsByStatus(status, limit);
  }

  async treeStats(rootExecutionId: string, userId: string): Promise<HostedExecutionTreeStats | undefined> {
    return this.db.getHostedExecutionTreeStats(rootExecutionId, userId);
  }

  async heartbeat(executionId: string, leaseToken: string, now?: Date): Promise<HostedCapacityLeaseRecord> {
    return this.db.renewHostedExecutionLease({ executionId, workerId: this.workerId, leaseToken, leaseMs: this.leaseMs, now });
  }

  async complete(params: { executionId: string; userId: string; leaseToken: string; status: "completed" | "failed"; releaseReason?: string; resultPayload?: string; resultError?: string }): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    assertBoundedPayload(params.resultPayload, "resultPayload");
    return this.db.completeHostedExecution({ executionId: params.executionId, userId: params.userId, workerId: this.workerId, leaseToken: params.leaseToken, status: params.status, releaseReason: params.releaseReason, resultPayload: params.resultPayload, resultError: params.resultError });
  }

  async cancel(executionId: string, authenticatedUserId: string): Promise<HostedAdmissionResult & { dispatchMayHaveStarted: boolean; transitioned: boolean; cancelledChildIds: string[] }> {
    const result = await this.db.cancelHostedExecution({ executionId, userId: authenticatedUserId });
    return { code: "TASK_CANCELLED", execution: result.execution, dispatchMayHaveStarted: result.dispatchMayHaveStarted, transitioned: result.transitioned, cancelledChildIds: result.cancelledChildIds };
  }

  async resolveRecoveryPending(executionId: string, reason?: string, resolution?: "failed" | "requeue"): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.db.resolveHostedRecoveryPending({ executionId, workerId: this.workerId, reason, resolution });
  }

  async reconcile(now?: Date): Promise<{ recovered: number; executionIds: string[] }> {
    return this.db.recoverExpiredHostedLeases(now);
  }

  metrics(): Promise<HostedAdmissionMetrics> {
    return this.db.getHostedAdmissionMetrics();
  }
}
