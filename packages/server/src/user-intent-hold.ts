import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, ISessionPersistence, WorkItem } from "@codeforge/sessions";
import { createWorkspaceEventAdapter } from "./workspace-event-adapter.js";

export type DispatchKind = "model" | "tool" | "subagent" | "verifier" | "delivery" | "publication" | "other";
export type HoldReason = "user_composer_active" | "user_steer_queued" | "awaiting_inflight_completion" | "draft_cleared" | "user_intent_hold_disabled" | "reconciled" | "stale_lease" | "terminal";
export type HoldState = "running" | "user_intent_hold" | "steer_queued" | "reconciling_steer";

export interface UserIntentHoldCheckpoint {
  runId: string;
  workItemId?: string;
  currentPlanStep?: string;
  completedSteps: string[];
  pendingSteps: string[];
  activeExecution?: { executionId: string; kind: "tool" | "verifier" | "subagent" | "model" | "other" };
  workspaceGeneration: number;
  stateHash?: string;
  enteredAt: string;
  reason: "user_intent_hold";
}

export interface QueuedUserSteer {
  steerId: string;
  turnId: string;
  message: string;
  submittedAt: string;
  /** CF-17R5 targeted parallel steering: absent for an ordinary session/turn-level steer. */
  targetWorkstreamId?: string;
}

export interface UserIntentHoldSnapshot {
  sessionId: string;
  runId: string;
  turnId?: string;
  state: HoldState;
  reason: HoldReason;
  generation: number;
  enteredAt?: string;
  releasedAt?: string;
  checkpoint?: UserIntentHoldCheckpoint;
  queuedSteers: QueuedUserSteer[];
}

type Waiter = { kind: DispatchKind; resolve: () => void };

function holdItem(snapshot: UserIntentHoldSnapshot, now: string): WorkItem {
  return {
    kind: "user_intent_hold",
    id: `user-intent-hold-${snapshot.sessionId}`,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
    state: snapshot.state,
    reason: snapshot.reason,
    generation: snapshot.generation,
    ...(snapshot.enteredAt ? { enteredAt: snapshot.enteredAt } : {}),
    ...(snapshot.releasedAt ? { releasedAt: snapshot.releasedAt } : {}),
    ...(snapshot.checkpoint ? { checkpoint: snapshot.checkpoint } : {}),
    queuedSteers: snapshot.queuedSteers,
    createdAt: snapshot.enteredAt ?? now,
    updatedAt: now,
  } as WorkItem;
}

function steerReceiptId(sessionId: string, steerId: string): string {
  return `steer-receipt-${sessionId}-${steerId}`;
}

/**
 * A timing-only server barrier. It gates future dispatch boundaries; it never aborts a process,
 * grants authority, or changes verification/completion decisions.
 *
 * `states` is an in-memory read cache, hydrated once from durable storage by {@link init} and kept
 * in sync by every mutating method — it is a performance/ergonomics convenience for synchronous
 * reads (`snapshot`, `queuedSteers`, `hasQueuedSteer`), never the source of truth for correctness.
 * Exactly-once steer acceptance (CF-17R5 §12) is enforced durably via a `steer_receipt` work item
 * with a unique id, inserted through `insertIfAbsent` inside the same transaction that appends the
 * steer to the hold record — so a retried delivery cannot create a duplicate queued steer even
 * across a process restart or concurrent requests, not merely within one process's lifetime.
 */
export class UserIntentHoldController {
  private readonly states = new Map<string, UserIntentHoldSnapshot>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly avoided = new Map<string, number>();
  private readonly avoidedByKind = new Map<string, Record<DispatchKind, number>>();
  private readonly holdStarted = new Map<string, number>();
  private readonly enteredCounts = new Map<string, number>();
  private readonly completedDurations = new Map<string, number>();
  private readonly eventStore: EventStore;
  private readonly persistence: ISessionPersistence;
  private readonly leaseMs: number;

  constructor(options: { eventStore: EventStore; persistence: ISessionPersistence; staleLeaseMs?: number }) {
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.leaseMs = options.staleLeaseMs ?? 60_000;
  }

