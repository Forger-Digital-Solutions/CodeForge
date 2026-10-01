import { randomUUID } from "node:crypto";
import type { HostedExecutionEventSubscription, HostedExecutionRecord, HostedExecutionTreeStats, HostedFanOutLimits, ICloudDatabase } from "@codeforge/cloud-db";
import { REGION_UNKNOWN, type RegionResolution } from "@codeforge/legal-policy";
import { HostedAdmissionAuthority, MAX_HOSTED_PAYLOAD_CHARS } from "./hosted-admission.js";
import { HostedQueueWorker } from "./hosted-queue-worker.js";
import type { GatewayService, HostedInferenceOutcome, HostedRouteResolution } from "./gateway-service.js";
import { HostedInferenceRequestSchema, type HostedInferenceRequest, type HostedStreamEvent } from "./types.js";

/**
 * Durable payload persisted on hosted_executions.request_payload at enqueue time. The route is
 * frozen here so the worker executes the exact model the admission authority accounted for —
 * it never re-routes a queued request onto a different provider.
 */
export interface PersistedHostedRequest {
  request: HostedInferenceRequest;
  region: RegionResolution;
  route: HostedRouteResolution;
}

export interface HostedExecutionResultPayload {
  outcome?: HostedInferenceOutcome;
  events: HostedStreamEvent[];
  error?: string;
}

export interface HostedRuntimeOptions {
  db: ICloudDatabase;
  gateway: GatewayService;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  idleWaitMs?: number;
  maxUserConcurrent?: number;
  reconcileMs?: number;
  /**
   * Durable cancellation poll cadence for the worker's active set (default 2s). Event-channel
   * delivery is the fast path; this is the bounded fallback that makes a missed notification
   * recoverable instead of silent.
   */
  cancelObserveMs?: number;
  /**
   * Durable fan-out policy for subagent trees, enforced inside the enqueue transaction under
   * parent/root row locks — never client-supplied. Defaults: 8 children per parent, 64
   * descendants per root, depth 4.
   */
  fanOutLimits?: HostedFanOutLimits;
  /**
   * Concurrency ceiling applied when a resolved route has no capacity row yet. Conservative
   * default: free-tier provider routes rate-limit hard, so unmeasured routes start at 1 — an
   * operator raises the durable ceiling explicitly after measuring real headroom.
   */
  defaultRouteCapacity?: number;
  maxConcurrentDispatches?: number;
  onError?: (error: unknown, execution?: HostedExecutionRecord) => void;
}

export interface HostedEnqueueResult {
  execution: HostedExecutionRecord;
  created: boolean;
}

export class HostedRuntime {
  readonly authority: HostedAdmissionAuthority;
  private readonly db: ICloudDatabase;
  private readonly gateway: GatewayService;
  private readonly defaultRouteCapacity: number;
  private readonly maxConcurrentDispatches: number;
  private readonly worker: HostedQueueWorker;
  private readonly reconcileMs: number;
  private readonly fanOutLimits: Required<HostedFanOutLimits>;
  private eventSubscription?: HostedExecutionEventSubscription;
  private reconcileTimer?: NodeJS.Timeout;
  private capacitySyncTimer?: NodeJS.Timeout;
  private runLoop?: Promise<void>;
  private running = false;

  constructor(options: HostedRuntimeOptions) {
    this.db = options.db;
    this.gateway = options.gateway;
    this.defaultRouteCapacity = options.defaultRouteCapacity ?? 1;
    this.maxConcurrentDispatches = Math.max(1, Math.floor(options.maxConcurrentDispatches ?? 1));
    this.authority = new HostedAdmissionAuthority({
      db: options.db,
      workerId: options.workerId ?? `hosted-worker-${randomUUID()}`,
      leaseMs: options.leaseMs,
      maxUserConcurrent: options.maxUserConcurrent,
      // Fail closed on capability: only claim routes whose provider adapter is live in this
      // process. In a multi-catalog fleet a foreign execution must stay queued for a worker
      // that can run it — never be claimed and failed by one that cannot.
      claimableProviderIds: () => this.gateway.claimableProviderIds(),
    });
    this.reconcileMs = options.reconcileMs ?? 30_000;
    this.fanOutLimits = {
      maxChildrenPerParent: options.fanOutLimits?.maxChildrenPerParent ?? 8,
      maxDescendantsPerRoot: options.fanOutLimits?.maxDescendantsPerRoot ?? 64,
      maxDepth: options.fanOutLimits?.maxDepth ?? 4,
    };
    this.worker = new HostedQueueWorker({
      authority: this.authority,
      heartbeatMs: options.heartbeatMs,
      idleWaitMs: options.idleWaitMs,
      cancelObserveMs: options.cancelObserveMs,
      maxConcurrentDispatches: this.maxConcurrentDispatches,
      // The dispatch identity is the execution's own id — stable across retries, so a provider
      // that dedupes on it can never double-execute a requeued dispatch. Only minted for routes
      // whose adapter actually transmits it; every other route stays null → ambiguous recovery.
      resolveDispatchIdentity: (execution) => this.gateway.supportsDispatchIdentity(execution.providerId) ? execution.id : undefined,
      onError: options.onError,
      execute: (execution, signal) => this.executePersisted(execution, signal),
    });
  }

