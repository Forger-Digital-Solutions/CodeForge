import { describe, expect, it } from "vitest";
import { scheduleWorkstreams, validateEngineeringPlan } from "../src/parallel-workstreams.js";

describe("Parallel workstream planning and bounded scheduling (CF-08)", () => {
  const plan = {
    id: "plan-1", goal: "parallel work", workstreams: [
      { id: "contract", title: "Contract", objective: "Publish contract", dependencies: [], expectedFiles: ["src/contract.ts"] },
      { id: "api", title: "API", objective: "Implement API", dependencies: ["contract"], expectedFiles: ["src/api.ts"] },
      { id: "ui", title: "UI", objective: "Implement UI", dependencies: ["contract"], expectedFiles: ["src/ui.ts"] },
    ],
  };

  it("rejects duplicate ownership, missing dependencies, and cycles", () => {
    expect(validateEngineeringPlan({ ...plan, workstreams: [...plan.workstreams, { id: "duplicate", title: "Duplicate", objective: "Bad", dependencies: [], expectedFiles: ["src/api.ts"] }] }).valid).toBe(false);
    expect(validateEngineeringPlan({ ...plan, workstreams: [{ ...plan.workstreams[0]!, dependencies: ["missing"] }] }).valid).toBe(false);
    expect(validateEngineeringPlan({ ...plan, workstreams: [{ ...plan.workstreams[0]!, dependencies: ["api"] }, ...plan.workstreams.slice(1)] }).valid).toBe(false);
  });

  it("waits for dependencies and never exceeds the configured writer ceiling", async () => {
    let active = 0;
    let observedMax = 0;
    const started: string[] = [];
    const completed = new Set<string>();
    const results = await scheduleWorkstreams({
      plan,
      budget: { maxParallelWorkstreams: 2, maxActiveCoders: 2, maxActiveReviewers: 1, maxTotalWorkstreams: 6, maxSynthesisRounds: 1, maxConflictRepairRounds: 2 },
      execute: async (workstream) => {
        if (workstream.id !== "contract") expect(completed.has("contract")).toBe(true);
        started.push(workstream.id); active++; observedMax = Math.max(observedMax, active);
        await Promise.resolve();
        active--; completed.add(workstream.id);
        return { status: "completed" as const };
      },
      isSuccessful: (result) => result.status === "completed",
    });
    expect(results.size).toBe(3);
    expect(started[0]).toBe("contract");
    expect(observedMax).toBeLessThanOrEqual(2);
  });
});
