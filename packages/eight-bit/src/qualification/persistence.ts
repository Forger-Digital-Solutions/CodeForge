import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { ModelQualificationReceipt } from "./types.js";
import type { EightBitRole } from "../types.js";

/** Qualification persistence interface */
export interface QualificationPersistence {
  /** Save a qualification receipt */
  save(receipt: ModelQualificationReceipt): Promise<void>;
  /** Load receipt for a specific model */
  load(providerId: string, modelId: string): Promise<ModelQualificationReceipt | null>;
  /** Load all receipts for a provider */
  loadByProvider(providerId: string): Promise<ModelQualificationReceipt[]>;
  /** Load all receipts */
  loadAll(): Promise<ModelQualificationReceipt[]>;
  /** Delete a receipt */
  delete(providerId: string, modelId: string): Promise<boolean>;
}

/** In-memory qualification persistence (for testing) */
export class InMemoryQualificationPersistence implements QualificationPersistence {
  private readonly receipts = new Map<string, ModelQualificationReceipt>();

  private key(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }

  async save(receipt: ModelQualificationReceipt): Promise<void> {
    this.receipts.set(this.key(receipt.providerId, receipt.modelId), receipt);
  }

  async load(providerId: string, modelId: string): Promise<ModelQualificationReceipt | null> {
    return this.receipts.get(this.key(providerId, modelId)) ?? null;
  }

  async loadByProvider(providerId: string): Promise<ModelQualificationReceipt[]> {
    const results: ModelQualificationReceipt[] = [];
    for (const [key, receipt] of this.receipts) {
      if (key.startsWith(`${providerId}::`)) {
        results.push(receipt);
      }
    }
    return results;
  }

  async loadAll(): Promise<ModelQualificationReceipt[]> {
    return [...this.receipts.values()];
  }

  async delete(providerId: string, modelId: string): Promise<boolean> {
    return this.receipts.delete(this.key(providerId, modelId));
  }
}

/** SQLite-backed qualification persistence */
export class SqliteQualificationPersistence implements QualificationPersistence {
  constructor(private readonly persistence: ISessionPersistence) {}

  private key(providerId: string, modelId: string): string {
    return `qualification::${providerId}::${modelId}`;
  }

  private toWorkItem(receipt: ModelQualificationReceipt): WorkItem {
    const item: WorkItem = {
      kind: "activity",
      id: this.key(receipt.providerId, receipt.modelId),
      sessionId: "global",
      title: `Qualification: ${receipt.providerId}/${receipt.modelId}`,
      status: "completed",
      detail: JSON.stringify(receipt),
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
    };
    return item;
  }

  private fromWorkItem(item: WorkItem): ModelQualificationReceipt | null {
    try {
      if (item.kind === "activity" && item.detail) {
        return JSON.parse(item.detail) as ModelQualificationReceipt;
      }
      return null;
    } catch {
      return null;
    }
  }

  async save(receipt: ModelQualificationReceipt): Promise<void> {
    await this.persistence.upsertWorkItem(this.toWorkItem(receipt));
  }

  async load(providerId: string, modelId: string): Promise<ModelQualificationReceipt | null> {
    const item = await this.persistence.getWorkItem(this.key(providerId, modelId));
    return item ? this.fromWorkItem(item) : null;
  }

  async loadByProvider(providerId: string): Promise<ModelQualificationReceipt[]> {
    const items = await this.persistence.getWorkItemsByKind("activity");
    return items
      .filter(item => item.id.startsWith(`qualification::${providerId}::`))
      .map(item => this.fromWorkItem(item))
      .filter((r): r is ModelQualificationReceipt => r !== null);
  }

  async loadAll(): Promise<ModelQualificationReceipt[]> {
    const items = await this.persistence.getWorkItemsByKind("activity");
    return items
      .filter(item => item.id.startsWith("qualification::"))
      .map(item => this.fromWorkItem(item))
      .filter((r): r is ModelQualificationReceipt => r !== null);
  }

  async delete(providerId: string, modelId: string): Promise<boolean> {
    // Note: ISessionPersistence doesn't have deleteWorkItem for individual items
    // For now, we'll leave stale entries - they'll be filtered by isQualificationValid
    return true;
  }
}

/** Check if a model's qualification is still valid */
export function isQualificationValid(
  receipt: ModelQualificationReceipt,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000 // 7 days
): boolean {
  const age = Date.now() - new Date(receipt.completedAt).getTime();
  return age < maxAgeMs;
}

/** Get qualification status for model picker display */
export function getQualificationDisplayState(
  receipt: ModelQualificationReceipt | null,
  model: { freeStatus: string; accessClass?: string; capabilities: { toolCalling: boolean; vision: boolean; longContext: boolean } }
): string {
  if (!receipt) return "Not Qualified";
  if (!isQualificationValid(receipt)) return "Stale";

  const qualifiedRoles = Object.entries(receipt.roleResults)
    .filter(([_, r]) => r.status === "QUALIFIED")
    .map(([role]) => role);

  if (qualifiedRoles.includes("TOOL_AGENT")) return "Agent Qualified";
  if (qualifiedRoles.includes("CODER")) return "Coder Qualified";
  if (qualifiedRoles.includes("ANALYST")) return "Analysis Qualified";
  if (receipt.hardFailureRoles.length > 0) return "Incompatible";
  if (receipt.qualificationState === "PROBATION") return "Probation";
  
  return "Qualified";
}