  /** Must be awaited once before first use — rehydrates in-memory hold state from durable storage. */
  async init(): Promise<void> {
    for (const session of await this.persistence.listSessions()) {
      const items = await this.persistence.getWorkItems(session.id);
      const item = items.find((candidate) => candidate.kind === "user_intent_hold");
      if (!item || item.kind !== "user_intent_hold") continue;
      this.states.set(session.id, {
        sessionId: item.sessionId,
        runId: item.runId,
        ...(item.turnId ? { turnId: item.turnId } : {}),
        state: item.state,
        reason: item.reason,
        generation: item.generation,
        ...(item.enteredAt ? { enteredAt: item.enteredAt } : {}),
        ...(item.releasedAt ? { releasedAt: item.releasedAt } : {}),
        ...(item.checkpoint ? { checkpoint: item.checkpoint } : {}),
        queuedSteers: item.queuedSteers,
      });
    }
  }

  snapshot(sessionId: string): UserIntentHoldSnapshot | undefined {
    const snapshot = this.states.get(sessionId);
    return snapshot ? { ...snapshot, queuedSteers: [...snapshot.queuedSteers] } : undefined;
  }

  async request(sessionId: string, runId: string, turnId?: string, checkpoint?: UserIntentHoldCheckpoint): Promise<UserIntentHoldSnapshot> {
    const prior = this.states.get(sessionId);
    if (prior && (prior.state === "user_intent_hold" || prior.state === "steer_queued" || prior.state === "reconciling_steer")) {
      return this.snapshot(sessionId)!;
    }
    const now = new Date().toISOString();
    const next: UserIntentHoldSnapshot = {
      sessionId,
      runId,
      ...(turnId ? { turnId } : {}),
      state: "user_intent_hold",
      reason: "user_composer_active",
      generation: (prior?.generation ?? 0) + 1,
      enteredAt: now,
      ...(checkpoint ? { checkpoint } : {}),
      queuedSteers: prior?.queuedSteers ?? [],
    };
    this.states.set(sessionId, next);
    this.holdStarted.set(sessionId, Date.now());
    this.enteredCounts.set(sessionId, (this.enteredCounts.get(sessionId) ?? 0) + 1);
    await this.persist(next);
    await this.emit(sessionId, runId, {
      type: "user_intent_hold.entered",
      payload: { runId, ...(turnId ? { turnId } : {}), generation: next.generation, reason: "user_composer_active" },
    });
    return this.snapshot(sessionId)!;
  }

  async release(sessionId: string, generation?: number, reason: "draft_cleared" | "user_intent_hold_disabled" | "reconciled" | "stale_lease" | "terminal" = "draft_cleared"): Promise<boolean> {
    const prior = this.states.get(sessionId);
    if (!prior || generation !== undefined && generation !== prior.generation) return false;
    if (prior.state === "running") return true;
    const now = new Date().toISOString();
    const next = { ...prior, state: "running" as const, reason, releasedAt: now };
    this.states.set(sessionId, next);
    await this.persist(next);
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter.resolve();
    this.waiters.delete(sessionId);
    await this.emit(sessionId, prior.runId, {
      type: "user_intent_hold.released",
      payload: { runId: prior.runId, generation: prior.generation, reason },
    });
    this.holdStarted.delete(sessionId);
    this.completedDurations.set(sessionId, (this.completedDurations.get(sessionId) ?? 0) + (prior.enteredAt ? Math.max(0, Date.now() - Date.parse(prior.enteredAt)) : 0));
    return true;
  }

