import { describe, expect, it } from "vitest";
import { ForgeZero } from "../src/firewall.js";
import type { FreeModelRecord } from "../src/types.js";
import type { VerifyContext } from "../src/verifier.js";
import { 
  DevelopmentEntitlementProvider, 
  FailingEntitlementProvider,
  createDevelopmentEntitlementProvider,
  createFailingEntitlementProvider,
} from "../src/entitlement.js";

const now = new Date("2026-08-23T12:00:00Z");

const testContext: VerifyContext = {
  now: () => now,
};

const baseEligibleModel: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "deepseek-chat:free",
  displayName: "DeepSeek Chat (Free)",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: now.toISOString(),
  isRemote: true,
  isCloudHosted: true,
  contextWindow: 128000,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    cacheReadCostPerMillion: 0,
    cacheWriteCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: now.toISOString(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "oprouter:free",
  },
  health: {
    status: "available",
    lastCheckedAt: now.toISOString(),
  },
};

const makeModel = (overrides: Partial<FreeModelRecord> = {}): FreeModelRecord => ({
  ...baseEligibleModel,
  ...overrides,
  costProfile: {
    ...baseEligibleModel.costProfile,
    ...(overrides.costProfile ?? {}),
  },
  capabilities: {
    ...baseEligibleModel.capabilities,
    ...(overrides.capabilities ?? {}),
  },
  health: overrides.health,
});

describe("ForgeZero — mandatory safety", () => {
  it("[PASS] free cloud model accepted", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(baseEligibleModel);
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(true);
  });

  it("[PASS] paid model denied (non-zero output cost)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        providerId: "openai",
        modelId: "gpt-5",
        displayName: "GPT-5",
        freeStatus: "paid",
        costProfile: {
          inputCostPerMillion: 3,
          outputCostPerMillion: 15,
          isFree: false,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "test",
        },
      }),
    );
    const result = fw.verify("openai", "gpt-5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_COST_REJECTED");
    }
  });

  it("[PASS] unknown-cost model denied (null cost)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        providerId: "unknown",
        modelId: "mystery-model",
        displayName: "Mystery",
        costProfile: {
          inputCostPerMillion: null,
          outputCostPerMillion: null,
          isFree: false,
          paidFallbackPossible: false,
          paidFallbackDisabled: true,
          source: "test",
        },
      }),
    );
    const result = fw.verify("unknown", "mystery-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_COST_REJECTED");
    }
  });

  it("[PASS] local model denied (not remote)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        providerId: "local",
        modelId: "llama-3",
        displayName: "Llama 3 (Local)",
        isRemote: false,
        isCloudHosted: false,
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: true,
          paidFallbackPossible: false,
          paidFallbackDisabled: true,
          source: "local",
        },
      }),
    );
    const result = fw.verify("local", "llama-3");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORGE_ZERO_VIOLATION");
    }
  });

  it("[PASS] local model denied (Ollama)", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        providerId: "ollama",
        modelId: "codellama",
        displayName: "Code Llama (Ollama)",
        isRemote: false,
        isCloudHosted: false,
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: true,
          paidFallbackPossible: false,
          paidFallbackDisabled: true,
          source: "ollama",
        },
      }),
    );
    expect(fw.canRouteTo("ollama", "codellama")).toBe(false);
  });

  it("[PASS] paid fallback rejected when not disabled", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        providerId: "openrouter",
        modelId: "some-model",
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: true,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "test",
        },
      }),
    );
    const result = fw.verify("openrouter", "some-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PAID_FALLBACK_REJECTED");
    }
  });

  it("[PASS] expired free verification rejected", () => {
    const fw = new ForgeZero({ context: testContext });
    const oldDate = new Date("2025-01-01T00:00:00Z");
    fw.register(
      makeModel({
        costProfile: {
          ...baseEligibleModel.costProfile,
          freeTierVerifiedAt: oldDate.toISOString(),
        },
      }),
    );
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORGE_ZERO_VIOLATION");
    }
  });

  it("[PASS] quota exhausted model rejected", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        health: { status: "quota_exhausted", lastCheckedAt: now.toISOString() },
      }),
    );
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("[PASS] offline model rejected", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        health: { status: "offline" },
      }),
    );
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("[PASS] rate-limited model rejected at account gate", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(
      makeModel({
        health: { status: "rate_limited", lastCheckedAt: now.toISOString() },
      }),
    );
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(false);
  });

  it("[PASS] eligibleModels returns only verified-free models", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(baseEligibleModel);
    fw.register(
      makeModel({
        providerId: "openai",
        modelId: "gpt-5",
        displayName: "GPT-5",
        freeStatus: "paid",
        costProfile: {
          inputCostPerMillion: 3,
          outputCostPerMillion: 15,
          isFree: false,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
          source: "test",
        },
      }),
    );
    const eligible = fw.eligibleModels();
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.modelId).toBe("deepseek-chat:free");
  });

  it("[PASS] unregistered model returns NOT_FOUND", () => {
    const fw = new ForgeZero({ context: testContext });
    const result = fw.verify("nobody", "nothing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("ForgeZero — model lifecycle", () => {
  it("register and getModel", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(baseEligibleModel);
    const m = fw.getModel("openrouter", "deepseek-chat:free");
    expect(m?.displayName).toBe("DeepSeek Chat (Free)");
  });

  it("unregister removes model", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(baseEligibleModel);
    expect(fw.unregister("openrouter", "deepseek-chat:free")).toBe(true);
    expect(fw.getModel("openrouter", "deepseek-chat:free")).toBeUndefined();
  });

  it("allModels returns everything registered", () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(baseEligibleModel);
    fw.register(makeModel({ providerId: "groq", modelId: "llama-3.3" }));
    expect(fw.allModels()).toHaveLength(2);
  });
});

