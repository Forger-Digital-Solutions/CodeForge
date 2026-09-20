import type { HostedExecutionRecord } from "@codeforge/cloud-db";
import { HostedAdmissionAuthority } from "./hosted-admission.js";

export interface HostedQueueExecutionResult {
  status: "completed" | "failed";
  releaseReason?: string;
  resultPayload?: string;
  resultError?: string;
}

export interface HostedQueueWorkerOptions {
  authority: HostedAdmissionAuthority;
  execute(execution: HostedExecutionRecord, signal: AbortSignal): Promise<HostedQueueExecutionResult>;
  heartbeatMs?: number;
  idleWaitMs?: number;
  onError?: (error: unknown, execution?: HostedExecutionRecord) => void;
}

export class HostedQueueWorker {
  private readonly authority: HostedAdmissionAuthority;
  private readonly execute: HostedQueueWorkerOptions["execute"];
  private readonly heartbeatMs: number;
  private readonly idleWaitMs: number;
  private readonly onError?: HostedQueueWorkerOptions["onError"];
  private readonly active = new Map<string, AbortController>();
  private stopped = false;

  constructor(options: HostedQueueWorkerOptions) {
    this.authority = options.authority;
    this.execute = options.execute;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.idleWaitMs = options.idleWaitMs ?? 100;
    this.onError = options.onError;
  }

  async runOnce(): Promise<"executed" | "idle"> {
    if (this.stopped) return "idle";
    const claim = await this.authority.claim();
    if (!claim) return "idle";
    const execution = claim.execution;
    const leaseToken = claim.lease?.id ?? execution.leaseToken;
    if (!leaseToken) throw new Error("Claimed hosted execution is missing its fencing token");
    const controller = new AbortController();
    this.active.set(execution.id, controller);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.authority.beginDispatch(execution.id, leaseToken);
      heartbeat = setInterval(() => {
        void this.authority.heartbeat(execution.id, leaseToken).catch((error) => {
          controller.abort(error instanceof Error ? error : new Error(String(error)));
        });
      }, this.heartbeatMs);
      const result = await this.execute(execution, controller.signal);
      if (!controller.signal.aborted) {
        await this.authority.complete({ executionId: execution.id, userId: execution.userId, leaseToken, status: result.status, releaseReason: result.releaseReason, resultPayload: result.resultPayload, resultError: result.resultError });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          await this.authority.complete({ executionId: execution.id, userId: execution.userId, leaseToken, status: "failed", resultError: error instanceof Error ? error.message : String(error) });
        } catch (completionError) {
          this.onError?.(completionError, execution);
        }
      }
      this.onError?.(error, execution);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.active.delete(execution.id);
    }
    return "executed";
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    while (!this.stopped && !signal?.aborted) {
      const result = await this.runOnce();
      if (result === "idle") await new Promise<void>((resolve) => setTimeout(resolve, this.idleWaitMs));
    }
  }

  cancelLocal(executionId: string, reason = new Error("Task cancelled")): boolean {
    const controller = this.active.get(executionId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  stop(reason = new Error("Worker stopped")): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort(reason);
  }

  activeCount(): number {
    return this.active.size;
  }
}