  async resolveForTerminal(sessionId: string, turnId: string): Promise<void> {
    const prior = this.states.get(sessionId);
    if (!prior || (prior.turnId !== turnId && !prior.queuedSteers.some((steer) => steer.turnId === turnId))) return;
    const now = new Date().toISOString();
    const next: UserIntentHoldSnapshot = {
      ...prior,
      state: "running",
      reason: "terminal",
      releasedAt: now,
      queuedSteers: prior.queuedSteers.filter((steer) => steer.turnId !== turnId),
    };
    this.states.set(sessionId, next);
    await this.persist(next);
    for (const waiter of this.waiters.get(sessionId) ?? []) waiter.resolve();
    this.waiters.delete(sessionId);
    await this.emit(sessionId, prior.runId, {
      type: "user_intent_hold.released",
      payload: { runId: prior.runId, generation: prior.generation, reason: "terminal" },
    });
    this.holdStarted.delete(sessionId);
    this.completedDurations.set(sessionId, (this.completedDurations.get(sessionId) ?? 0) + (prior.enteredAt ? Math.max(0, Date.now() - Date.parse(prior.enteredAt)) : 0));
  }

  /**
   * Durably, exactly-once accepts a steer. `targetWorkstreamId` scopes the steer to one parallel
   * work item (CF-17R5 targeted parallel steering); omitted, it behaves exactly as an ordinary
   * session/turn-level steer always has.
   */
  async queueSteer(sessionId: string, runId: string, turnId: string, message: string, steerId: string, targetWorkstreamId?: string): Promise<QueuedUserSteer> {
    const prior = this.states.get(sessionId) ?? (await this.request(sessionId, runId, turnId));
    const existing = prior.queuedSteers.find((steer) => steer.steerId === steerId);
    if (existing) return existing;

    const submittedAt = new Date().toISOString();
    const steer: QueuedUserSteer = { steerId, turnId, message, submittedAt, ...(targetWorkstreamId ? { targetWorkstreamId } : {}) };

    const accepted = await this.persistence.withTransaction(async (tx) => {
      const receipt: WorkItem = {
        kind: "steer_receipt",
        id: steerReceiptId(sessionId, steerId),
        sessionId,
        steerId,
        turnId,
        ...(targetWorkstreamId ? { targetWorkstreamId } : {}),
        message,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      } as WorkItem;
      const isNew = await tx.insertIfAbsent(receipt);
      if (!isNew) return false;
      const latest = this.states.get(sessionId) ?? prior;
      const next: UserIntentHoldSnapshot = {
        ...latest,
        runId,
        turnId,
        state: "steer_queued",
        reason: "user_steer_queued",
        queuedSteers: [...latest.queuedSteers, steer],
      };
      await tx.upsertWorkItem(holdItem(next, submittedAt));
      this.states.set(sessionId, next);
      return true;
    });

    if (!accepted) {
      // A concurrent/retried delivery of the same steerId already claimed the receipt; the durable
      // queue is the source of truth here, not this call's local `steer` object.
      const settled = this.states.get(sessionId)?.queuedSteers.find((s) => s.steerId === steerId);
      return settled ?? steer;
    }

    const next = this.states.get(sessionId)!;
    await this.emit(sessionId, runId, {
      type: "user_intent_steer.queued",
      payload: { runId, turnId, steerId, position: next.queuedSteers.length - 1 },
    });
    for (const waiter of this.waiters.get(sessionId) ?? []) {
      if (waiter.kind === "model") waiter.resolve();
    }
    return steer;
  }

  async beginReconciliation(sessionId: string, turnId: string, steerIds: string[]): Promise<void> {
    const prior = this.states.get(sessionId);
    if (!prior) return;
    const next = { ...prior, state: "reconciling_steer" as const, reason: "user_steer_queued" as const, turnId };
    this.states.set(sessionId, next);
    await this.persist(next);
    await this.emit(sessionId, prior.runId, { type: "user_intent_steer.reconciliation_started", payload: { runId: prior.runId, turnId, steerIds } });
  }

  async completeReconciliation(sessionId: string, turnId: string, steerIds: string[]): Promise<void> {
    const prior = this.states.get(sessionId);
    if (!prior) return;
    const remaining = prior.queuedSteers.filter((steer) => !steerIds.includes(steer.steerId));
    const next = { ...prior, state: remaining.length > 0 ? "steer_queued" as const : "running" as const, reason: remaining.length > 0 ? "user_steer_queued" as const : "reconciled" as const, queuedSteers: remaining };
    this.states.set(sessionId, next);
    await this.persist(next);
    await this.emit(sessionId, prior.runId, { type: "user_intent_steer.reconciliation_completed", payload: { runId: prior.runId, turnId, steerIds } });
    if (next.state === "running") {
      for (const waiter of this.waiters.get(sessionId) ?? []) waiter.resolve();
      this.waiters.delete(sessionId);
    }
  }

