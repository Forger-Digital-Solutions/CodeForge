import { CloudDatabase } from "@codeforge/cloud-db";
import type { FeatureKey, TaskExecutionPermission } from "./types.js";

export class EntitlementService {
  private readonly db: CloudDatabase;

  constructor(db: CloudDatabase) {
    this.db = db;
  }

  hasFeature(userId: string, feature: FeatureKey): boolean {
    try {
      return this.db.hasEntitlement(userId, feature);
    } catch {
      // FAIL CLOSED: on database error or timeout, deny feature
      return false;
    }
  }

  evaluateTaskExecution(params: {
    userId: string;
    modelTier?: "free" | "paid" | "gems_paid";
    requestedEstimatedCredits?: number;
    activeConcurrency?: number;
  }): TaskExecutionPermission {
    try {
      const user = this.db.getUserById(params.userId);
      if (!user) {
        return {
          allowed: false,
          reason: "User account not found",
          maxEstimatedCredits: 0,
          availableCredits: 0,
          planId: "none",
        };
      }

      const subscription = this.db.getSubscriptionByUserId(params.userId);
      const planId = subscription?.planId ?? "free";
      const plan = this.db.getPlan(planId);
      if (!plan) {
        return {
          allowed: false,
          reason: "User plan not configured (fail closed)",
          maxEstimatedCredits: 0,
          availableCredits: 0,
          planId,
        };
      }

      // Check subscription status
      if (planId !== "free" && subscription?.status !== "active" && subscription?.status !== "trialing") {
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
          availableCredits: this.db.getCreditBalance(params.userId),
          planId,
        };
      }

      // Check model tier access
      const tier = params.modelTier ?? "free";
      if (tier === "paid" || tier === "gems_paid") {
        if (!this.hasFeature(params.userId, "HOSTED_PAID") && !this.hasFeature(params.userId, "PREMIUM_MODELS")) {
          return {
            allowed: false,
            reason: "Selected premium model requires a CodeForge Pro subscription",
            maxEstimatedCredits: 0,
            availableCredits: this.db.getCreditBalance(params.userId),
            planId,
          };
        }
      }

      // Check credit balance
      const balance = this.db.getCreditBalance(params.userId);
      const requested = params.requestedEstimatedCredits ?? 1_000;
      if (balance <= 0 || balance < requested) {
        return {
          allowed: false,
          reason: "You have used your included CodeForge hosted usage",
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

  syncSubscriptionEntitlements(userId: string, planId: string): void {
    const plan = this.db.getPlan(planId);
    if (!plan) return;

    if (planId === "pro") {
      this.db.setEntitlement(userId, "HOSTED_FREE", "true");
      this.db.setEntitlement(userId, "HOSTED_PAID", "true");
      this.db.setEntitlement(userId, "PREMIUM_MODELS", "true");
      this.db.setEntitlement(userId, "PRIORITY_ROUTING", "true");
      this.db.setEntitlement(userId, "GEMS_READY", "true");
      this.db.setEntitlement(userId, "HIGH_CONCURRENCY", "true");
    } else {
      // Free plan
      this.db.setEntitlement(userId, "HOSTED_FREE", "true");
      this.db.setEntitlement(userId, "DIRECT_PROVIDERS", "true");
      this.db.removeEntitlement(userId, "HOSTED_PAID");
      this.db.removeEntitlement(userId, "PREMIUM_MODELS");
      this.db.removeEntitlement(userId, "PRIORITY_ROUTING");
      this.db.removeEntitlement(userId, "GEMS_READY");
      this.db.removeEntitlement(userId, "HIGH_CONCURRENCY");
    }
  }
}
