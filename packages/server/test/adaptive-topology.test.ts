import { describe, expect, it } from "vitest";
import { resolveAdaptiveTopology } from "../src/adaptive-topology.js";

describe("Adaptive Topology — Deterministic Topology Selection & Baseline Preservation", () => {
  it("preserves fixed_r1 as default certified baseline when no hint is provided", () => {
    const plan = resolveAdaptiveTopology({ goal: "Add a new endpoint for user profile" });
    expect(plan.topology).toBe("fixed_r1");
    expect(plan.explorers).toBe(2);
    expect(plan.hasPlanner).toBe(true);
    expect(plan.hasReviewer).toBe(true);
    expect(plan.hasVision).toBe(false);
    expect(plan.requiresForgeVerify).toBe(true);
    expect(plan.stages).toEqual(["2 Explorers", "Planner", "Coder", "Reviewer", "ForgeVerify"]);
  });

  it("resolves explicitly requested topology", () => {
    const tiny = resolveAdaptiveTopology({ goal: "Any goal", requestedTopology: "tiny" });
    expect(tiny.topology).toBe("tiny");
    expect(tiny.explorers).toBe(0);
    expect(tiny.hasPlanner).toBe(false);
    expect(tiny.hasReviewer).toBe(false);
    expect(tiny.requiresForgeVerify).toBe(true);
    expect(tiny.stages).toEqual(["Coder", "ForgeVerify"]);

    const normal = resolveAdaptiveTopology({ goal: "Any goal", requestedTopology: "normal" });
    expect(normal.topology).toBe("normal");
    expect(normal.explorers).toBe(1);
    expect(normal.hasPlanner).toBe(false);
    expect(normal.hasReviewer).toBe(true);
    expect(normal.requiresForgeVerify).toBe(true);
    expect(normal.stages).toEqual(["Explorer", "Coder", "Reviewer", "ForgeVerify"]);

    const complex = resolveAdaptiveTopology({ goal: "Any goal", requestedTopology: "complex" });
    expect(complex.topology).toBe("complex");
    expect(complex.explorers).toBe(2);
    expect(complex.hasPlanner).toBe(true);
    expect(complex.hasReviewer).toBe(true);
    expect(complex.requiresForgeVerify).toBe(true);
    expect(complex.stages).toEqual(["Explorer A", "Explorer B", "Planner", "Coder", "Reviewer", "ForgeVerify"]);
  });

  it("routes to vision topology when images are present", () => {
    const plan = resolveAdaptiveTopology({
      goal: "Fix layout bug shown in screenshot",
      hasImages: true,
    });
    expect(plan.topology).toBe("vision");
    expect(plan.hasVision).toBe(true);
    expect(plan.explorers).toBe(1);
    expect(plan.hasReviewer).toBe(true);
    expect(plan.requiresForgeVerify).toBe(true);
    expect(plan.stages).toEqual(["Vision Worker", "Explorer", "Coder", "Reviewer", "ForgeVerify"]);
  });

  it("resolves complexity hints deterministically", () => {
    const tiny = resolveAdaptiveTopology({ goal: "Fix something", complexityHint: "tiny" });
    expect(tiny.topology).toBe("tiny");
    expect(tiny.stages).toEqual(["Coder", "ForgeVerify"]);

    const normal = resolveAdaptiveTopology({ goal: "Fix something", complexityHint: "normal" });
    expect(normal.topology).toBe("normal");
    expect(normal.stages).toEqual(["Explorer", "Coder", "Reviewer", "ForgeVerify"]);

    const complex = resolveAdaptiveTopology({ goal: "Fix something", complexityHint: "complex" });
    expect(complex.topology).toBe("normal");
    expect(complex.hasPlanner).toBe(false);
    expect(complex.reason).toContain("Planner value is not established");

    const provenComplex = resolveAdaptiveTopology({ goal: "Fix something", complexityHint: "complex", plannerValueProven: true });
    expect(provenComplex.topology).toBe("complex");
    expect(provenComplex.stages).toEqual(["Explorer A", "Explorer B", "Planner", "Coder", "Reviewer", "ForgeVerify"]);
  });

  it("matches deterministic keywords in goals", () => {
    const typo = resolveAdaptiveTopology({ goal: "Fix typo in README.md" });
    expect(typo.topology).toBe("tiny");

    const refactor = resolveAdaptiveTopology({ goal: "Refactor architecture across packages" });
    expect(refactor.topology).toBe("normal");
    expect(refactor.hasPlanner).toBe(false);
    expect(refactor.reason).toContain("Planner value is not established");

    const provenRefactor = resolveAdaptiveTopology({ goal: "Refactor architecture across packages", plannerValueProven: true });
    expect(provenRefactor.topology).toBe("complex");
    expect(provenRefactor.hasPlanner).toBe(true);
  });

  it("keeps automatic cross-cutting goals serial when Planner value is unproven and capacity is constrained", () => {
    const plan = resolveAdaptiveTopology({
      goal: "Refactor architecture across packages",
      providerCapacity: { distinctHealthyProviders: 1, minimumRouteConcurrency: 1, saturatedRoutes: 1 },
    });
    expect(plan.topology).toBe("normal");
    expect(plan.reason).toContain("Planner value is not established");
    expect(plan.requiresForgeVerify).toBe(true);
  });

  it("does not let capacity advice override an explicit topology request", () => {
    const plan = resolveAdaptiveTopology({
      goal: "Any goal",
      requestedTopology: "complex",
      providerCapacity: { distinctHealthyProviders: 1, minimumRouteConcurrency: 1 },
    });
    expect(plan.topology).toBe("complex");
  });

  it("strictly enforces that requiresForgeVerify is true across ALL topologies", () => {
    const topologies = ["fixed_r1", "tiny", "normal", "complex", "vision"] as const;
    for (const topo of topologies) {
      const plan = resolveAdaptiveTopology({ goal: "test", requestedTopology: topo });
      expect(plan.requiresForgeVerify).toBe(true);
      expect(plan.stages).toContain("ForgeVerify");
    }
  });

  it("R45: reduces a covered normal task to tiny+packet when the free window is narrow", () => {
    const plan = resolveAdaptiveTopology({
      goal: "Fix the totals bug in report.mjs",
      complexityHint: "normal",
      orientationCoverage: { covered: true, candidateFiles: 3 },
      providerCapacity: { distinctHealthyProviders: 1, minimumRouteConcurrency: 1, saturatedRoutes: 2 },
    });
    expect(plan.topology).toBe("tiny");
    expect(plan.explorers).toBe(0);
    expect(plan.requiresForgeVerify).toBe(true);
    expect(plan.reason).toContain("orientation packet");
  });

  it("R45: keeps normal topology when coverage is strong but capacity is healthy", () => {
    const plan = resolveAdaptiveTopology({
      goal: "Fix the totals bug in report.mjs",
      complexityHint: "normal",
      orientationCoverage: { covered: true, candidateFiles: 3 },
      providerCapacity: { distinctHealthyProviders: 3, minimumRouteConcurrency: 2, saturatedRoutes: 0 },
    });
    expect(plan.topology).toBe("normal");
    expect(plan.explorers).toBe(1);
  });

  it("R45: never reduces on coverage alone, unobserved capacity, or weak coverage", () => {
    // Narrow capacity but weak coverage — a packet that missed the target must not justify a
    // smaller team.
    const weak = resolveAdaptiveTopology({
      goal: "Fix the totals bug",
      complexityHint: "normal",
      orientationCoverage: { covered: false, candidateFiles: 0 },
      providerCapacity: { distinctHealthyProviders: 0, minimumRouteConcurrency: 0, saturatedRoutes: 4 },
    });
    expect(weak.topology).toBe("normal");
    // Covered but capacity unobserved — honesty over optimism.
    const unobserved = resolveAdaptiveTopology({
      goal: "Fix the totals bug",
      complexityHint: "normal",
      orientationCoverage: { covered: true, candidateFiles: 3 },
    });
    expect(unobserved.topology).toBe("normal");
    // An explicit normal request ignores the coverage signal entirely.
    const explicit = resolveAdaptiveTopology({
      goal: "Fix the totals bug",
      requestedTopology: "normal",
      orientationCoverage: { covered: true, candidateFiles: 3 },
      providerCapacity: { distinctHealthyProviders: 0, minimumRouteConcurrency: 0, saturatedRoutes: 4 },
    });
    expect(explicit.topology).toBe("normal");
    expect(explicit.explorers).toBe(1);
  });
});
