import crypto from "node:crypto";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { EightBitRouteHealth } from "./types.js";
import type { DecisionReceipt } from "./types.js";
import type { BindingScope } from "./router.js";
import type { EightBitPolicyMode } from "./eligibility.js";

export interface PersistedRouteState {
  sessionId: string;
  role: string;
  workstreamId?: string;
  providerId: string;
  modelId: string;
  policyMode: EightBitPolicyMode;
  isExactPin: boolean;
  health?: EightBitRouteHealth;
  cooldownUntil?: number;
  manualOverride?: boolean;
}

function routeStateId(scope: BindingScope): string {
  return `eight-bit-route-${scope.sessionId}-${scope.role}-${scope.workstreamId ?? "default"}`;
}

function routeHealthId(sessionId: string, providerId: string, modelId: string): string {
  return `eight-bit-health-${sessionId}-${providerId}-${modelId}`;
}

/**
 * Persists 8-Bit routing/health/receipt state through the SAME `ISessionPersistence`
 * abstraction session/turn/work-item data already uses — no second database, no new driver.
 * SQLite and PostgreSQL both work automatically because `work_items` stores each kind as an
 * opaque JSON blob keyed by id/kind (see `packages/sessions/src/persistence.ts`).
 */
export class EightBitDecisionStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async saveRouteState(scope: BindingScope, state: PersistedRouteState): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.persistence.getWorkItem(routeStateId(scope));
    const item: WorkItem = {
      kind: "eight_bit_route_state",
      id: routeStateId(scope),
      sessionId: scope.sessionId,
      role: scope.role,
      workstreamId: scope.workstreamId,
      providerId: state.providerId,
      modelId: state.modelId,
      policyMode: state.policyMode,
      isExactPin: state.isExactPin,
      health: state.health as Record<string, unknown> | undefined,
      cooldownUntil: state.cooldownUntil,
      manualOverride: state.manualOverride,
      createdAt: existing?.kind === "eight_bit_route_state" ? existing.createdAt : now,
      updatedAt: now,
    };
    await this.persistence.upsertWorkItem(item);
  }

  async loadRouteState(scope: BindingScope): Promise<PersistedRouteState | undefined> {
    const item = await this.persistence.getWorkItem(routeStateId(scope));
    if (!item || item.kind !== "eight_bit_route_state") return undefined;
    return {
      sessionId: item.sessionId,
      role: item.role,
      workstreamId: item.workstreamId,
      providerId: item.providerId,
      modelId: item.modelId,
      policyMode: item.policyMode,
      isExactPin: item.isExactPin,
      health: item.health as EightBitRouteHealth | undefined,
      cooldownUntil: item.cooldownUntil,
      manualOverride: item.manualOverride,
    };
  }

  async loadAllRouteStates(sessionId: string): Promise<PersistedRouteState[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: "eight_bit_route_state" }> => i.kind === "eight_bit_route_state")
      .map((item) => ({
        sessionId: item.sessionId,
        role: item.role,
        workstreamId: item.workstreamId,
        providerId: item.providerId,
        modelId: item.modelId,
        policyMode: item.policyMode,
        isExactPin: item.isExactPin,
        health: item.health as EightBitRouteHealth | undefined,
        cooldownUntil: item.cooldownUntil,
        manualOverride: item.manualOverride,
      }));
  }

  /** Persists the live health snapshot for ONE route, independent of whatever scope is
   * currently bound to it — this is what lets a route that failed and was rotated away from
   * stay excluded after a restart, even though the current binding row now names its
   * replacement. Idempotent upsert keyed by (session, provider, model). */
  async saveRouteHealth(sessionId: string, providerId: string, modelId: string, health: EightBitRouteHealth): Promise<void> {
    await this.persistence.upsertWorkItem({
      kind: "eight_bit_route_health",
      id: routeHealthId(sessionId, providerId, modelId),
      sessionId,
      providerId,
      modelId,
      health: health as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    });
  }

  async loadAllRouteHealth(sessionId: string): Promise<EightBitRouteHealth[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: "eight_bit_route_health" }> => i.kind === "eight_bit_route_health")
      .map((i) => i.health as unknown as EightBitRouteHealth);
  }

  /** Append-only. Uses `insertIfAbsent` (the same durable idempotency primitive CF-17R5 steer
   * receipts use) so a retried write of the same receiptId never duplicates the record. */
  async recordReceipt(receipt: DecisionReceipt): Promise<void> {
    const item: WorkItem = {
      kind: "eight_bit_decision_receipt",
      id: `eight-bit-receipt-${receipt.receiptId}`,
      sessionId: receipt.sessionId,
      receipt: receipt as unknown as Record<string, unknown>,
      createdAt: receipt.createdAt,
    };
    await this.persistence.insertIfAbsent(item);
  }

  async listReceipts(sessionId: string): Promise<DecisionReceipt[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: "eight_bit_decision_receipt" }> => i.kind === "eight_bit_decision_receipt")
      .map((i) => i.receipt as unknown as DecisionReceipt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export function newReceiptId(): string {
  return crypto.randomUUID();
}

export function createEightBitDecisionStore(persistence: ISessionPersistence): EightBitDecisionStore {
  return new EightBitDecisionStore(persistence);
}
