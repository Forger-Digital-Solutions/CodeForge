import { randomUUID as uuidv4 } from "node:crypto";
import type { FreeModelRecord } from "@codeforge/forge-zero";

/** Financial decision receipt for a request */
export interface FinancialReceipt {
  receiptId: string;
  requestId: string;
  taskId: string;
  providerId: string;
  modelId: string;
  accessClass: string;
  pricingEvidence: PricingEvidence;
  pricingSource: "provider_api" | "models_dev" | "provider_catalog" | "allowance_probe" | "static_catalog";
  verifiedAt: string;
  expiresAt: string;
  paidFallbackState: "disabled" | "enabled" | "unknown";
  forgeZeroDecision: "eligible" | "ineligible" | "paid_fallback_rejected" | "unknown_cost_rejected";
  reasonCodes: string[];
  observedCharge: ObservedCharge | null;
  observedChargeSource: "provider_response" | "provider_telemetry" | "none" | null;
  createdAt: string;
}

/** Pricing evidence used for financial decision */
export interface PricingEvidence {
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  cacheReadCostPerMillion: number | null;
  cacheWriteCostPerMillion: number | null;
  isFree: boolean;
  freeTierVerifiedAt: string | null;
  source: string;
}

/** Observed charge from provider */
export interface ObservedCharge {
  amount: number;
  currency: string;
  billingUnit: "tokens" | "requests" | "time";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Route decision receipt */
export interface RouteReceipt {
  receiptId: string;
  taskId: string;
  taskRequirementHash: string;
  candidateRoutes: CandidateRoute[];
  eligibilityDecisions: EligibilityDecision[];
  selectedRoute: SelectedRoute | null;
  selectionReasonCodes: string[];
  forgeZeroDecisionRefs: string[];
  healthState: RouteHealthState;
  fallbackHistory: FallbackEvent[];
  timestamp: string;
}

/** Candidate route considered */
export interface CandidateRoute {
  providerId: string;
  modelId: string;
  accessClass: string;
  freeStatus: string;
  capabilities: Record<string, boolean>;
  estimatedLatencyMs: number;
  healthStatus: string;
}

/** Eligibility decision for a candidate */
export interface EligibilityDecision {
  providerId: string;
  modelId: string;
  eligible: boolean;
  reasonCodes: string[];
  forgeZeroDecisionRef: string;
}

/** Selected route */
export interface SelectedRoute {
  providerId: string;
  modelId: string;
  accessClass: string;
  freeStatus: string;
  stickyBinding: boolean;
  fallbackFrom?: string;
}

/** Health state at time of selection */
export interface RouteHealthState {
  providerId: string;
  modelId: string;
  status: string;
  lastCheckedAt: string;
  retryAfter?: number;
}

/** Fallback event */
export interface FallbackEvent {
  fromProviderId: string;
  fromModelId: string;
  toProviderId: string;
  toModelId: string;
  reason: string;
  timestamp: string;
}

/** Create a financial receipt */
export function createFinancialReceipt(params: {
  requestId: string;
  taskId: string;
  model: FreeModelRecord;
  pricingEvidence: PricingEvidence;
  pricingSource: FinancialReceipt["pricingSource"];
  forgeZeroDecision: FinancialReceipt["forgeZeroDecision"];
  reasonCodes: string[];
  observedCharge?: ObservedCharge | null;
  observedChargeSource?: FinancialReceipt["observedChargeSource"];
}): FinancialReceipt {
  const now = new Date().toISOString();
  return {
    receiptId: uuidv4(),
    requestId: params.requestId,
    taskId: params.taskId,
    providerId: params.model.providerId,
    modelId: params.model.modelId,
    accessClass: params.model.accessClass ?? "UNKNOWN",
    pricingEvidence: params.pricingEvidence,
    pricingSource: params.pricingSource,
    verifiedAt: params.model.freeStatusVerifiedAt ?? now,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    paidFallbackState: params.model.costProfile.paidFallbackPossible ? "enabled" : "disabled",
    forgeZeroDecision: params.forgeZeroDecision,
    reasonCodes: params.reasonCodes,
    observedCharge: params.observedCharge ?? null,
    observedChargeSource: params.observedChargeSource ?? null,
    createdAt: now,
  };
}

/** Create a route receipt */
export function createRouteReceipt(params: {
  taskId: string;
  taskRequirementSummary: string;
  candidateRoutes: CandidateRoute[];
  eligibilityDecisions: EligibilityDecision[];
  selectedRoute: SelectedRoute | null;
  selectionReasonCodes: string[];
  forgeZeroDecisionRefs: string[];
  healthState: RouteHealthState;
  fallbackHistory: FallbackEvent[];
}): RouteReceipt {
  const taskRequirementHash = hashRequirement(params.taskRequirementSummary);
  return {
    receiptId: uuidv4(),
    taskId: params.taskId,
    taskRequirementHash,
    candidateRoutes: params.candidateRoutes,
    eligibilityDecisions: params.eligibilityDecisions,
    selectedRoute: params.selectedRoute,
    selectionReasonCodes: params.selectionReasonCodes,
    forgeZeroDecisionRefs: params.forgeZeroDecisionRefs,
    healthState: params.healthState,
    fallbackHistory: params.fallbackHistory,
    timestamp: new Date().toISOString(),
  };
}

/** Hash task requirement for privacy */
function hashRequirement(requirement: string): string {
  let hash = 0;
  for (let i = 0; i < requirement.length; i++) {
    const char = requirement.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/** Financial receipt store interface */
export interface FinancialReceiptStore {
  save(receipt: FinancialReceipt): Promise<void>;
  load(receiptId: string): Promise<FinancialReceipt | null>;
  loadByTask(taskId: string): Promise<FinancialReceipt[]>;
  loadByModel(providerId: string, modelId: string): Promise<FinancialReceipt[]>;
}

/** Route receipt store interface */
export interface RouteReceiptStore {
  save(receipt: RouteReceipt): Promise<void>;
  load(receiptId: string): Promise<RouteReceipt | null>;
  loadByTask(taskId: string): Promise<RouteReceipt | null>;
  loadByModel(providerId: string, modelId: string): Promise<RouteReceipt[]>;
  loadRecent(limit: number): Promise<RouteReceipt[]>;
}

/** In-memory implementations for testing */
export class InMemoryFinancialReceiptStore implements FinancialReceiptStore {
  private readonly receipts = new Map<string, FinancialReceipt>();
  private readonly byTask = new Map<string, Set<string>>();
  private readonly byModel = new Map<string, Set<string>>();

  async save(receipt: FinancialReceipt): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
    if (!this.byTask.has(receipt.taskId)) this.byTask.set(receipt.taskId, new Set());
    this.byTask.get(receipt.taskId)!.add(receipt.receiptId);
    const modelKey = `${receipt.providerId}::${receipt.modelId}`;
    if (!this.byModel.has(modelKey)) this.byModel.set(modelKey, new Set());
    this.byModel.get(modelKey)!.add(receipt.receiptId);
  }

  async load(receiptId: string): Promise<FinancialReceipt | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async loadByTask(taskId: string): Promise<FinancialReceipt[]> {
    const ids = this.byTask.get(taskId) ?? new Set();
    return Array.from(ids).map(id => this.receipts.get(id)!).filter(Boolean);
  }

  async loadByModel(providerId: string, modelId: string): Promise<FinancialReceipt[]> {
    const modelKey = `${providerId}::${modelId}`;
    const ids = this.byModel.get(modelKey) ?? new Set();
    return Array.from(ids).map(id => this.receipts.get(id)!).filter(Boolean);
  }
}

export class InMemoryRouteReceiptStore implements RouteReceiptStore {
  private readonly receipts = new Map<string, RouteReceipt>();
  private readonly byTask = new Map<string, string>();
  private readonly byModel = new Map<string, Set<string>>();
  private readonly recent: string[] = [];

  async save(receipt: RouteReceipt): Promise<void> {
    this.receipts.set(receipt.receiptId, receipt);
    this.byTask.set(receipt.taskId, receipt.receiptId);
    const modelKey = `${receipt.selectedRoute?.providerId}::${receipt.selectedRoute?.modelId}`;
    if (modelKey && modelKey !== "undefined::undefined") {
      if (!this.byModel.has(modelKey)) this.byModel.set(modelKey, new Set());
      this.byModel.get(modelKey)!.add(receipt.receiptId);
    }
    this.recent.unshift(receipt.receiptId);
    if (this.recent.length > 1000) this.recent.pop();
  }

  async load(receiptId: string): Promise<RouteReceipt | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async loadByTask(taskId: string): Promise<RouteReceipt | null> {
    const id = this.byTask.get(taskId);
    return id ? this.receipts.get(id) ?? null : null;
  }

  async loadByModel(providerId: string, modelId: string): Promise<RouteReceipt[]> {
    const modelKey = `${providerId}::${modelId}`;
    const ids = this.byModel.get(modelKey) ?? new Set();
    return Array.from(ids).map(id => this.receipts.get(id)!).filter(Boolean);
  }

  async loadRecent(limit: number): Promise<RouteReceipt[]> {
    return this.recent.slice(0, limit).map(id => this.receipts.get(id)!).filter(Boolean);
  }
}

/** Generate "Why This Model" explanation from route receipt */
export function generateWhyThisModel(receipt: RouteReceipt): string {
  if (!receipt.selectedRoute) {
    return "No eligible route found";
  }

  const lines = [
    `Provider: ${receipt.selectedRoute.providerId}`,
    `Model: ${receipt.selectedRoute.modelId}`,
    `Access: ${receipt.selectedRoute.accessClass} (${receipt.selectedRoute.freeStatus})`,
  ];

  if (receipt.selectedRoute.stickyBinding) {
    lines.push("Continued current model to avoid unnecessary switching");
  }

  if (receipt.fallbackHistory.length > 0) {
    const lastFallback = receipt.fallbackHistory[receipt.fallbackHistory.length - 1]!;
    lines.push(`Fallback from ${lastFallback.fromProviderId}/${lastFallback.fromModelId}: ${lastFallback.reason}`);
  }

  for (const reason of receipt.selectionReasonCodes) {
    lines.push(`✓ ${reason}`);
  }

  return lines.join("\n");
}