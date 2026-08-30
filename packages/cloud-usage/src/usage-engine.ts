import { randomUUID } from "node:crypto";
import { CloudDatabase, type UsageEventRecord } from "@codeforge/cloud-db";
import { calculateTokensAndCredits } from "./types.js";

export interface ReserveBudgetParams {
  userId: string;
  estimatedCredits: number;
  requestId: string;
  providerId: string;
  modelId: string;
}

export interface CommitUsageParams {
  userId: string;
  requestId: string;
  reservationId: string;
  estimatedCredits: number;
  sessionId?: string;
  turnId?: string;
  providerId: string;
  modelId: string;
  accessClass?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs?: number;
  providerCostUsd?: number;
}

export class UsageEngine {
  private readonly db: CloudDatabase;

  constructor(db: CloudDatabase) {
    this.db = db;
  }

  reserveBudget(params: ReserveBudgetParams): { reservationId: string; reservedCredits: number; balanceAfter: number } {
    const currentBalance = this.db.getCreditBalance(params.userId);
    if (currentBalance < params.estimatedCredits) {
      throw new Error(`Insufficient credits to reserve request. Balance: ${currentBalance}, Estimated required: ${params.estimatedCredits}`);
    }

    const reservationId = randomUUID();
    const ledger = this.db.appendLedgerEvent({
      userId: params.userId,
      amount: -params.estimatedCredits,
      eventType: "CREDIT_RESERVED",
      requestId: params.requestId,
      description: `Budget reservation for request ${params.requestId}`,
      metadata: { reservationId, providerId: params.providerId, modelId: params.modelId },
    });

    this.db.createHostedRequest({
      id: params.requestId,
      userId: params.userId,
      providerId: params.providerId,
      modelId: params.modelId,
      estimatedCredits: params.estimatedCredits,
    });

    return {
      reservationId,
      reservedCredits: params.estimatedCredits,
      balanceAfter: ledger.balanceAfter,
    };
  }

  commitUsage(params: CommitUsageParams): { actualCredits: number; providerCostUsd: number; balanceAfter: number } {
    const calculation = calculateTokensAndCredits({
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedTokens: params.cachedTokens,
    });

    const actualCredits = calculation.credits;
    const providerCostUsd = params.providerCostUsd ?? calculation.estimatedCostUsd;

    // Record detailed usage event
    this.db.recordUsageEvent({
      requestId: params.requestId,
      userId: params.userId,
      sessionId: params.sessionId,
      turnId: params.turnId,
      providerId: params.providerId,
      modelId: params.modelId,
      accessClass: params.accessClass,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedTokens: params.cachedTokens ?? 0,
      providerCostUsd,
      creditsConsumed: actualCredits,
      latencyMs: params.latencyMs ?? 0,
      status: "completed",
    });

    // Settle difference between reservation and actual usage
    const diff = params.estimatedCredits - actualCredits;
    let balanceAfter = this.db.getCreditBalance(params.userId);

    if (diff > 0) {
      // Refund excess reserved credits
      const release = this.db.appendLedgerEvent({
        userId: params.userId,
        amount: diff,
        eventType: "CREDIT_RELEASED",
        requestId: params.requestId,
        description: `Release unused reservation for ${params.requestId}`,
        metadata: { estimatedCredits: params.estimatedCredits, actualCredits },
      });
      balanceAfter = release.balanceAfter;
    } else if (diff < 0) {
      // Charge additional credits beyond estimate
      const extraCharge = Math.abs(diff);
      const charge = this.db.appendLedgerEvent({
        userId: params.userId,
        amount: -extraCharge,
        eventType: "CREDIT_USED",
        requestId: params.requestId,
        description: `Additional usage settlement for ${params.requestId}`,
        metadata: { estimatedCredits: params.estimatedCredits, actualCredits },
      });
      balanceAfter = charge.balanceAfter;
    }

    this.db.updateHostedRequest(params.requestId, "completed", actualCredits);

    return {
      actualCredits,
      providerCostUsd,
      balanceAfter,
    };
  }

  releaseReservation(params: { userId: string; requestId: string; estimatedCredits: number; reason?: string }): { refundedCredits: number; balanceAfter: number } {
    const release = this.db.appendLedgerEvent({
      userId: params.userId,
      amount: params.estimatedCredits,
      eventType: "CREDIT_RELEASED",
      requestId: params.requestId,
      description: `Cancel and release reservation: ${params.reason ?? "Request failed"}`,
    });

    this.db.updateHostedRequest(params.requestId, "failed", 0);

    return {
      refundedCredits: params.estimatedCredits,
      balanceAfter: release.balanceAfter,
    };
  }

  getUserUsageSummary(userId: string): { creditBalance: number; recentEvents: UsageEventRecord[] } {
    const creditBalance = this.db.getCreditBalance(userId);
    const recentEvents = this.db.listUsageEvents(userId, 20);
    return {
      creditBalance,
      recentEvents,
    };
  }
}