  /**
   * Admission phase: resolves the ForgeZero-safe route NOW (fail closed on denial), persists the
   * request + route durably, and enqueues through the global capacity/fairness authority. No
   * provider call happens here — execution belongs exclusively to the queue worker.
   */
  async enqueue(userId: string, request: HostedInferenceRequest, region: RegionResolution = REGION_UNKNOWN): Promise<HostedEnqueueResult> {
    const route = await this.gateway.resolveHostedRoute(userId, request, region);
    const payload: PersistedHostedRequest = { request, region, route };
    await this.syncProviderCapacity();
    // Ensure the resolved route is claimable; never overwrites an operator-tuned ceiling.
    await this.db.ensureHostedProviderCapacity({ providerId: route.providerId, modelId: route.modelId, maxConcurrent: this.defaultRouteCapacity });
    const { execution, created } = await this.authority.enqueue({
      executionId: randomUUID(),
      idempotencyKey: request.requestId,
      userId,
      taskId: request.turnId ?? request.requestId,
      providerId: route.providerId,
      modelId: route.modelId,
      requestPayload: JSON.stringify(payload),
    });
    return { execution, created: created ?? false };
  }

  async enqueueChild(userId: string, parentExecutionId: string, request: HostedInferenceRequest, region: RegionResolution = REGION_UNKNOWN): Promise<HostedEnqueueResult> {
    const parent = await this.authority.get(parentExecutionId, userId);
    if (!parent) throw new Error("Parent hosted execution not found");
    const route = await this.gateway.resolveHostedRoute(userId, request, region);
    const payload: PersistedHostedRequest = { request, region, route };
    await this.syncProviderCapacity();
    await this.db.ensureHostedProviderCapacity({ providerId: route.providerId, modelId: route.modelId, maxConcurrent: this.defaultRouteCapacity });
    const { execution, created } = await this.authority.enqueue({
      executionId: randomUUID(),
      idempotencyKey: request.requestId,
      userId,
      taskId: request.turnId ?? request.requestId,
      providerId: route.providerId,
      modelId: route.modelId,
      requestPayload: JSON.stringify(payload),
      parentExecutionId,
      rootExecutionId: parent.rootExecutionId ?? parent.id,
      fanOutLimits: this.fanOutLimits,
    });
    return { execution, created: created ?? false };
  }

  async status(executionId: string, userId: string): Promise<HostedExecutionRecord | undefined> {
    return this.authority.get(executionId, userId);
  }

  async result(executionId: string, userId: string): Promise<{ execution: HostedExecutionRecord; result?: HostedExecutionResultPayload } | undefined> {
    const execution = await this.authority.get(executionId, userId);
    if (!execution) return undefined;
    const result = execution.resultPayload ? (JSON.parse(execution.resultPayload) as HostedExecutionResultPayload) : undefined;
    return { execution, result };
  }

  async streamEvents(executionId: string, userId: string, afterSequence: number) {
    const rows = await this.db.listHostedExecutionStreamEvents({ executionId, userId, afterSequence });
    return rows.map((row) => ({ sequence: row.sequence, event: JSON.parse(row.payload) as HostedStreamEvent }));
  }

  /**
   * Owner-scoped cancellation. The durable authority terminalizes the record and releases
   * capacity in one transaction; cancelLocal additionally aborts in-process execution now
   * instead of waiting for the next heartbeat tick.
   */
  async cancel(executionId: string, userId: string): Promise<{ execution: HostedExecutionRecord; dispatchMayHaveStarted: boolean; transitioned: boolean; cancelledChildIds: string[] }> {
    const cancelled = await this.authority.cancel(executionId, userId);
    this.worker.cancelLocal(executionId, new Error("Cancelled by user"));
    for (const childId of cancelled.cancelledChildIds) this.worker.cancelLocal(childId, new Error("Cancelled by parent"));
    return cancelled;
  }