  queuedSteers(sessionId: string): QueuedUserSteer[] {
    return [...(this.states.get(sessionId)?.queuedSteers ?? [])];
  }

  hasQueuedSteer(sessionId: string): boolean {
    return (this.states.get(sessionId)?.queuedSteers.length ?? 0) > 0;
  }

  async waitForDispatch(sessionId: string, kind: DispatchKind): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state || state.state === "running" || state.state === "reconciling_steer" && kind === "model" || state.state === "steer_queued" && kind === "model") return;
    if (state.state === "user_intent_hold" || state.state === "steer_queued") {
      this.avoided.set(sessionId, (this.avoided.get(sessionId) ?? 0) + 1);
      const counts = this.avoidedByKind.get(sessionId) ?? { model: 0, tool: 0, subagent: 0, verifier: 0, delivery: 0, publication: 0, other: 0 };
      counts[kind]++;
      this.avoidedByKind.set(sessionId, counts);
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(sessionId) ?? [];
        waiters.push({ kind, resolve });
        this.waiters.set(sessionId, waiters);
      });
    }
  }

  workAvoided(sessionId: string): number { return this.avoided.get(sessionId) ?? 0; }
  holdCount(sessionId: string): number { return this.enteredCounts.get(sessionId) ?? 0; }
  holdDurationMs(sessionId: string): number {
    const started = this.holdStarted.get(sessionId);
    return (this.completedDurations.get(sessionId) ?? 0) + (started ? Math.max(0, Date.now() - started) : 0);
  }

  metrics(sessionId: string): { userIntentHoldCount: number; userIntentHoldDurationMs: number; modelDispatchesAvoided: number; toolDispatchesAvoided: number; subagentDispatchesAvoided: number; verifierDispatchesAvoided: number; speculativeStepsAvoided: number } {
    const counts = this.avoidedByKind.get(sessionId) ?? { model: 0, tool: 0, subagent: 0, verifier: 0, delivery: 0, publication: 0, other: 0 };
    return {
      userIntentHoldCount: this.holdCount(sessionId),
      userIntentHoldDurationMs: this.holdDurationMs(sessionId),
      modelDispatchesAvoided: counts.model,
      toolDispatchesAvoided: counts.tool,
      subagentDispatchesAvoided: counts.subagent,
      verifierDispatchesAvoided: counts.verifier,
      speculativeStepsAvoided: counts.other + counts.delivery + counts.publication,
    };
  }

  async recoverStaleHolds(now = Date.now()): Promise<void> {
    for (const [sessionId, snapshot] of this.states) {
      const entered = snapshot.enteredAt ? Date.parse(snapshot.enteredAt) : now;
      if (snapshot.state !== "running" && snapshot.queuedSteers.length === 0 && now - entered >= this.leaseMs) await this.release(sessionId, snapshot.generation, "stale_lease");
    }
  }

  private async persist(snapshot: UserIntentHoldSnapshot): Promise<void> {
    await this.persistence.upsertWorkItem(holdItem(snapshot, new Date().toISOString()));
  }

  private async emit(sessionId: string, runId: string, event: Omit<WorkspaceEvent, "seq" | "sessionId" | "timestamp" | "runId">): Promise<void> {
    const adapter = createWorkspaceEventAdapter({ sessionId, runId, eventStore: this.eventStore, persistence: this.persistence });
    await adapter.emit(event as WorkspaceEvent);
  }
}

export async function createUserIntentHoldController(options: { eventStore: EventStore; persistence: ISessionPersistence; staleLeaseMs?: number }): Promise<UserIntentHoldController> {
  const controller = new UserIntentHoldController(options);
  await controller.init();
  return controller;
}
