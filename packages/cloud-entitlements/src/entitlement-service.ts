import type { ICloudDatabase } from "@codeforge/cloud-db";
import { CANONICAL_FREE_FEATURES, CANONICAL_PRO_FEATURES } from "@codeforge/cloud-db";
import type { FeatureKey, TaskExecutionPermission } from "./types.js";

export class EntitlementService {
  private readonly db: ICloudDatabase;

  constructor(db: ICloudDatabase) {
    this.db = db;
  }

  async hasFeature(userId: string, feature: FeatureKey): Promise<boolean> {
    try {
      return await this.db.hasEntitlement(userId, feature);
    } catch {
      // FAIL CLOSED: on database error or timeout, deny feature
      return false;
    }
  }

  async evaluateTaskExecution(params: {
    userId: string;
    modelTier?: "free" | "paid" | "gems_paid";
    product?: "FREE" | "PAID";
    requestedEstimatedCredits?: number;
    activeConcurrency?: number;
  }): Promise<TaskExecutionPermission> {
    try {
      const user = await this.db.getUserById(params.userId);
      if (!user) {
        return {
          allowed: false,
          reason: "User account not found",
          maxEstimatedCredits: 0,
          availableCredits: 0,
          planId: "none",
        };
      }

      const subscription = await this.db.getSubscriptionByUserId(params.userId);
      const planId = subscription?.planId ?? "free";
      const tier = params.modelTier ?? (params.product === "PAID" ? "paid" : "free");
      const product = params.product ?? (tier === "free" ? "FREE" : "PAID");
      if (product === "FREE" && tier !== "free") {
        return { allowed: false, reason: "Premium models require the explicit paid product", maxEstimatedCredits: 0, availableCredits: 0, planId };
      }
      // Free usage has its own allowance and limits even when the account owns a paid wallet.
      const plan = await this.db.getPlan(product === "FREE" ? "free" : planId);
      if (!plan) {
        return {
          allowed: false,
          reason: "User plan not configured (fail closed)",
          maxEstimatedCredits: 0,
          availableCredits: 0,
          planId,
        };
      }

      const freePeriod = product === "FREE"
        ? (await this.db.getOrCreateCurrentUsagePeriod(params.userId, plan.monthlyCreditAllowance)).period
        : undefined;
      const freeReserved = freePeriod ? await this.db.getUsagePeriodReservedCredits(freePeriod.id) : 0;
      const balance = freePeriod
        ? Math.max(0, freePeriod.freeAllowanceGranted - freePeriod.creditsUsed - freeReserved)
        : await this.db.getCreditBalance(params.userId);

      // Check subscription status
      if (product === "PAID" && planId !== "free" && subscription?.status !== "active" && subscription?.status !== "trialing") {
        return {
          allowed: false,
          reason: `Subscription is not active (status: ${subscription?.status ?? "none"})`,
          maxEstimatedCredits: 0,
          availableCredits: 0,
          planId,
        };
      }

      // Check concurrency
      const activeCount = params.activeConcurrency ?? 0;
      if (activeCount >= plan.maxConcurrentTasks) {
        return {
          allowed: false,
          reason: `Concurrent task limit reached (${activeCount}/${plan.maxConcurrentTasks})`,
          maxEstimatedCredits: plan.maxTaskSpendCredits,
          availableCredits: balance,
          planId,
        };
      }

      // Check model tier access
      if (product === "PAID") {
        const hasPaid = await this.hasFeature(params.userId, "HOSTED_PAID");
        const hasPremium = await this.hasFeature(params.userId, "PREMIUM_MODELS");
        if (!hasPaid && !hasPremium) {
          return {
            allowed: false,
            reason: "Selected premium model requires a CodeForge Pro subscription",
            maxEstimatedCredits: 0,
            availableCredits: balance,
            planId,
          };
        }
      }

      // Check credit balance
      const requested = params.requestedEstimatedCredits ?? 1_000;
      if (balance <= 0 || balance < requested) {
        return {
          allowed: false,
          reason: freePeriod ? "Your monthly CodeForge Free allowance is exhausted or reserved" : "You have used your included CodeForge hosted usage",
          maxEstimatedCredits: plan.maxTaskSpendCredits,
          availableCredits: balance,
          planId,
        };
      }

      return {
        allowed: true,
        maxEstimatedCredits: Math.min(plan.maxTaskSpendCredits, balance),
        availableCredits: balance,
        planId,
      };
    } catch {
      // FAIL CLOSED
      return {
        allowed: false,
        reason: "Entitlement check failed (fail closed)",
        maxEstimatedCredits: 0,
        availableCredits: 0,
        planId: "unknown",
      };
    }
  }

  async syncSubscriptionEntitlements(userId: string, planId: string): Promise<void> {
    const plan = await this.db.getPlan(planId);
    if (!plan) return;

    if (planId === "pro") {
      for (const feat of CANONICAL_PRO_FEATURES) {
        await this.db.setEntitlement(userId, feat, "true");
      }
    } else {
      // Free plan: grant free features, revoke pro-only features
      for (const feat of CANONICAL_FREE_FEATURES) {
        await this.db.setEntitlement(userId, feat, "true");
      }
      const freeSet = new Set<FeatureKey>(CANONICAL_FREE_FEATURES);
      for (const feat of CANONICAL_PRO_FEATURES) {
        if (!freeSet.has(feat)) {
          await this.db.removeEntitlement(userId, feat);
        }
      }
    }
  }
}

