import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { ForgeGreenOptimizationDecision, ForgeGreenOptimizationReceipt } from "./optimization-types.js";

export const FORGE_GREEN_OPTIMIZATION_DECISION_WORK_ITEM_KIND = "forgegreen_optimization_decision" as const;
export const FORGE_GREEN_OPTIMIZATION_RECEIPT_WORK_ITEM_KIND = "forgegreen_optimization_receipt" as const;

/** Mirrors `SustainabilityReceiptStore`/`EightBitDecisionStore` exactly: the same
 * `ISessionPersistence` abstraction, append-only via `insertIfAbsent` — no second database. */
export class OptimizationDecisionStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async save(decision: ForgeGreenOptimizationDecision): Promise<void> {
    const item: WorkItem = {
      kind: FORGE_GREEN_OPTIMIZATION_DECISION_WORK_ITEM_KIND,
      id: `forgegreen-optimization-decision-${decision.decisionId}`,
      sessionId: decision.sessionId,
      runId: decision.runId,
      record: decision as unknown as Record<string, unknown>,
      createdAt: decision.createdAt,
    };
    await this.persistence.insertIfAbsent(item);
  }

  async loadByDecisionId(decisionId: string): Promise<ForgeGreenOptimizationDecision | undefined> {
    const item = await this.persistence.getWorkItem(`forgegreen-optimization-decision-${decisionId}`);
    if (!item || item.kind !== FORGE_GREEN_OPTIMIZATION_DECISION_WORK_ITEM_KIND) return undefined;
    return item.record as unknown as ForgeGreenOptimizationDecision;
  }

  async loadBySession(sessionId: string): Promise<ForgeGreenOptimizationDecision[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: typeof FORGE_GREEN_OPTIMIZATION_DECISION_WORK_ITEM_KIND }> => i.kind === FORGE_GREEN_OPTIMIZATION_DECISION_WORK_ITEM_KIND)
      .map((i) => i.record as unknown as ForgeGreenOptimizationDecision)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export class OptimizationReceiptStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async save(receipt: ForgeGreenOptimizationReceipt): Promise<void> {
    const item: WorkItem = {
      kind: FORGE_GREEN_OPTIMIZATION_RECEIPT_WORK_ITEM_KIND,
      id: `forgegreen-optimization-receipt-${receipt.receiptId}`,
      sessionId: receipt.sessionId,
      runId: receipt.runId,
      record: receipt as unknown as Record<string, unknown>,
      createdAt: receipt.createdAt,
    };
    await this.persistence.insertIfAbsent(item);
  }

  async loadByReceiptId(receiptId: string): Promise<ForgeGreenOptimizationReceipt | undefined> {
    const item = await this.persistence.getWorkItem(`forgegreen-optimization-receipt-${receiptId}`);
    if (!item || item.kind !== FORGE_GREEN_OPTIMIZATION_RECEIPT_WORK_ITEM_KIND) return undefined;
    return item.record as unknown as ForgeGreenOptimizationReceipt;
  }

  async loadBySession(sessionId: string): Promise<ForgeGreenOptimizationReceipt[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: typeof FORGE_GREEN_OPTIMIZATION_RECEIPT_WORK_ITEM_KIND }> => i.kind === FORGE_GREEN_OPTIMIZATION_RECEIPT_WORK_ITEM_KIND)
      .map((i) => i.record as unknown as ForgeGreenOptimizationReceipt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

export function createOptimizationDecisionStore(persistence: ISessionPersistence): OptimizationDecisionStore {
  return new OptimizationDecisionStore(persistence);
}

export function createOptimizationReceiptStore(persistence: ISessionPersistence): OptimizationReceiptStore {
  return new OptimizationReceiptStore(persistence);
}
