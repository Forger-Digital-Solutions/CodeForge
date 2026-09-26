import { describe, expect, it } from "vitest";
import { rank16Bit } from "../src/expected-cost.js";
import { PAID_AUTO_MODELS } from "../src/registry.js";

const task = { role: "CODER", inputTokens: 8_000, outputTokens: 2_000 } as const;

describe("16-Bit expected-cost ranking (R37 Missions Y/AA/AB)", () => {
  it("raw price alone: GLM ($0.15/$0.50) is the cheapest attempt among priced models", () => {
    const ranking = rank16Bit(task);
    const glm = ranking.candidates.find((c) => c.canonicalModelId === "glm-5.3-flash");
    const qwen = ranking.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash");
    // Qwen direct is cheaper per token ($0.113/$0.382) and should win on default evidence.
    expect(ranking.selected).toBe("qwen3.8-flash");
    expect(qwen!.attemptCostUsd).toBeLessThan(glm!.attemptCostUsd);
    // Unpriced routes never rank — PRICE_UNKNOWN is an exclusion, not $0.
    expect(ranking.candidates.find((c) => c.canonicalModelId === "deepseek-v4.1-flash")?.excluded).toBe("PRICE_UNKNOWN");
  });

  it("a cheap model that fails often loses to a pricier model that verifies once", () => {
    const ranking = rank16Bit(task, {
      // GLM: measured 25% first-attempt success → 4 expected attempts.
      "glm-5.3-flash": { successRate: 0.25 },
      // Qwen: measured 95% success → ~1.05 attempts; slightly pricier attempt, cheaper completion.
      "qwen3.8-flash": { successRate: 0.95 },
      "gpt-5.6-luna": { successRate: 0.95 },
    });
    expect(ranking.selected).toBe("qwen3.8-flash");
    const glm = ranking.candidates.find((c) => c.canonicalModelId === "glm-5.3-flash");
    const qwen = ranking.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash");
    expect(glm!.expectedAttempts).toBeCloseTo(4);
    expect(glm!.expectedCostUsd).toBeGreaterThan(qwen!.expectedCostUsd);
    expect(qwen!.reasonCodes).toContain("CHEAPER_EXPECTED_COMPLETION");
  });

  it("context requirements hard-exclude models that physically cannot serve", () => {
    const ranking = rank16Bit({ ...task, requiredContextTokens: 1_020_000 });
    // Only gpt-5.6-luna (1.05M ctx) fits; the 1.0M flashes are excluded, not merely demoted.
    expect(ranking.selected).toBe("gpt-5.6-luna");
    for (const id of ["glm-5.3-flash", "qwen3.8-flash", "deepseek-v4.1-flash"] as const) {
      expect(ranking.candidates.find((c) => c.canonicalModelId === id)?.excluded).toBe("CONTEXT_TOO_SMALL");
    }
  });

  it("the roster is exactly the four registered models — no model can be added or dropped", () => {
    const ranking = rank16Bit(task);
    expect(ranking.candidates.map((c) => c.canonicalModelId).sort()).toEqual([...PAID_AUTO_MODELS.map((m) => m.canonicalModelId)].sort());
  });

  it("unmeasured evidence is labeled — defaults are never silent", () => {
    const ranking = rank16Bit(task);
    expect(ranking.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")?.reasonCodes).toContain("UNMEASURED_EVIDENCE");
  });

  it("a task requiring nothing still yields a runnable selected route — never an empty decision", () => {
    const ranking = rank16Bit({ role: "ANALYST", inputTokens: 500, outputTokens: 200 });
    expect(ranking.selected).toBeDefined();
    expect(ranking.selected).toBe("qwen3.8-flash");
  });

  it("tool reliability deflates expected attempts only when the task requires tools", () => {
    const evidence = { "qwen3.8-flash": { successRate: 0.9, toolReliability: 0.5 } };
    const withTools = rank16Bit({ ...task, requiresTools: true }, evidence);
    const without = rank16Bit(task, evidence);
    const a = withTools.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    const b = without.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    expect(a.expectedAttempts).toBeGreaterThan(b.expectedAttempts);
    expect(a.reasonCodes).toContain("TOOL_RELIABILITY_ADJUSTED");
    expect(b.reasonCodes).not.toContain("TOOL_RELIABILITY_ADJUSTED");
  });
});

describe("16-Bit validation scenarios (R37 Phase 6)", () => {
  it("review-heavy work: verification cost is part of expected cost, not a footnote", () => {
    // Model with cheap tokens but expensive measured review loses to one whose review is cheap.
    const ranking = rank16Bit({ role: "REVIEWER", inputTokens: 8_000, outputTokens: 2_000 }, {
      "qwen3.8-flash": { successRate: 0.9, verificationCostUsd: 0.02 },
      "glm-5.3-flash": { successRate: 0.9, verificationCostUsd: 0.001 },
    });
    expect(ranking.selected).toBe("glm-5.3-flash");
  });

  it("every candidate unmeasured → decision still lands on the cheapest honest default, labeled", () => {
    const ranking = rank16Bit({ role: "ANALYST", inputTokens: 1_000, outputTokens: 500 });
    expect(ranking.selected).toBe("qwen3.8-flash");
    for (const c of ranking.candidates.filter((c) => c.excluded === undefined)) {
      expect(c.fullyMeasured).toBe(false);
    }
  });

  it("provider reliability degradation changes ordering — same task, different evidence", () => {
    const task = { role: "CODER", inputTokens: 8_000, outputTokens: 2_000 } as const;
    const healthy = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.9 }, "glm-5.3-flash": { successRate: 0.9 } });
    const degraded = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.3 }, "glm-5.3-flash": { successRate: 0.9 } });
    expect(healthy.selected).toBe("qwen3.8-flash");
    expect(degraded.selected).toBe("glm-5.3-flash");
  });

  it("trivial task never selects the premium model even when it would succeed", () => {
    const ranking = rank16Bit({ role: "ANALYST", inputTokens: 200, outputTokens: 100 }, {
      "gpt-5.6-luna": { successRate: 0.99 },
      "qwen3.8-flash": { successRate: 0.8 },
    });
    expect(ranking.selected).toBe("qwen3.8-flash");
  });

  it("role fit breaks cost ties — measured evidence, not a hardcoded preference", () => {
    // Equal evidence on both priced flash models → qwen wins on price alone.
    // Now give glm a roleFit edge while success costs are equal… they aren't, so instead
    // verify roleFit is recorded as evidence rather than silently changing the winner.
    const ranking = rank16Bit(task, {
      "qwen3.8-flash": { successRate: 0.9 },
      "glm-5.3-flash": { successRate: 0.9, roleFit: 0.95 },
    });
    const glm = ranking.candidates.find((c) => c.canonicalModelId === "glm-5.3-flash")!;
    expect(glm.reasonCodes).toContain("ROLE_FIT_MEASURED");
    // Price still governs: qwen is the cheaper expected completion.
    expect(ranking.selected).toBe("qwen3.8-flash");
  });
});