describe("ForgeZero — entitlement checks", () => {
  const gemsModel: FreeModelRecord = {
    providerId: "codeforge",
    modelId: "topaz",
    displayName: "CodeForge Topaz",
    tier: "gems_paid",
    freeStatus: "paid",
    isRemote: true,
    isCloudHosted: true,
    contextWindow: 200000,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: true,
      structuredOutput: true,
      longContext: true,
    },
    costProfile: {
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      isFree: false,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "codeforge_gems",
    },
  };

  it("[PASS] free user + free model → allowed", () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    fw.register(baseEligibleModel);
    const result = fw.verify("openrouter", "deepseek-chat:free");
    expect(result.ok).toBe(true);
  });

  it("[PASS] free user + GEMS model → requires subscription (denied)", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("free-user", "codeforge", "topaz");
    // requires_subscription means access denied
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REQUIRES_SUBSCRIPTION");
    }
  });

  it("[PASS] trial user + GEMS model → trial access allowed", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("trial-user", "codeforge", "topaz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("trial");
    }
  });

  it("[PASS] paid user + GEMS model → included", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("paid-user", "codeforge", "topaz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("included");
    }
  });

  it("[PASS] unknown user + GEMS model → not entitled", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("unknown-user", "codeforge", "topaz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REQUIRES_SUBSCRIPTION");
    }
  });

  it("[PASS] entitlement provider failure → deny (fail closed)", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createFailingEntitlementProvider(),
    });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("any-user", "codeforge", "topaz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Provider is unhealthy, so we get PROVIDER_UNAVAILABLE before entitlement check
      expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("[PASS] no entitlement provider → deny GEMS model", async () => {
    const fw = new ForgeZero({ context: testContext });
    fw.register(gemsModel);
    const result = await fw.checkEntitlement("any-user", "codeforge", "topaz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORGE_ZERO_VIOLATION");
    }
  });

  it("[PASS] unregistered model → NOT_FOUND", async () => {
    const fw = new ForgeZero({ 
      context: testContext,
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    const result = await fw.checkEntitlement("paid-user", "nonexistent", "model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("DevelopmentEntitlementProvider", () => {
  it("should be healthy", async () => {
    const provider = createDevelopmentEntitlementProvider();
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it("should correctly classify GEMS models", async () => {
    const provider = createDevelopmentEntitlementProvider();
    
    const freeResult = await provider.checkEntitlement("free-user", "free-model", "openrouter");
    expect(freeResult.ok).toBe(true);
    if (freeResult.ok) {
      expect(freeResult.value.status).toBe("included");
    }

    const gemsResult = await provider.checkEntitlement("free-user", "topaz", "codeforge");
    expect(gemsResult.ok).toBe(true);
    if (gemsResult.ok) {
      expect(gemsResult.value.status).toBe("requires_subscription");
    }
  });
});

describe("FailingEntitlementProvider", () => {
  it("should always fail", async () => {
    const provider = createFailingEntitlementProvider();
    const result = await provider.checkEntitlement("any-user", "any-model", "any-provider");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider_unavailable");
    }
  });

  it("should report unhealthy", async () => {
    const provider = createFailingEntitlementProvider();
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(false);
  });
});
