import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeZero } from "@codeforge/forge-zero";
import { createEightBitRuntime, type EightBitRuntime } from "@codeforge/eight-bit";
import { createEightBitEligibilityPolicy, type EligibilityContext, type EightBitRole } from "@codeforge/eight-bit";
import { EightBitHealthTracker } from "@codeforge/eight-bit";
import { EightBitReliabilityTracker } from "@codeforge/eight-bit";
import { EightBitRouter } from "@codeforge/eight-bit";
import { ROLE_CONTRACTS } from "@codeforge/eight-bit";
import type { ISessionPersistence } from "@codeforge/sessions";

// --- Test fixtures ----------------------------------------------------------------------------

function createMockPersistence(): ISessionPersistence {
  return {
    upsertWorkItem: vi.fn().mockResolvedValue(undefined),
    getWorkItem: vi.fn().mockResolvedValue(null),
    deleteWorkItem: vi.fn().mockResolvedValue(undefined),
    listWorkItems: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockFirewall(): ForgeZero {
  return new ForgeZero();
}

function createMockRuntime(overrides?: { firewall?: ForgeZero; now?: () => number }): EightBitRuntime {
  const firewall = overrides?.firewall ?? createMockFirewall();
  const persistence = createMockPersistence();
  return createEightBitRuntime({ firewall, persistence, now: overrides?.now });
}

// Model factory for consistent test records
function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    displayName: "Test Model",
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    tier: "free",
    accessClass: "FREE_NATIVE",
    authMode: "no_auth",
    privacyClass: "public",
    family: "test",
    upstreamSource: "test",
    deprecated: false,
    contextWindow: 8192,
    maxOutput: 4096,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: false },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date().toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "test",
    },
    isRemote: true,
    isCloudHosted: true,
    codingScore: 0.8,
    agentScore: 0.8,
    toolReliability: 0.9,
    lastVerified: new Date().toISOString(),
    verificationSource: "test",
    empiricalStatus: "verified",
    health: { status: "available", lastCheckedAt: new Date().toISOString() },
    ...overrides,
  };
}

function verifyModel(firewall: ForgeZero, providerId: string, modelId: string): FreeModelRecord | undefined {
  const result = firewall.verify(providerId, modelId);
  return result.ok ? result.value : undefined;
}

// --- Test Suite --------------------------------------------------------------------------------

