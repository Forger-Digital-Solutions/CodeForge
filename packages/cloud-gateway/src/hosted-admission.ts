import type { HostedAdmissionMetrics, HostedCapacityLeaseRecord, HostedExecutionRecord, ICloudDatabase } from "@codeforge/cloud-db";

export type HostedCapacityStateCode = "FREE_CAPACITY_QUEUED" | "FREE_CAPACITY_EXHAUSTED" | "USER_CONCURRENCY_LIMIT" | "TASK_CANCELLED" | "DISPATCH_READY" | "RECOVERY_PENDING";

export interface HostedAdmissionAuthorityOptions {
  db: ICloudDatabase;
  workerId: string;
  leaseMs?: number;
  maxUserConcurrent?: number;
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

export class HostedAdmissionAuthority {
  private readonly db: ICloudDatabase;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxUserConcurrent: number;

  constructor(options: HostedAdmissionAuthorityOptions) {
    this.db = options.db;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxUserConcurrent = options.maxUserConcurrent ?? 1;
  }

  async enqueue(params: { executionId: string; idempotencyKey: string; userId: string; taskId: string; providerId: string; modelId: string; priority?: number; eligibleAt?: string }): Promise<HostedAdmissionResult> {
    assertBoundedIdentifier(params.executionId, "executionId");
    assertBoundedIdentifier(params.idempotencyKey, "idempotencyKey");
    assertBoundedIdentifier(params.taskId, "taskId");
    assertBoundedIdentifier(params.providerId, "providerId", 128);
    assertBoundedIdentifier(params.modelId, "modelId");
    const { execution, created } = await this.db.enqueueHostedExecution({ id: params.executionId, idempotencyKey: params.idempotencyKey, userId: params.userId, taskId: params.taskId, providerId: params.providerId, modelId: params.modelId, priority: params.priority, eligibleAt: params.eligibleAt });
    return { code: execution.status === "cancelled" ? "TASK_CANCELLED" : "FREE_CAPACITY_QUEUED", execution, created };
  }

  async claim(now?: Date): Promise<HostedAdmissionResult | undefined> {
    const claimed = await this.db.claimNextHostedExecution({ workerId: this.workerId, leaseMs: this.leaseMs, maxUserConcurrent: this.maxUserConcurrent, now });
    return claimed ? { code: "DISPATCH_READY", execution: claimed.execution, lease: claimed.lease } : undefined;
  }

  async beginDispatch(executionId: string): Promise<HostedExecutionRecord> {
    return this.db.markHostedExecutionDispatching({ executionId, workerId: this.workerId });
  }

  async heartbeat(executionId: string, now?: Date): Promise<HostedCapacityLeaseRecord> {
    return this.db.renewHostedExecutionLease({ executionId, workerId: this.workerId, leaseMs: this.leaseMs, now });
  }

  async complete(executionId: string, userId: string, status: "completed" | "failed", releaseReason?: string): Promise<{ execution: HostedExecutionRecord; transitioned: boolean }> {
    return this.db.completeHostedExecution({ executionId, userId, status, releaseReason });
  }

  async cancel(executionId: string, authenticatedUserId: string): Promise<HostedAdmissionResult & { dispatchMayHaveStarted: boolean; transitioned: boolean }> {
    const result = await this.db.cancelHostedExecution({ executionId, userId: authenticatedUserId });
    return { code: "TASK_CANCELLED", execution: result.execution, dispatchMayHaveStarted: result.dispatchMayHaveStarted, transitioned: result.transitioned };
  }

  async reconcile(now?: Date): Promise<{ recovered: number; executionIds: string[] }> {
    return this.db.recoverExpiredHostedLeases(now);
  }

  metrics(): Promise<HostedAdmissionMetrics> {
    return this.db.getHostedAdmissionMetrics();
  }
}
