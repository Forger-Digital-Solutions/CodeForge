import { describe, expect, it } from "vitest";
import {
  createSustainabilityReceipt,
  derivedSavingsPercent,
  describeBaselineD,
  generateAllBaselines,
  normalizeMeasurementInput,
  simulateBaselineB,
  type ContextComparisonPopulation,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 baseline / counterfactual framework", () => {
  it("[24] a deterministic simulated baseline reproduces the same numerator/denominator for the same input", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { requestCount: 4 } });
    const withRouting = { ...normalized, routing: { ...normalized.routing, fallbackEvents: 1, coverage: "derived_from_authoritative_telemetry" as const } };
    const first = generateAllBaselines(withRouting);
    const second = generateAllBaselines(withRouting);
    // createdAt timestamps may legitimately differ by a few ms; everything else must match exactly.
    const strip = (arr: typeof first) => arr.map(({ createdAt, ...rest }) => rest);
    expect(strip(first)).toEqual(strip(second));
    const baselineA = first.find((b) => b.baselineKind === "A_FIXED_MODEL_NO_SMART_ROUTING");
    expect(baselineA?.numerator).toBe(1);
    expect(baselineA?.denominator).toBe(4);
    expect(baselineA?.comparisonBasis).toBe("simulated");
  });

  it("[25] no baseline means no savings claim", () => {
    const identity = id();
    const emptyNormalized = normalizeMeasurementInput({ identity }); // nothing measured at all
    const baselines = generateAllBaselines(emptyNormalized);
    expect(baselines).toEqual([]);
    const receipt = createSustainabilityReceipt({ identity, normalized: emptyNormalized });
    expect(receipt.baselines).toEqual([]);
  });

  it("[26] prevented work is only counted when attributable to a mechanism-proven counterfactual", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { requestCount: 1 } });
    const withDuplicates = { ...normalized, tools: { ...normalized.tools, duplicateActionsSuppressed: 3, coverage: "directly_measured" as const } };
    const receipt = createSustainabilityReceipt({ identity, normalized: withDuplicates });
    const prevented = receipt.wasteBreakdown.filter((w) => w.category === "prevented_waste");
    expect(prevented.length).toBeGreaterThan(0);
    for (const entry of prevented) {
      expect(entry.requiresBaseline).toBe(true);
      expect(entry.reasonCodes.length).toBeGreaterThan(0);
    }
    // No suppression recorded -> no prevented_waste entry fabricated.
    const noneReceipt = createSustainabilityReceipt({ identity, normalized });
    expect(noneReceipt.wasteBreakdown.some((w) => w.category === "prevented_waste")).toBe(false);
  });

  it("[27] verification removal can never be represented as an optimization baseline", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity });
    const withVerification = { ...normalized, verification: { ...normalized.verification, obligationsGenerated: 4, targetedSuitesUsed: 2, fullSuitesRequired: 1, coverage: "derived_from_authoritative_telemetry" as const } };
    const baselineD = describeBaselineD(withVerification);
    expect(baselineD).toBeDefined();
    expect(baselineD?.numerator).toBeUndefined();
    expect(baselineD?.denominator).toBeUndefined();
    expect(derivedSavingsPercent(baselineD!)).toBeUndefined();
  });

  it("Baseline B never equates total repository size with eligible model context — it requires an explicit population", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity });
    const population: ContextComparisonPopulation = {
      fullContextDefinition: "All indexed files at current generation, excluding binary/generated/gitignored.",
      eligibleFileCount: 100,
      excludedFileCount: 20,
      exclusionReasons: { binary: 10, generated: 10 },
      eligibleBytes: 500_000,
      eligibleTokensEstimate: 125_000,
      actualTransmittedBytes: 50_000,
      actualTransmittedTokens: 12_500,
      naivePolicyBytes: 500_000,
      naivePolicyTokens: 125_000,
    };
    const baselineB = simulateBaselineB(normalized, population);
    expect(baselineB?.contextPopulation).toEqual(population);
    expect(baselineB?.numerator).toBe(450_000);
    expect(derivedSavingsPercent(baselineB!)).toBe(90);

    // Without a supplied population, Baseline B is simply absent — never guessed.
    const withoutPopulation = generateAllBaselines(normalized);
    expect(withoutPopulation.some((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT")).toBe(false);
  });
});
