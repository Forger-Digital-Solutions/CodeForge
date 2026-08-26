import type { CodeForgeError, Result } from "@codeforge/core";

/**
 * User's entitlement status for a model.
 */
export type EntitlementCheckStatus = 
  | "included" 
  | "requires_subscription" 
  | "trial" 
  | "not_entitled";

/**
 * Result of checking a user's entitlement for a model.
 */
export interface EntitlementCheckResult {
  status: EntitlementCheckStatus;
  modelId: string;
  providerId: string;
  userId: string;
  checkedAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Error result when entitlement check fails.
 */
export interface EntitlementCheckError {
  code: "provider_unavailable" | "rate_limited" | "invalid_user" | "invalid_model" | "internal_error";
  message: string;
  retriable: boolean;
}

/**
 * Provider for checking user entitlements to models.
 * 
 * This is SEPARATE from provider API credentials.
 * Entitlement determines if a CodeForge account is allowed to use a specific model tier.
 */
export interface EntitlementProvider {
  /**
   * Check if a user is entitled to use a specific model.
   * Must fail closed - if errors occur, deny access to paid models.
   */
  checkEntitlement(userId: string, modelId: string, providerId: string): Promise<Result<EntitlementCheckResult, EntitlementCheckError>>;
  
  /**
   * Optional: Batch check multiple models for efficiency.
   */
  checkEntitlementBatch?(userId: string, models: Array<{ modelId: string; providerId: string }>): Promise<Result<EntitlementCheckResult[], EntitlementCheckError>>;
  
  /**
   * Health check for the entitlement service.
   */
  healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }>;
}

/**
 * Development entitlement provider with deterministic scenarios.
 * 
 * USER SCENARIOS:
 * - "free-user": Can use free models, GEMS models require subscription
 * - "trial-user": Has trial access to GEMS models  
 * - "paid-user": Full entitlement to GEMS models
 * - "unknown-user" / other: Not entitled to GEMS models
 */
export class DevelopmentEntitlementProvider implements EntitlementProvider {
  private readonly healthy: boolean = true;
  
  async checkEntitlement(
    userId: string, 
    modelId: string, 
    providerId: string
  ): Promise<Result<EntitlementCheckResult, EntitlementCheckError>> {
    const { ok, err } = await import("@codeforge/core");
    const now = new Date().toISOString();
    
    // Determine tier based on model ID patterns
    const isGemsModel = this.isGemsModel(modelId);
    
    // Free users can use free models
    if (!isGemsModel) {
      return ok({
        status: "included",
        modelId,
        providerId,
        userId,
        checkedAt: now,
      });
    }
    
    // Handle GEMS model entitlement based on user type
    switch (userId) {
      case "free-user":
        return ok({
          status: "requires_subscription",
          modelId,
          providerId,
          userId,
          checkedAt: now,
        });
        
      case "trial-user":
        return ok({
          status: "trial",
          modelId,
          providerId,
          userId,
          checkedAt: now,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        });
        
      case "paid-user":
        return ok({
          status: "included",
          modelId,
          providerId,
          userId,
          checkedAt: now,
        });
        
      default:
        return ok({
          status: "not_entitled",
          modelId,
          providerId,
          userId,
          checkedAt: now,
        });
    }
  }
  
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: this.healthy, latencyMs: 1 };
  }
  
  private isGemsModel(modelId: string): boolean {
    const gemsModels = ["topaz", "sapphire", "peridot", "garnet"];
    const normalizedModelId = modelId.toLowerCase();
    return gemsModels.some(gem => normalizedModelId.includes(gem));
  }
}

/**
 * Failing entitlement provider for testing fail-closed behavior.
 */
export class FailingEntitlementProvider implements EntitlementProvider {
  async checkEntitlement(): Promise<Result<EntitlementCheckResult, EntitlementCheckError>> {
    const { err } = await import("@codeforge/core");
    return err({
      code: "provider_unavailable",
      message: "Entitlement service unavailable (test provider)",
      retriable: false,
    });
  }
  
  async healthCheck(): Promise<{ healthy: boolean }> {
    return { healthy: false };
  }
}

/**
 * Create development entitlement provider for testing.
 */
export function createDevelopmentEntitlementProvider(): EntitlementProvider {
  return new DevelopmentEntitlementProvider();
}

/**
 * Create a failing entitlement provider for testing fail-closed behavior.
 */
export function createFailingEntitlementProvider(): EntitlementProvider {
  return new FailingEntitlementProvider();
}
