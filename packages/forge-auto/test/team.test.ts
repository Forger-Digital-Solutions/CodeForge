import { describe, expect, it } from "vitest";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { selectForgeAutoTeam, planForgeAutoTeam, NO_ELIGIBLE_FREE_MODEL } from "../src/team.js";
import type { TaskClassification } from "../src/classification.js";

function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId: "groq",
    modelId: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    tier: "free",
    accessClass: "FREE_NATIVE",
    authMode: "no_auth",
    privacyClass: "public",
    family: "llama",
    upstreamSource: "groq",
    deprecated: false,
    contextWindow: 128000,
    maxOutput: 4096,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date().toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "groq",
    },
    benchmarkProfile: { coding: 80, reasoning: 80, speed: 90, toolCalling: 80 },
    ...overrides,
  };
}

describe("Forge Auto Top-Four Team Selection", () => {
  const modelPlanner = makeModel({
    providerId: "openrouter",
    modelId: "deepseek-r1:free",
    displayName: "DeepSeek R1 Free",
    contextWindow: 160000,
    benchmarkProfile: { coding: 75, reasoning: 95, speed: 45, toolCalling: 70 },
  });

  const modelSwe = makeModel({
    providerId: "groq",
    modelId: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B Versatile",
    codingScore: 92,
    benchmarkProfile: { coding: 92, reasoning: 80, speed: 95, toolCalling: 90 },
  });

  const modelReviewer = makeModel({
    providerId: "cloudflare",
    modelId: "@cf/meta/llama-3.1-70b-instruct",
    displayName: "Llama 3.1 70B Instruct",
    benchmarkProfile: { coding: 84, reasoning: 86, speed: 80, toolCalling: 82 },
  });

  const modelVerifier = makeModel({
    providerId: "cerebras",
    modelId: "llama-3.1-8b",
    displayName: "Llama 3.1 8B Fast",
    benchmarkProfile: { coding: 70, reasoning: 68, speed: 100, toolCalling: 88 },
  });

  const fullRoster = [modelPlanner, modelSwe, modelReviewer, modelVerifier];

  it("selects a 1-seat team for a trivial task", () => {
    const classification: TaskClassification = {
      kind: "DOCUMENTATION",
      complexity: "TRIVIAL",
      risk: 10,
      verificationBurden: "LIGHT",
      specialistPlan: ["SWE"],
      reasons: ["classified_documentation"],
    };

    const team = selectForgeAutoTeam({ roster: fullRoster, classification, rosterRevision: 101 });
    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists).toHaveLength(1);
      expect(team.specialists[0]!.seat).toBe("SWE");
      expect(team.specialists[0]!.modelId).toBe(modelSwe.modelId);
      expect(team.rosterRevision).toBe(101);
    }
  });

  it("selects a 2-seat team for moderate feature task", () => {
    const classification: TaskClassification = {
      kind: "FEATURE",
      complexity: "MODERATE",
      risk: 45,
      verificationBurden: "STANDARD",
      specialistPlan: ["PLANNER", "SWE"],
      reasons: ["classified_feature"],
    };

    const team = selectForgeAutoTeam({ roster: fullRoster, classification });
    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists).toHaveLength(2);
      expect(team.specialists.map((s) => s.seat)).toEqual(["PLANNER", "SWE"]);
    }
  });

  it("selects a 4-seat complementary team for an architectural task", () => {
    const classification: TaskClassification = {
      kind: "ARCHITECTURE",
      complexity: "COMPLEX",
      risk: 80,
      verificationBurden: "EXTENSIVE",
      specialistPlan: ["PLANNER", "SWE", "REVIEWER", "VERIFIER"],
      reasons: ["classified_architecture"],
    };

    const team = selectForgeAutoTeam({ roster: fullRoster, classification });
    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists).toHaveLength(4);
      const seats = team.specialists.map((s) => s.seat);
      expect(seats).toEqual(["PLANNER", "SWE", "REVIEWER", "VERIFIER"]);
      // Seats should have distinct complementary models when roster allows
      const uniqueModels = new Set(team.specialists.map((s) => s.modelId));
      expect(uniqueModels.size).toBe(4);
    }
  });

  it("excludes cooling-down and unadmitted routes", () => {
    const classification: TaskClassification = {
      kind: "FEATURE",
      complexity: "MODERATE",
      risk: 40,
      verificationBurden: "STANDARD",
      specialistPlan: ["SWE"],
      reasons: [],
    };

    const team = selectForgeAutoTeam({
      roster: fullRoster,
      classification,
      filters: {
        isCoolingDown: (p, m) => p === "groq" && m === "llama-3.3-70b-versatile",
      },
    });

    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists[0]!.modelId).not.toBe("llama-3.3-70b-versatile");
    }
  });

  it("excludes quota-exhausted routes", () => {
    const classification: TaskClassification = {
      kind: "FEATURE",
      complexity: "TRIVIAL",
      risk: 20,
      verificationBurden: "LIGHT",
      specialistPlan: ["SWE"],
      reasons: [],
    };

    const team = selectForgeAutoTeam({
      roster: [modelSwe, modelReviewer],
      classification,
      filters: {
        isQuotaExhausted: (p, m) => m === modelSwe.modelId,
      },
    });

    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists[0]!.modelId).toBe(modelReviewer.modelId);
    }
  });

  it("fails closed with NO_ELIGIBLE_FREE_MODEL when all routes filtered", () => {
    const classification: TaskClassification = {
      kind: "FEATURE",
      complexity: "MODERATE",
      risk: 40,
      verificationBurden: "STANDARD",
      specialistPlan: ["SWE"],
      reasons: [],
    };

    const team = selectForgeAutoTeam({
      roster: fullRoster,
      classification,
      filters: {
        hasAdapter: () => false, // No adapter registered
      },
    });

    expect(team.outcome).toBe(NO_ELIGIBLE_FREE_MODEL);
    if (team.outcome === NO_ELIGIBLE_FREE_MODEL) {
      expect(team.reasonCodes).toContain(NO_ELIGIBLE_FREE_MODEL);
    }
  });

  it("deterministically breaks ties using modelId", () => {
    const model1 = makeModel({ providerId: "p1", modelId: "model-alpha", codingScore: 80 });
    const model2 = makeModel({ providerId: "p2", modelId: "model-beta", codingScore: 80 });

    const classification: TaskClassification = {
      kind: "FEATURE",
      complexity: "TRIVIAL",
      risk: 20,
      verificationBurden: "LIGHT",
      specialistPlan: ["SWE"],
      reasons: [],
    };

    const teamA = selectForgeAutoTeam({ roster: [model1, model2], classification });
    const teamB = selectForgeAutoTeam({ roster: [model2, model1], classification });

    expect(teamA.outcome).toBe("SELECTED");
    expect(teamB.outcome).toBe("SELECTED");
    if (teamA.outcome === "SELECTED" && teamB.outcome === "SELECTED") {
      expect(teamA.specialists[0]!.modelId).toBe(teamB.specialists[0]!.modelId);
    }
  });

  it("honestly reuses models when roster is smaller than seat plan", () => {
    const classification: TaskClassification = {
      kind: "ARCHITECTURE",
      complexity: "COMPLEX",
      risk: 80,
      verificationBurden: "EXTENSIVE",
      specialistPlan: ["PLANNER", "SWE", "REVIEWER", "VERIFIER"],
      reasons: [],
    };

    const team = selectForgeAutoTeam({ roster: [modelSwe], classification });
    expect(team.outcome).toBe("SELECTED");
    if (team.outcome === "SELECTED") {
      expect(team.specialists).toHaveLength(4);
      expect(team.specialists[1]!.reasons).toContain("roster_smaller_than_plan_reused");
    }
  });
});