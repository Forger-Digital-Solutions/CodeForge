import { describe, expect, it } from "vitest";
import {
  buildSustainabilityWorkloadFixtures,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  generateForgeGreenSummary,
} from "../src/index.js";

describe("FG-8 realistic workload fixtures (deterministic, zero network)", () => {
  const fixtures = buildSustainabilityWorkloadFixtures();

  it("covers the seven required workload shapes", () => {
    const ids = fixtures.map((f) => f.workloadId).sort();
    expect(ids).toEqual(
      [
        "context_heavy_repository_task",
        "multi_file_edit",
        "provider_failure_fallback_task",
        "repository_search",
        "small_bug_fix",
        "tool_heavy_task",
        "verification_heavy_task",
      ].sort(),
    );
  });

  it.each(buildSustainabilityWorkloadFixtures())("produces a complete, finalized receipt + summary for $workloadId", (fixture) => {
    const draft = createSustainabilityReceipt({
      identity: fixture.identity,
      normalized: fixture.normalized,
      contextPopulation: fixture.contextPopulation,
    });
    expect(draft.measurementStatus).toBe("complete");
    const finalized = finalizeSustainabilityReceipt(draft);
    expect(finalized.finalized).toBe(true);
    const summary = generateForgeGreenSummary(finalized);
    expect(summary.headline.length).toBeGreaterThan(0);
    expect(summary.lines[0]).toBe("ForgeGreen");
  });

  it("is fully deterministic: rebuilding from the same fixture twice yields identical accounting/waste/baselines", () => {
    for (const fixture of fixtures) {
      const a = createSustainabilityReceipt({ identity: fixture.identity, normalized: fixture.normalized, contextPopulation: fixture.contextPopulation });
      const b = createSustainabilityReceipt({ identity: fixture.identity, normalized: fixture.normalized, contextPopulation: fixture.contextPopulation });
      expect(a.tokenAccounting).toEqual(b.tokenAccounting);
      expect(a.wasteBreakdown).toEqual(b.wasteBreakdown);
      const stripTimestamps = (baselines: typeof a.baselines) => baselines.map(({ createdAt, ...rest }) => rest);
      expect(stripTimestamps(a.baselines)).toEqual(stripTimestamps(b.baselines));
    }
  });

  it("the context-heavy workload's Baseline B never equates repository size with eligible context and states its population explicitly", () => {
    const fixture = fixtures.find((f) => f.workloadId === "context_heavy_repository_task")!;
    const receipt = createSustainabilityReceipt({ identity: fixture.identity, normalized: fixture.normalized, contextPopulation: fixture.contextPopulation });
    const baselineB = receipt.baselines.find((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT");
    expect(baselineB).toBeDefined();
    expect(baselineB?.contextPopulation?.fullContextDefinition.length).toBeGreaterThan(0);
    expect(baselineB?.contextPopulation?.excludedFileCount).toBeGreaterThan(0);
  });

  it("the provider-failure workload surfaces fallback/rotation waste and a Baseline C comparison", () => {
    const fixture = fixtures.find((f) => f.workloadId === "provider_failure_fallback_task")!;
    const receipt = createSustainabilityReceipt({ identity: fixture.identity, normalized: fixture.normalized });
    expect(receipt.wasteBreakdown.some((w) => w.category === "retry_overhead")).toBe(true);
    expect(receipt.baselines.some((b) => b.baselineKind === "C_NAIVE_SEQUENTIAL_RETRY")).toBe(true);
  });
});