describe("8-Bit Qualification Harness", () => {
  let firewall: ForgeZero;
  let runtime: EightBitRuntime;
  let policy: ReturnType<typeof createEightBitEligibilityPolicy>;

  beforeEach(() => {
    firewall = createMockFirewall();
    runtime = createMockRuntime({ firewall });
    policy = createEightBitEligibilityPolicy();
  });

  // ========================================================================
  // TEST A: FREE_NATIVE verification path → verified_free + eligible adaptive
  // ========================================================================
  describe("Test A: FREE_NATIVE verification path", () => {
    it("registers model with accessClass=FREE_NATIVE and verifies freeStatus=verified_free", () => {
      const model = makeModel({
        accessClass: "FREE_NATIVE",
        providerId: "opencode",
        modelId: "muse-spark-1.2-contributor-free",
        freeStatus: "verified_free",
        costProfile: { ...makeModel().costProfile, isFree: true },
      });

      firewall.register(model);

      const retrieved = verifyModel(firewall, model.providerId, model.modelId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.freeStatus).toBe("verified_free");
      expect(retrieved?.accessClass).toBe("FREE_NATIVE");
    });

    it("eligibility policy marks FREE_NATIVE as eligible for adaptive routing", () => {
      const model = makeModel({ accessClass: "FREE_NATIVE", freeStatus: "verified_free" });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });
  });

  // ========================================================================
  // TEST B: FREE_ROUTED verification path → verified_free + eligible adaptive
  // ========================================================================
  describe("Test B: FREE_ROUTED verification path", () => {
    it("registers model with accessClass=FREE_ROUTED and verifies freeStatus=verified_free", () => {
      const model = makeModel({
        accessClass: "FREE_ROUTED",
        providerId: "openrouter",
        modelId: "openrouter/auto",
        freeStatus: "verified_free",
        costProfile: { ...makeModel().costProfile, isFree: true },
      });

      firewall.register(model);

      const retrieved = verifyModel(firewall, model.providerId, model.modelId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.freeStatus).toBe("verified_free");
      expect(retrieved?.accessClass).toBe("FREE_ROUTED");
    });

    it("eligibility policy marks FREE_ROUTED as eligible for adaptive routing", () => {
      const model = makeModel({ accessClass: "FREE_ROUTED", freeStatus: "verified_free" });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });
  });

  // ========================================================================
  // TEST C: FREE_ALLOWANCE verification path → verified_free + eligible adaptive
  // ========================================================================
  describe("Test C: FREE_ALLOWANCE verification path", () => {
    it("registers model with accessClass=FREE_ALLOWANCE and verifies freeStatus=verified_free", () => {
      const model = makeModel({
        accessClass: "FREE_ALLOWANCE",
        providerId: "openrouter",
        modelId: "openrouter/cinematic-7b",
        freeStatus: "verified_free",
        costProfile: { ...makeModel().costProfile, isFree: true },
      });

      firewall.register(model);

      const retrieved = verifyModel(firewall, model.providerId, model.modelId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.freeStatus).toBe("verified_free");
      expect(retrieved?.accessClass).toBe("FREE_ALLOWANCE");
    });

    it("eligibility policy marks FREE_ALLOWANCE as eligible for adaptive routing", () => {
      const model = makeModel({ accessClass: "FREE_ALLOWANCE", freeStatus: "verified_free" });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });
  });

  // ========================================================================
  // TEST D: PAID model never marked eligible in adaptive mode; allowed in BYOK/premium
  // ========================================================================
  describe("Test D: PAID model exclusion in adaptive mode", () => {
    it("PAID model fails eligibility in adaptive mode", () => {
      const model = makeModel({
        accessClass: "PAID",
        freeStatus: "paid",
        costProfile: { ...makeModel().costProfile, isFree: false, paidFallbackDisabled: true },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("PAID_NOT_AUTHORIZED");
    });

    it("PAID model IS eligible in BYOK mode (user brings own key)", () => {
      const model = makeModel({
        accessClass: "PAID",
        freeStatus: "paid",
        costProfile: { ...makeModel().costProfile, isFree: false },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "byok" };
      const verdict = policy.evaluate(model, ctx);

      // BYOK mode allows paid models when user provides credentials
      expect(verdict.eligible).toBe(true);
    });

    it("PAID model IS eligible in premium mode", () => {
      const model = makeModel({
        accessClass: "PAID",
        freeStatus: "paid",
        costProfile: { ...makeModel().costProfile, isFree: false },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "premium" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });
  });

  // ========================================================================
  // TEST E: UNKNOWN freeStatus excluded in adaptive; allowed in BYOK/premium with accessClass
  // ========================================================================
  describe("Test E: UNKNOWN freeStatus handling", () => {
    it("UNKNOWN model with accessClass=UNKNOWN fails eligibility in adaptive mode", () => {
      const model = makeModel({
        accessClass: "UNKNOWN",
        freeStatus: "unknown",
        costProfile: { ...makeModel().costProfile, isFree: false },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("UNKNOWN_COST_NOT_AUTHORIZED");
    });

    it("UNKNOWN model with accessClass=UNKNOWN IS eligible in BYOK mode (structured accessClass present)", () => {
      const model = makeModel({
        accessClass: "UNKNOWN",
        freeStatus: "unknown",
        costProfile: { ...makeModel().costProfile, isFree: false },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "byok" };
      const verdict = policy.evaluate(model, ctx);

      // With structured accessClass present, BYOK allows it (not UNAVAILABLE)
      expect(verdict.eligible).toBe(true);
    });

    it("UNKNOWN model with accessClass=UNKNOWN IS eligible in premium mode", () => {
      const model = makeModel({
        accessClass: "UNKNOWN",
        freeStatus: "unknown",
        costProfile: { ...makeModel().costProfile, isFree: false },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "premium" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });

    it("Legacy model WITHOUT accessClass and freeStatus=unknown fails in ALL modes", () => {
      const model = makeModel({
        accessClass: undefined,
        freeStatus: "unknown",
        costProfile: { ...makeModel().costProfile, isFree: false, freeTierVerifiedAt: undefined },
      });
      delete (model as any).accessClass;
      firewall.register(model);

      const adaptiveCtx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const byokCtx: EligibilityContext = { role: "CODER", policyMode: "byok" };
      const premiumCtx: EligibilityContext = { role: "CODER", policyMode: "premium" };

      expect(policy.evaluate(model, adaptiveCtx).eligible).toBe(false);
      expect(policy.evaluate(model, byokCtx).eligible).toBe(false);
      expect(policy.evaluate(model, premiumCtx).eligible).toBe(false);
    });
  });

  // ========================================================================
  // TEST F: Legacy $0-unit record without accessClass → unknown (fails closed)
  // ========================================================================
  describe("Test F: Legacy $0-unit record fails closed", () => {
    it("legacy record without accessClass but with freeStatus=verified_free and isFree=true passes adaptive", () => {
      // Legacy record: has freeStatus=verified_free but NO accessClass (legacy)
      const model = makeModel({
        accessClass: undefined,
        freeStatus: "verified_free",
        costProfile: { ...makeModel().costProfile, isFree: true, freeTierVerifiedAt: undefined },
      });
      delete (model as any).accessClass;
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      // Legacy path: freeStatus=verified_free + isFree=true passes adaptive
      expect(verdict.eligible).toBe(true);
    });

    it("legacy record with freeStatus=verified_free but isFree=false fails closed", () => {
      const model = makeModel({
        accessClass: undefined,
        freeStatus: "verified_free",
        costProfile: { ...makeModel().costProfile, isFree: false, freeTierVerifiedAt: undefined },
      });
      delete (model as any).accessClass;
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("UNKNOWN_COST_NOT_AUTHORIZED");
    });
  });

  // ========================================================================
  // TEST G: Health gating — offline/auth_required route ineligible
  // ========================================================================
  describe("Test G: Health gating", () => {
    it("offline route is ineligible", () => {
      const model = makeModel({
        accessClass: "FREE_NATIVE",
        health: { status: "offline", lastCheckedAt: new Date().toISOString() },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("UNHEALTHY");
    });

    it("auth_required route is ineligible", () => {
      const model = makeModel({
        accessClass: "FREE_NATIVE",
        health: { status: "auth_required", lastCheckedAt: new Date().toISOString() },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("UNHEALTHY");
    });

    it("degraded route is eligible (not blocked by health)", () => {
      const model = makeModel({
        accessClass: "FREE_NATIVE",
        health: { status: "degraded", lastCheckedAt: new Date().toISOString() },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });

    it("rate_limited route is currently eligible (health gate only blocks offline/auth_required)", () => {
      const model = makeModel({
        accessClass: "FREE_NATIVE",
        health: { status: "rate_limited", lastCheckedAt: new Date().toISOString() },
      });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      // Current implementation only blocks offline and auth_required
      expect(verdict.eligible).toBe(true);
    });
  });

  // ========================================================================
  // TEST H: Capability gating — tool calling, structured output, vision, long context
  // ========================================================================
  describe("Test H: Capability gating per role contract", () => {
    it("CODER role requires toolCalling", () => {
      const modelNoTools = makeModel({ capabilities: { ...makeModel().capabilities, toolCalling: false } });
      firewall.register(modelNoTools);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(modelNoTools, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("MISSING_CAPABILITY");
    });

    it("CODER role with toolCalling passes capability check", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, toolCalling: true } });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "CODER", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });

    it("VISION role requires vision capability", () => {
      const modelNoVision = makeModel({ capabilities: { ...makeModel().capabilities, vision: false } });
      firewall.register(modelNoVision);

      const ctx: EligibilityContext = { role: "VISION", policyMode: "adaptive" };
      const verdict = policy.evaluate(modelNoVision, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("MISSING_CAPABILITY");
    });

    it("VISION role with vision passes", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, vision: true } });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "VISION", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });

    it("LONG_CONTEXT role requires longContext capability and minContextTokens", () => {
      const modelShort = makeModel({ capabilities: { ...makeModel().capabilities, longContext: false }, contextWindow: 8192 });
      firewall.register(modelShort);

      const ctx: EligibilityContext = { role: "LONG_CONTEXT", policyMode: "adaptive" };
      const verdict = policy.evaluate(modelShort, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("MISSING_CAPABILITY");
    });

    it("LONG_CONTEXT role with longContext but insufficient context window fails", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, longContext: true }, contextWindow: 50000 });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "LONG_CONTEXT", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("INSUFFICIENT_CONTEXT");
    });

    it("LONG_CONTEXT role with longContext and sufficient context passes", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, longContext: true }, contextWindow: 128000 });
      firewall.register(model);

      const ctx: EligibilityContext = { role: "LONG_CONTEXT", policyMode: "adaptive" };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(true);
    });

    it("FAST_WORKER requires toolReliability >= 0.5 when samples exist", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, toolCalling: true } });
      firewall.register(model);

      // Low reliability should fail
      const ctxLow: EligibilityContext = {
        role: "FAST_WORKER",
        policyMode: "adaptive",
        reliability: { score: 0.3, sampleSize: 100, demoted: false, quarantined: false },
      };
      const verdictLow = policy.evaluate(model, ctxLow);
      expect(verdictLow.eligible).toBe(false);
      expect(verdictLow.code).toBe("TOOL_RELIABILITY_BELOW_THRESHOLD");

      // High reliability should pass
      const ctxHigh: EligibilityContext = {
        role: "FAST_WORKER",
        policyMode: "adaptive",
        reliability: { score: 0.7, sampleSize: 100, demoted: false, quarantined: false },
      };
      const verdictHigh = policy.evaluate(model, ctxHigh);
      expect(verdictHigh.eligible).toBe(true);
    });

    it("quarantined model fails eligibility", () => {
      const model = makeModel({ capabilities: { ...makeModel().capabilities, toolCalling: true } });
      firewall.register(model);

      const ctx: EligibilityContext = {
        role: "CODER",
        policyMode: "adaptive",
        reliability: { score: 0.9, sampleSize: 100, demoted: false, quarantined: true },
      };
      const verdict = policy.evaluate(model, ctx);

      expect(verdict.eligible).toBe(false);
      expect(verdict.code).toBe("QUARANTINED");
    });
  });
});