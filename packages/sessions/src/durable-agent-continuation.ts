import type { DesktopWorkerActionResult } from "@codeforge/protocol";
import type { ISessionPersistence } from "./interface.js";
import { WorkItemSchema, type WorkItem } from "./session-state.js";

export type DurableAgentContinuation = Extract<WorkItem, { kind: "agent_continuation" }>;
export type ContinuationMessage = NonNullable<DurableAgentContinuation["messages"]>[number];
export type ContinuationObservation = NonNullable<DurableAgentContinuation["observation"]>;
type WorkerAction = Extract<WorkItem, { kind: "desktop_worker_action" }>;

export interface ContinuationClaim {
  continuation: DurableAgentContinuation;
  result: DesktopWorkerActionResult;
  /** True when the durable context was already advanced by an earlier crashed attempt. */
  contextWasAlreadyAdvanced?: boolean;
}

function resultFromAction(action: WorkerAction): DesktopWorkerActionResult | undefined {
  if (!action.result || action.state === "pending") return undefined;
  return {
    actionId: action.id,
    workerId: action.workerId,
    status: action.state === "succeeded" ? "succeeded" : action.state,
    output: action.result,
    changedResources: [],
  };
}

function assertActionBinding(item: DurableAgentContinuation, action: WorkerAction): void {
  if (
    action.workflowId !== item.workflowId
    || action.sessionId !== item.sessionId
    || action.turnId !== item.turnId
  ) {
    throw new Error("Continuation action binding does not match the durable continuation");
  }
}

function validateContinuation(item: WorkItem | undefined): DurableAgentContinuation {
  if (!item || item.kind !== "agent_continuation") throw new Error("Unknown continuation");
  const parsed = WorkItemSchema.parse(item);
  if (parsed.kind !== "agent_continuation") throw new Error("Unknown continuation");
  return parsed;
}

/**
 * Driver-neutral durable transitions for the semantic tool boundary. This intentionally does not
 * invoke a model: callers reconstruct the real AgentRuntime only after a result is claimed.
 */