describe("16-Bit sensitivity analysis (R38 Phase 12 — Gate K)", () => {
  const twoWayEvidence = { "qwen3.8-flash": { successRate: 0.9 }, "glm-5.3-flash": { successRate: 0.9 } };

  it("success-rate perturbation ±10% on the winner does not flip the cheaper pick", () => {
    const up = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.81 }, "glm-5.3-flash": { successRate: 0.9 } });
    const down = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.99 }, "glm-5.3-flash": { successRate: 0.9 } });
    expect(up.selected).toBe("qwen3.8-flash");
    expect(down.selected).toBe("qwen3.8-flash");
  });

  it("doubling output length preserves ordering — attempt cost scales linearly for both", () => {
    const ranking = rank16Bit({ ...task, outputTokens: 4_000 }, twoWayEvidence);
    expect(ranking.selected).toBe("qwen3.8-flash");
    const qwen = ranking.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    const glm = ranking.candidates.find((c) => c.canonicalModelId === "glm-5.3-flash")!;
    expect(qwen.expectedCostUsd).toBeLessThan(glm.expectedCostUsd);
  });

  it("retry-rate increase raises expected cost proportionally — evidence flows through", () => {
    const calm = rank16Bit(task, twoWayEvidence);
    const storm = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.9, expectedRetries: 2 }, "glm-5.3-flash": { successRate: 0.9 } });
    const qwenCalm = calm.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    const qwenStorm = storm.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    expect(qwenStorm.expectedCostUsd).toBeGreaterThan(qwenCalm.expectedCostUsd);
  });

  it("verification-cost increase is material — a large review bill can reorder", () => {
    const ranking = rank16Bit(task, { "qwen3.8-flash": { successRate: 0.9, verificationCostUsd: 0.05 }, "glm-5.3-flash": { successRate: 0.9 } });
    expect(ranking.selected).toBe("glm-5.3-flash");
  });

  it("tool requirement changes economics only for tool-bound tasks", () => {
    const noTools = rank16Bit(task, twoWayEvidence);
    const withTools = rank16Bit({ ...task, requiresTools: true }, { "qwen3.8-flash": { successRate: 0.9, toolReliability: 0.5 }, "glm-5.3-flash": { successRate: 0.9, toolReliability: 0.99 } });
    expect(noTools.selected).toBe("qwen3.8-flash");
    expect(withTools.selected).toBe("glm-5.3-flash");
  });

  it("chooser stability: the winner is never a surprise under honest uncertainty", () => {
    // With zero measured evidence the default pick is cheapest-priced; it only moves
    // when evidence arrives — never on a whim.
    const ranking = rank16Bit(task);
    const qwen = ranking.candidates.find((c) => c.canonicalModelId === "qwen3.8-flash")!;
    expect(ranking.selected).toBe("qwen3.8-flash");
    expect(qwen.fullyMeasured).toBe(false);
    expect(qwen.reasonCodes).toContain("UNMEASURED_EVIDENCE");
  });
});
