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
    expect(complex.topology).toBe("complex");
    expect(complex.stages).toEqual(["Explorer A", "Explorer B", "Planner", "Coder", "Reviewer", "ForgeVerify"]);
  });

  it("matches deterministic keywords in goals", () => {
    const typo = resolveAdaptiveTopology({ goal: "Fix typo in README.md" });
    expect(typo.topology).toBe("tiny");

    const refactor = resolveAdaptiveTopology({ goal: "Refactor architecture across packages" });
    expect(refactor.topology).toBe("complex");
  });

  it("strictly enforces that requiresForgeVerify is true across ALL topologies", () => {
    const topologies = ["fixed_r1", "tiny", "normal", "complex", "vision"] as const;
    for (const topo of topologies) {
      const plan = resolveAdaptiveTopology({ goal: "test", requestedTopology: topo });
      expect(plan.requiresForgeVerify).toBe(true);
      expect(plan.stages).toContain("ForgeVerify");
    }
  });
});
