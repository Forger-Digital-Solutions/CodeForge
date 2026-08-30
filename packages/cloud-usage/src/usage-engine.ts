import type { ICloudDatabase, UsageEventRecord } from "@codeforge/cloud-db";
import { calculateTokensAndCredits } from "./types.js";

export interface ReserveBudgetParams {
  userId: string;
  estimatedCredits: number;
  requestId: string;
  providerId: string;
  modelId: string;
  maxConcurrentTasks?: number;
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

  async reserveBudget(params: ReserveBudgetParams): Promise<{ reservationId: string; reservedCredits: number; balanceAfter: number }> {
    // 1. Check account-level spend limit if configured
    const settings = await this.db.getAccountSettings(params.userId);
    if (settings.spendLimitUsd > 0) {
      const currentSpend = await this.db.getUserBillingPeriodSpendUsd(params.userId);
      if (currentSpend >= settings.spendLimitUsd) {
        throw new Error(`Account monthly spend limit of $${settings.spendLimitUsd.toFixed(2)} reached (current: $${currentSpend.toFixed(2)})`);
      }
    }

    // 2. Atomically reserve credits and enforce concurrency in DB (handles idempotency, row locking, and ledger deduction)
    const { reservation, balanceAfter } = await this.db.reserveCredits({
      requestId: params.requestId,
      userId: params.userId,
      providerId: params.providerId,
      modelId: params.modelId,
      reservedCredits: params.estimatedCredits,
      maxConcurrentTasks: params.maxConcurrentTasks,
    });


    // Maintain backward-compatible hosted_requests record
    try {
      const existingReq = await this.db.getHostedRequest(params.requestId);
      if (!existingReq) {
        await this.db.createHostedRequest({
          id: params.requestId,
          userId: params.userId,
          providerId: params.providerId,
          modelId: params.modelId,
          estimatedCredits: params.estimatedCredits,
        });
      }
    } catch {}


    return {
      reservationId: reservation.id,
      reservedCredits: reservation.reservedCredits,
      balanceAfter,
    };
  }

  async commitUsage(params: CommitUsageParams): Promise<{ actualCredits: number; providerCostUsd: number; balanceAfter: number }> {
    const calculation = calculateTokensAndCredits({
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedTokens: params.cachedTokens,
    });

    const actualCredits = calculation.credits;
    const providerCostUsd = params.providerCostUsd ?? calculation.estimatedCostUsd;

    // 1. Authoritatively settle reservation in DB (atomic transition + ledger reconciliation)
    const { transitioned, balanceAfter } = await this.db.settleReservation({
      requestId: params.requestId,
      userId: params.userId,
      actualCredits,
    });

    // 2. Record detailed usage event only if this caller performed the state transition (idempotency)
    if (transitioned) {
      await this.db.recordUsageEvent({
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

      try {
        await this.db.updateHostedRequest(params.requestId, "completed", actualCredits);
      } catch {}
    }

    return {
      actualCredits,
      providerCostUsd,
      balanceAfter,
    };
  }

  async releaseReservation(params: { userId: string; requestId: string; estimatedCredits?: number; reason?: string }): Promise<{ refundedCredits: number; balanceAfter: number }> {
    // 1. Authoritatively release reservation and refund credits in DB
    const { refundedCredits, balanceAfter, transitioned } = await this.db.releaseReservationCredits({
      requestId: params.requestId,
      userId: params.userId,
      reason: params.reason,
    });

    if (transitioned) {
      try {
        await this.db.updateHostedRequest(params.requestId, "failed", 0);
      } catch {}
    }

    return {
      refundedCredits,
      balanceAfter,
    };
  }

  /**
   * Reclaim credits locked by reservations that were created but never committed or released — the
   * classic crash-recovery case where the process died mid-inference. Each stale reservation (older
   * than `timeoutMs`, still 'reserved') is released and its credits refunded to the ledger, so a
   * user's balance is never locked forever. Safe to run at startup and on an interval; committed and
   * already-released reservations are untouched. Returns how many were reclaimed and the total refund.
   */
  async reconcileStaleReservations(opts: { now?: Date; timeoutMs?: number } = {}): Promise<{ reconciled: number; refundedCredits: number }> {
    const now = opts.now ?? new Date();
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    const cutoffIso = new Date(now.getTime() - timeoutMs).toISOString();
    const stale = await this.db.listStaleReservations(cutoffIso);
    let reconciled = 0;
    let refundedCredits = 0;
    for (const res of stale) {
      try {
        const { refundedCredits: refund } = await this.releaseReservation({
          userId: res.userId,
          requestId: res.requestId,
          reason: "Stale reservation reclaimed after crash/timeout",
        });
        reconciled++;
        refundedCredits += refund;
      } catch {
        // A concurrent commit/release may have already settled it — skip and continue.
      }
    }
    return { reconciled, refundedCredits };
  }

  async getUserUsageSummary(userId: string): Promise<{ creditBalance: number; recentEvents: UsageEventRecord[] }> {
    const creditBalance = await this.db.getCreditBalance(userId);
    const recentEvents = await this.db.listUsageEvents(userId, 20);
    return {
      creditBalance,
      recentEvents,
    };
  }
}