  async listChildren(executionId: string, userId: string): Promise<HostedExecutionRecord[]> {
    return this.authority.listChildren(executionId, userId);
  }

  /** Owner-scoped aggregate view of one execution tree — counts and statuses only, no payloads. */
  async treeStats(rootExecutionId: string, userId: string): Promise<HostedExecutionTreeStats | undefined> {
    return this.authority.treeStats(rootExecutionId, userId);
  }

  /** Reclaims expired leases: pre-dispatch claims requeue safely, post-dispatch losses quarantine. */
  async reconcile(now?: Date): Promise<{ recovered: number; executionIds: string[] }> {
    return this.authority.reconcile(now);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Cross-process wake-up: a cancellation committed on a different API instance emits a
    // correlation-only event. The handler never trusts the payload — observeCancellations
    // re-reads the durable rows and only aborts executions confirmed terminal. A failed
    // subscription (or a dropped listener, which emits a resync event) degrades to the
    // worker's bounded durable poll — a lost signal is recoverable, never silent.
    this.db.subscribeHostedExecutionEvents((event) => {
      void this.worker.observeCancellations(event.executionIds === "*" ? "*" : event.executionIds);
    }).then((sub) => {
      if (this.running) this.eventSubscription = sub;
      else void sub.close().catch(() => undefined);
    }).catch(() => undefined);
    void this.authority.reconcile().catch(() => undefined);
    this.capacitySyncTimer = setInterval(() => void this.syncProviderCapacity().catch(() => undefined), 5_000);
    this.capacitySyncTimer.unref();
    this.reconcileTimer = setInterval(() => void this.authority.reconcile().catch(() => undefined), this.reconcileMs);
    this.reconcileTimer.unref();
    this.runLoop = this.worker.run().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.capacitySyncTimer) clearInterval(this.capacitySyncTimer);
    if (this.eventSubscription) await this.eventSubscription.close().catch(() => undefined);
    this.eventSubscription = undefined;
    this.worker.stop(new Error("Hosted runtime shutting down"));
    await this.runLoop;
  }

  async syncProviderCapacity(): Promise<void> {
    const snapshots = this.gateway.capacitySnapshot();
    await Promise.all(snapshots.map((route) => this.db.setHostedProviderCapacity(route)));
  }

  private async executePersisted(execution: HostedExecutionRecord, signal: AbortSignal) {
    if (!execution.requestPayload) throw new Error("Persisted hosted execution is missing its request payload");
    const persisted = JSON.parse(execution.requestPayload) as PersistedHostedRequest;
    const request = HostedInferenceRequestSchema.parse(persisted.request);
    const region = persisted.region ?? REGION_UNKNOWN;
    const route = persisted.route ?? { providerId: execution.providerId, modelId: execution.modelId, planId: "free", maxConcurrent: 1, estimatedCredits: 5_000 };

    const events: HostedStreamEvent[] = [];
    let eventWrites = Promise.resolve();
    const emit = (event: HostedStreamEvent) => {
      events.push(event);
      eventWrites = eventWrites.then(async () => {
        await this.db.appendHostedExecutionStreamEvent({ executionId: execution.id, userId: execution.userId, payload: JSON.stringify(event) });
      }).catch(() => undefined);
    };
    const terminalize = (status: "completed" | "failed", error?: string, outcome?: HostedInferenceOutcome) => {
      const payload: HostedExecutionResultPayload = { outcome, events, error };
      let resultPayload = JSON.stringify(payload);
      if (resultPayload.length > MAX_HOSTED_PAYLOAD_CHARS) {
        // Stream events are replay convenience, not the result of record — if a long transcript
        // would exceed the durable bound, persist the terminal outcome and terminal events only.
        resultPayload = JSON.stringify({ outcome, error, events: events.filter((e) => e.type === "usage.updated" || e.type === "turn.completed" || e.type === "turn.failed") });
      }
      return { status, resultPayload, resultError: error };
    };

    try {
      // Re-run the fail-closed eligibility gate at dispatch time: the model may have left the
      // verified-free pool, or the operator may have thrown a kill switch, since enqueue.
      this.gateway.assertRouteEligible(route, request, region);
      const outcome = await this.gateway.runResolvedHostedInference(execution.userId, request, route, emit, signal, execution.providerDispatchId ?? undefined);
      emit({ type: "turn.completed", turnId: request.turnId ?? request.requestId });
      await eventWrites;
      return terminalize("completed", undefined, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "turn.failed", turnId: request.turnId ?? request.requestId, error: message });
      await eventWrites;
      return terminalize("failed", message);
    }
  }
}
