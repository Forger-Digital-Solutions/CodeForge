import { describe, expect, it } from "vitest";
import { adviseProviderAwareTopology } from "../src/index.js";

describe("ForgeGreen provider-aware topology advice", () => {
  it("advises serial work when two explorers would concentrate on one constrained provider", () => {
    expect(adviseProviderAwareTopology(2, { distinctHealthyProviders: 1, minimumRouteConcurrency: 1, saturatedRoutes: 1 })).toEqual({
      plannedParallelAgents: 2,
      recommendedParallelAgents: 1,
      shouldReduceParallelism: true,
      reasonCodes: ["SATURATED_ROUTE_EXCLUDED", "CAPACITY_CONCURRENCY_LIMIT", "PROVIDER_CONCENTRATION"],
    });
  });

  it("retains parallel exploration only when independent provider capacity supports it", () => {
    expect(adviseProviderAwareTopology(2, { distinctHealthyProviders: 2, minimumRouteConcurrency: 2 })).toEqual({
      plannedParallelAgents: 2,
      recommendedParallelAgents: 2,
      shouldReduceParallelism: false,
      reasonCodes: ["PROVIDER_CAPACITY_DIVERSE"],
    });
  });

  it("does not fabricate capacity when there is no observation", () => {
    expect(adviseProviderAwareTopology(2, undefined).reasonCodes).toEqual(["PROVIDER_CAPACITY_UNOBSERVED"]);
  });

  it("steps down to whatever capacity actually supports rather than always collapsing to solo", () => {
    // 4 planned, only 2 distinct healthy providers but ample concurrency: recommend 2, not 1 —
    // using real available diversity beats forcing every constrained plan down to a single agent.
    const advice = adviseProviderAwareTopology(4, { distinctHealthyProviders: 2, minimumRouteConcurrency: 4 });
    expect(advice.shouldReduceParallelism).toBe(true);
    expect(advice.recommendedParallelAgents).toBe(2);
    expect(advice.reasonCodes).toEqual(["PROVIDER_CONCENTRATION"]);
  });

  it("concurrency is the tighter constraint: 4 planned, 3 providers but only 2 concurrent slots recommends 2", () => {
    const advice = adviseProviderAwareTopology(4, { distinctHealthyProviders: 3, minimumRouteConcurrency: 2 });
    expect(advice.recommendedParallelAgents).toBe(2);
    expect(advice.reasonCodes).toEqual(["CAPACITY_CONCURRENCY_LIMIT", "PROVIDER_CONCENTRATION"]);
  });

  it("floors at 1 when capacity supports none of the plan, never 0 or negative", () => {
    const advice = adviseProviderAwareTopology(4, { distinctHealthyProviders: 0, minimumRouteConcurrency: 0 });
    expect(advice.recommendedParallelAgents).toBe(1);
  });

  it("4 agents on one constrained provider is recognized as worse than provider-diverse capacity supporting 4", () => {
    const concentrated = adviseProviderAwareTopology(4, { distinctHealthyProviders: 1, minimumRouteConcurrency: 4 });
    expect(concentrated.shouldReduceParallelism).toBe(true);
    expect(concentrated.recommendedParallelAgents).toBe(1);

    const diverse = adviseProviderAwareTopology(4, { distinctHealthyProviders: 4, minimumRouteConcurrency: 4 });
    expect(diverse.shouldReduceParallelism).toBe(false);
    expect(diverse.recommendedParallelAgents).toBe(4);
  });

  it("retains full parallel exploration at 4 agents only when independent provider capacity actually supports it", () => {
    expect(adviseProviderAwareTopology(4, { distinctHealthyProviders: 4, minimumRouteConcurrency: 4 })).toEqual({
      plannedParallelAgents: 4,
      recommendedParallelAgents: 4,
      shouldReduceParallelism: false,
      reasonCodes: ["PROVIDER_CAPACITY_DIVERSE"],
    });
  });
});
