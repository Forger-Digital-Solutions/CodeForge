import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { SustainabilityReceipt } from "./sustainability-types.js";

export const FORGE_GREEN_SUSTAINABILITY_WORK_ITEM_KIND = "forgegreen_sustainability_receipt" as const;

/**
 * Persists FG-8 sustainability receipts through the SAME `ISessionPersistence` abstraction
 * session/turn/work-item data (and the FG-1E efficiency ledger, and 8-Bit's receipts) already
 * use — no second database. Append-only via `insertIfAbsent`, matching
 * `EightBitDecisionStore.recordReceipt` exactly: a retried write of the same receiptId never
 * duplicates the record, and a finalized receipt is never overwritten in place.
 */
export class SustainabilityReceiptStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async save(receipt: SustainabilityReceipt): Promise<void> {
    const item: WorkItem = {
      kind: FORGE_GREEN_SUSTAINABILITY_WORK_ITEM_KIND,
      id: `forgegreen-sustainability-${receipt.receiptId}`,
      sessionId: receipt.sessionId,
      runId: receipt.runId,
      record: receipt as unknown as Record<string, unknown>,
      createdAt: receipt.createdAt,
    };
    await this.persistence.insertIfAbsent(item);
  }

  async loadByReceiptId(receiptId: string): Promise<SustainabilityReceipt | undefined> {
    const item = await this.persistence.getWorkItem(`forgegreen-sustainability-${receiptId}`);
    if (!item || item.kind !== FORGE_GREEN_SUSTAINABILITY_WORK_ITEM_KIND) return undefined;
    return item.record as unknown as SustainabilityReceipt;
  }

  async loadBySession(sessionId: string): Promise<SustainabilityReceipt[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((i): i is Extract<WorkItem, { kind: typeof FORGE_GREEN_SUSTAINABILITY_WORK_ITEM_KIND }> => i.kind === FORGE_GREEN_SUSTAINABILITY_WORK_ITEM_KIND)
      .map((i) => i.record as unknown as SustainabilityReceipt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async loadByRun(sessionId: string, runId: string): Promise<SustainabilityReceipt[]> {
    const bySession = await this.loadBySession(sessionId);
    return bySession.filter((r) => r.runId === runId);
  }
}

export function createSustainabilityReceiptStore(persistence: ISessionPersistence): SustainabilityReceiptStore {
  return new SustainabilityReceiptStore(persistence);
}
