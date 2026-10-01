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
  /**
   * Durable cancellation poll cadence for this worker's ACTIVE executions — one batched query per
   * tick regardless of how many executions are in flight. Cross-process cancellation is normally
   * delivered by the event channel within milliseconds; this bounded poll exists so a missed
   * notification can never make a cancellation disappear.
   */
  cancelObserveMs?: number;
  /** Maximum independent durable dispatches this process may execute at once. */
  maxConcurrentDispatches?: number;
  /**
   * Resolves the provider-side dispatch identity for an execution when the route's adapter
   * declares idempotent dispatch semantics. Persisted at dispatch so a post-dispatch recovery can
   * distinguish safe_retry from ambiguous.
   */
  resolveDispatchIdentity?: (execution: HostedExecutionRecord) => string | undefined;
  onError?: (error: unknown, execution?: HostedExecutionRecord) => void;
}

export class HostedQueueWorker {
  private readonly authority: HostedAdmissionAuthority;
  private readonly execute: HostedQueueWorkerOptions["execute"];
  private readonly heartbeatMs: number;
  private readonly idleWaitMs: number;
  private readonly cancelObserveMs: number;
  private readonly maxConcurrentDispatches: number;
  private readonly resolveDispatchIdentity?: HostedQueueWorkerOptions["resolveDispatchIdentity"];
  private readonly onError?: HostedQueueWorkerOptions["onError"];
  private readonly active = new Map<string, AbortController>();
  private stopped = false;
  private cancelTimer?: NodeJS.Timeout;
  private terminalCheck?: Promise<void>;
  private terminalCheckPending = false;

  constructor(options: HostedQueueWorkerOptions) {
    this.authority = options.authority;
    this.execute = options.execute;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.idleWaitMs = options.idleWaitMs ?? 100;
    this.cancelObserveMs = options.cancelObserveMs ?? 2_000;
    this.maxConcurrentDispatches = Math.max(1, Math.floor(options.maxConcurrentDispatches ?? 1));
    this.resolveDispatchIdentity = options.resolveDispatchIdentity;
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
      await this.authority.beginDispatch(execution.id, leaseToken, this.resolveDispatchIdentity?.(execution));
      // A cancellation committed between claim and dispatch would otherwise waste one provider
      // call before the observer notices — one indexed read closes that window.
      await this.observeCancellations([execution.id]);
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Execution was cancelled before dispatch");
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
    if (!this.cancelTimer) {
      this.cancelTimer = setInterval(() => void this.observeCancellations("*"), this.cancelObserveMs);
      this.cancelTimer.unref();
    }
    const inFlight = new Set<Promise<void>>();
    try {
      while (!this.stopped && !signal?.aborted) {
        while (!this.stopped && !signal?.aborted && inFlight.size < this.maxConcurrentDispatches) {
          let task!: Promise<void>;
          task = this.runOnce()
            .then(async (result) => {
              if (result === "idle") await new Promise<void>((resolve) => setTimeout(resolve, this.idleWaitMs));
            })
            .catch((error) => { this.onError?.(error); })
            .finally(() => { inFlight.delete(task); });
          inFlight.add(task);
        }
        if (inFlight.size > 0) await Promise.race(inFlight);
      }
    } finally {
      if (this.cancelTimer) clearInterval(this.cancelTimer);
      this.cancelTimer = undefined;
      await Promise.allSettled(inFlight);
    }
  }

  cancelLocal(executionId: string, reason = new Error("Task cancelled")): boolean {
    const controller = this.active.get(executionId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  /**
   * Cross-process cancellation observation. The event channel's payload is only a hint — this is
   * the authoritative step: one batched query confirms which of this worker's active executions
   * actually reached a terminal state in the durable store, then aborts exactly those. Coalesced:
   * concurrent triggers share one in-flight query and at most one follow-up.
   */
  async observeCancellations(scope: string[] | "*"): Promise<void> {
    const ids = scope === "*" ? [...this.active.keys()] : scope.filter((id) => this.active.has(id));
    if (ids.length === 0 && !this.terminalCheckPending) return;
    if (this.terminalCheck) {
      this.terminalCheckPending = true;
      return this.terminalCheck;
    }
    this.terminalCheck = (async () => {
      try {
        const terminal = await this.authority.listTerminalExecutionIds(ids.length ? ids : [...this.active.keys()]);
        for (const id of terminal) {
          this.cancelLocal(id, new Error("Execution reached a terminal state in the durable store"));
        }
      } catch {
        // Fail closed: a failed observation is retried on the next tick — never treated as "still running".
      } finally {
        this.terminalCheck = undefined;
        if (this.terminalCheckPending) {
          this.terminalCheckPending = false;
          void this.observeCancellations("*");
        }
      }
    })();
    return this.terminalCheck;
  }

  stop(reason = new Error("Worker stopped")): void {
    this.stopped = true;
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.cancelTimer = undefined;
    for (const controller of this.active.values()) controller.abort(reason);
  }

  activeCount(): number {
    return this.active.size;
  }
}
