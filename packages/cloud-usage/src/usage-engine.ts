import type { ICloudDatabase, UsageEventRecord } from "@codeforge/cloud-db";
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
  reservationId?: string;
  estimatedCredits?: number;
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
  private readonly db: ICloudDatabase;

  constructor(db: ICloudDatabase) {
    this.db = db;
  }

  reserveBudget(params: ReserveBudgetParams): { reservationId: string; reservedCredits: number; balanceAfter: number } {
    // 1. Check account-level spend limit if configured
    const settings = this.db.getAccountSettings(params.userId);
    if (settings.spendLimitUsd > 0) {
      const currentSpend = this.db.getUserBillingPeriodSpendUsd(params.userId);
      if (currentSpend >= settings.spendLimitUsd) {
        throw new Error(`Account monthly spend limit of $${settings.spendLimitUsd.toFixed(2)} reached (current: $${currentSpend.toFixed(2)})`);
      }
    }

    // Check if reservation already exists for this requestId (Idempotency)
    const existing = this.db.getReservationByRequestId(params.requestId);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new Error("Request ID is already associated with another user account");
      }
      return {
        reservationId: existing.id,
        reservedCredits: existing.reservedCredits,
        balanceAfter: this.db.getCreditBalance(params.userId),
      };
    }

    // 2. Authoritatively create reservation in DB
    const reservation = this.db.createReservation({
      requestId: params.requestId,
      userId: params.userId,
      providerId: params.providerId,
      modelId: params.modelId,
      reservedCredits: params.estimatedCredits,
    });

    // 3. Atomically deduct reservation from ledger
    const ledger = this.db.appendLedgerEvent({
      userId: params.userId,
      amount: -params.estimatedCredits,
      eventType: "CREDIT_RESERVED",
      requestId: params.requestId,
      description: `Budget reservation for request ${params.requestId}`,
      metadata: { reservationId: reservation.id, providerId: params.providerId, modelId: params.modelId },
    });

    // Maintain backward-compatible hosted_requests record
    const existingReq = this.db.getHostedRequest(params.requestId);
    if (!existingReq) {
      this.db.createHostedRequest({
        id: params.requestId,
        userId: params.userId,
        providerId: params.providerId,
        modelId: params.modelId,
        estimatedCredits: params.estimatedCredits,
      });
    }

    return {
      reservationId: reservation.id,
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

    // 1. Authoritatively commit reservation in DB
    const reservation = this.db.commitReservation(params.requestId, params.userId, actualCredits);

    // 2. Record detailed usage event
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

    // 3. Settle difference between reserved and actual credits
    const diff = reservation.reservedCredits - actualCredits;
    let balanceAfter = this.db.getCreditBalance(params.userId);

    if (diff > 0) {
      // Refund excess reserved credits
      const release = this.db.appendLedgerEvent({
        userId: params.userId,
        amount: diff,
        eventType: "CREDIT_RELEASED",
        requestId: params.requestId,
        description: `Release unused reservation for ${params.requestId}`,
        metadata: { reservedCredits: reservation.reservedCredits, actualCredits },
      });
      balanceAfter = release.balanceAfter;
    } else if (diff < 0) {
      // Charge additional credits beyond estimate if balance allows
      const extraCharge = Math.min(Math.abs(diff), balanceAfter);
      if (extraCharge > 0) {
        const charge = this.db.appendLedgerEvent({
          userId: params.userId,
          amount: -extraCharge,
          eventType: "CREDIT_USED",
          requestId: params.requestId,
          description: `Additional usage settlement for ${params.requestId}`,
          metadata: { reservedCredits: reservation.reservedCredits, actualCredits },
        });
        balanceAfter = charge.balanceAfter;
      }
    }

    try {
      this.db.updateHostedRequest(params.requestId, "completed", actualCredits);
    } catch {}

    return {
      actualCredits,
      providerCostUsd,
      balanceAfter,
    };
  }

  releaseReservation(params: { userId: string; requestId: string; estimatedCredits?: number; reason?: string }): { refundedCredits: number; balanceAfter: number } {
    // 1. Authoritatively release reservation in DB
    const reservation = this.db.releaseReservation(params.requestId, params.userId);

    // 2. Refund reserved credits to ledger
    const release = this.db.appendLedgerEvent({
      userId: params.userId,
      amount: reservation.reservedCredits,
      eventType: "CREDIT_RELEASED",
      requestId: params.requestId,
      description: `Cancel and release reservation: ${params.reason ?? "Request failed"}`,
    });

    try {
      this.db.updateHostedRequest(params.requestId, "failed", 0);
    } catch {}

    return {
      refundedCredits: reservation.reservedCredits,
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
