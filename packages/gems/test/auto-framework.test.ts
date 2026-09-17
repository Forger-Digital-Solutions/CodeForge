import { describe, expect, it } from "vitest";
import { planGemsAutoScenario, type GemsCapabilityProfile } from "../src/auto-framework.js";

const profiles: GemsCapabilityProfile[] = [
  { id: "gem-fast", lifecycle: "synthetic", capabilities: { explorer: 0.7, planner: 0.5, coder: 0.6, reviewer: 0.5 }, contextTokens: 128_000, latencyMs: 80, reliability: 0.8 },
  { id: "gem-planner", lifecycle: "synthetic", capabilities: { explorer: 0.7, planner: 0.98, coder: 0.6, reviewer: 0.8 }, contextTokens: 128_000, latencyMs: 180, reliability: 0.9 },
  { id: "gem-coder", lifecycle: "frozen_nonproduction", capabilities: { explorer: 0.6, planner: 0.7, coder: 0.99, reviewer: 0.75 }, contextTokens: 256_000, latencyMs: 250, reliability: 0.96 },
  { id: "sapphire-1.1", lifecycle: "unfinished", capabilities: { explorer: 1, planner: 1, coder: 1, reviewer: 1 }, contextTokens: 1_000_000, latencyMs: 1, reliability: 1 },
];

describe("future GEMS Auto framework", () => {
  it("chooses role-specialised nonproduction profiles but never makes them executable", () => {
    const plan = planGemsAutoScenario({ complexity: "hard", requiredContextTokens: 100_000 }, profiles);
    expect(plan.outcome).toBe("planned");
    if (plan.outcome !== "planned") return;
    expect(plan.mode).toBe("simulation_only");
    expect(plan.assignments.find((assignment) => assignment.role === "planner")?.profileId).toBe("gem-planner");
    expect(plan.assignments.find((assignment) => assignment.role === "coder")?.profileId).toBe("gem-coder");
    expect(plan.excludedUnfinishedProfileIds).toEqual(["sapphire-1.1"]);
  });

  it("blocks instead of admitting unfinished profiles", () => {
    const plan = planGemsAutoScenario({ complexity: "easy", requiredContextTokens: 1 }, [profiles[3]!]);
    expect(plan).toMatchObject({ outcome: "blocked", reason: "NO_ELIGIBLE_NONPRODUCTION_PROFILE", mode: "simulation_only" });
  });
});