export class DurableAgentContinuationStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async create(continuation: DurableAgentContinuation): Promise<{ continuation: DurableAgentContinuation; duplicate: boolean }> {
    if (continuation.version !== 1 && continuation.version !== 2) throw new Error("Unsupported agent continuation version");
    if (continuation.state !== "prepared") throw new Error("A new continuation must begin in the prepared state");
    const inserted = await this.persistence.insertIfAbsent(continuation);
    if (inserted) return { continuation, duplicate: false };
    const existing = validateContinuation(await this.persistence.getWorkItem(continuation.id));
    if (!existing.pendingTool || !continuation.pendingTool || existing.pendingTool.actionId !== continuation.pendingTool.actionId || existing.workflowId !== continuation.workflowId || existing.pendingTool.workflowRevision !== continuation.pendingTool.workflowRevision) {
      throw new Error("Continuation identity conflicts with a different suspended tool boundary");
    }
    return { continuation: existing, duplicate: true };
  }

  /** Moves a prepared boundary to waiting only after its pinned worker action is durable. */
  async markActionIssued(
    continuationId: string,
    parentResume?: { continuationId: string; ownerId: string },
  ): Promise<DurableAgentContinuation> {
    return this.persistence.withTransaction(async (tx) => {
      const item = validateContinuation(await tx.getWorkItem(continuationId));
      if (!item.pendingTool) throw new Error("Continuation missing pending tool");
      const action = await tx.getWorkItem(item.pendingTool.actionId);
      if (!action || action.kind !== "desktop_worker_action") {
        throw new Error("Continuation action is not durably issued with the required binding");
      }
      assertActionBinding(item, action);
      if (item.state === "awaiting_worker") {
        if (!parentResume) return item;
        const parent = validateContinuation(await tx.getWorkItem(parentResume.continuationId));
        if (parent.id === item.id || parent.sessionId !== item.sessionId || parent.workflowId !== item.workflowId || parent.turnId !== item.turnId) {
          throw new Error("Parent continuation does not belong to the same agent turn");
        }
        if (parent.state === "result_consumed" && parent.resumeState === "leased" && parent.resumeLease?.ownerId === parentResume.ownerId) {
          await tx.upsertWorkItem({ ...parent, resumeState: "advanced", resumeLease: undefined, updatedAt: new Date().toISOString() });
        } else if (parent.state !== "result_consumed" || parent.resumeState !== "advanced") {
          throw new Error("Parent continuation resume lease is no longer authoritative");
        }
        return item;
      }
      if (item.state !== "prepared") throw new Error("Continuation is not ready to issue a worker action");

      let parent: DurableAgentContinuation | undefined;
      if (parentResume) {
        parent = validateContinuation(await tx.getWorkItem(parentResume.continuationId));
        if (parent.id === item.id || parent.sessionId !== item.sessionId || parent.workflowId !== item.workflowId || parent.turnId !== item.turnId) {
          throw new Error("Parent continuation does not belong to the same agent turn");
        }
        if (
          parent.state !== "result_consumed"
          || parent.resumeState !== "leased"
          || parent.resumeLease?.ownerId !== parentResume.ownerId
        ) {
          throw new Error("Parent continuation resume lease is no longer authoritative");
        }
      }

      const now = new Date().toISOString();
      const next: DurableAgentContinuation = { ...item, state: "awaiting_worker", updatedAt: now };
      if (parent) {
        await tx.upsertWorkItem({ ...parent, resumeState: "advanced", resumeLease: undefined, updatedAt: now });
      }
      await tx.upsertWorkItem(next);
      return next;
    });
  }

  /** Repairs the only safe pre-binding crash window when the deterministic action was already durable. */
  async rebindPrepared(continuationId: string): Promise<DurableAgentContinuation | undefined> {
    return this.persistence.withTransaction(async (tx) => {
      const item = validateContinuation(await tx.getWorkItem(continuationId));
      if (item.state !== "prepared") return item;
      if (!item.pendingTool) return undefined;
      const action = await tx.getWorkItem(item.pendingTool.actionId);
      if (!action || action.kind !== "desktop_worker_action") return undefined;
      assertActionBinding(item, action);
      const next: DurableAgentContinuation = { ...item, state: "awaiting_worker", updatedAt: new Date().toISOString() };
      await tx.upsertWorkItem(next);
      return next;
    });
  }

  async findAwaitingAction(actionId: string): Promise<DurableAgentContinuation | undefined> {
    return (await this.persistence.getWorkItemsByKind("agent_continuation"))
      .map((item) => {
        try { return validateContinuation(item); } catch { return undefined; }
      })
      .find((item): item is DurableAgentContinuation => !!item && item.pendingTool?.actionId === actionId && item.state === "awaiting_worker");
  }

  async markResultAvailable(actionId: string): Promise<DurableAgentContinuation | undefined> {
    return this.persistence.withTransaction(async (tx) => {
      const continuation = (await tx.getWorkItemsByKind("agent_continuation"))
        .map((item) => {
          try { return validateContinuation(item); } catch { return undefined; }
        })
        .find((item): item is DurableAgentContinuation => !!item && item.pendingTool?.actionId === actionId);
      if (!continuation || continuation.state !== "awaiting_worker") return continuation;
      const action = await tx.getWorkItem(actionId);
      if (!action || action.kind !== "desktop_worker_action") throw new Error("Continuation result is not durably available");
      assertActionBinding(continuation, action);
      if (!resultFromAction(action)) throw new Error("Continuation result is not durably available");
      const next: DurableAgentContinuation = { ...continuation, state: "result_available", resumeState: "ready", updatedAt: new Date().toISOString() };
      await tx.upsertWorkItem(next);
      return next;
    });
  }

  /** Claims one durable result for exactly one later runtime resumption attempt. */
  async claimResult(continuationId: string): Promise<ContinuationClaim | undefined> {
    return this.persistence.withTransaction(async (tx) => {
      await tx.lockWorkItem(continuationId);
      const item = validateContinuation(await tx.getWorkItem(continuationId));
      if (item.state !== "result_available") return undefined;
      if (!item.pendingTool) throw new Error("Continuation missing pending tool");
      const action = await tx.getWorkItem(item.pendingTool.actionId);
      if (!action || action.kind !== "desktop_worker_action") throw new Error("Continuation references an unknown worker action");
      assertActionBinding(item, action);
      const result = resultFromAction(action);
      if (!result) throw new Error("Continuation references an action without a terminal result");
      const next: DurableAgentContinuation = { ...item, state: "result_consumed", resultConsumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await tx.upsertWorkItem(next);
      return { continuation: next, result };
    });
  }

  /**
   * Atomically makes the worker observation part of the next model context and leases the one
   * resumption. A crashed caller can retry after the lease expires; it will reuse the persisted
   * observation instead of claiming or appending it a second time.
   */
  async claimResultForResume(input: {
    continuationId: string;
    ownerId: string;
    messages: DurableAgentContinuation["messages"];
    observation: ContinuationObservation;
    leaseMs: number;
  }): Promise<ContinuationClaim | undefined> {
    return this.persistence.withTransaction(async (tx) => {
      const current = validateContinuation(await tx.getWorkItem(input.continuationId));
      if (current.version !== 2) throw new Error("Unsupported agent continuation version for runtime resume");
      const now = Date.now();
      if (current.resumeState === "advanced") return undefined;
      if (current.resumeLease && typeof current.resumeLease === "object" && Date.parse(current.resumeLease.expiresAt) > now && current.resumeLease.ownerId !== input.ownerId) return undefined;
      if (!current.pendingTool || current.pendingTool.toolCallId !== input.observation.toolCallId || input.observation.resultId !== current.pendingTool.actionId) {
        throw new Error("Continuation observation binding does not match the pending tool");
      }

      const action = await tx.getWorkItem(current.pendingTool.actionId);
      if (!action || action.kind !== "desktop_worker_action") throw new Error("Continuation references an unknown worker action");
      assertActionBinding(current, action);
      const result = resultFromAction(action);
      if (!result) throw new Error("Continuation references an action without a terminal result");

      let next: DurableAgentContinuation;
      let contextWasAlreadyAdvanced = false;
      if (current.state === "result_available") {
        next = {
          ...current,
          state: "result_consumed",
          messages: input.messages,
          observation: input.observation,
          resumeState: "leased",
          resumeLease: { ownerId: input.ownerId, expiresAt: new Date(now + Math.max(1, input.leaseMs)).toISOString() },
          resultConsumedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
      } else if (current.state === "result_consumed" && current.observation) {
        if (current.observation.resultId !== input.observation.resultId || !current.messages?.some((message) => message.role === "tool" && message.toolCallId === input.observation.toolCallId)) {
          throw new Error("Consumed continuation has an inconsistent durable observation");
        }
        contextWasAlreadyAdvanced = true;
        next = {
          ...current,
          resumeState: "leased",
          resumeLease: { ownerId: input.ownerId, expiresAt: new Date(now + Math.max(1, input.leaseMs)).toISOString() },
          updatedAt: new Date(now).toISOString(),
        };
      } else {
        return undefined;
      }

      const parsed = WorkItemSchema.parse(next);
      if (parsed.kind !== "agent_continuation" || parsed.version !== 2) throw new Error("Invalid durable continuation advancement");
      await tx.upsertWorkItem(parsed);
      return { continuation: parsed, result, ...(contextWasAlreadyAdvanced ? { contextWasAlreadyAdvanced: true } : {}) };
    });
  }

  async markResumeAdvanced(continuationId: string, ownerId: string): Promise<void> {
    await this.persistence.withTransaction(async (tx) => {
      const item = validateContinuation(await tx.getWorkItem(continuationId));
      if (item.state !== "result_consumed" || item.resumeState === "advanced") return;
      if (item.resumeLease && typeof item.resumeLease === "object" && item.resumeLease.ownerId !== ownerId) throw new Error("Continuation resume lease is not owned by this runtime");
      await tx.upsertWorkItem({ ...item, resumeState: "advanced", resumeLease: undefined, updatedAt: new Date().toISOString() });
    });
  }

  async block(continuationId: string): Promise<void> {
    await this.persistence.withTransaction(async (tx) => {
      await tx.lockWorkItem(continuationId);
      const item = validateContinuation(await tx.getWorkItem(continuationId));
      if (item.state === "cancelled" || item.state === "blocked") return;
      await tx.upsertWorkItem({
        ...item,
        state: "blocked",
        resumeState: "advanced",
        resumeLease: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async cancelForTurn(turnId: string): Promise<number> {
    return this.cancelMatching((item) => item.turnId === turnId);
  }

  async cancelForWorkflow(workflowId: string): Promise<number> {
    return this.cancelMatching((item) => item.workflowId === workflowId);
  }

  private async cancelMatching(predicate: (item: DurableAgentContinuation) => boolean): Promise<number> {
    return this.persistence.withTransaction(async (tx) => {
      let count = 0;
      for (const raw of await tx.getWorkItemsByKind("agent_continuation")) {
        let item: DurableAgentContinuation;
        try { item = validateContinuation(raw); } catch { continue; }
        if (!predicate(item) || ["cancelled", "blocked"].includes(item.state)) continue;
        await tx.upsertWorkItem({ ...item, state: "cancelled", resumeState: "advanced", resumeLease: undefined, updatedAt: new Date().toISOString() });
        count++;
      }
      return count;
    });
  }
}

export const createDurableAgentContinuationStore = (persistence: ISessionPersistence): DurableAgentContinuationStore => new DurableAgentContinuationStore(persistence);
