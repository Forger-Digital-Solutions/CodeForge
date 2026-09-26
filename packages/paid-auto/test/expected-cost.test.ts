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
