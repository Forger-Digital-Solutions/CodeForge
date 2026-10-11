import { describe, expect, it } from "vitest";
import { routeForgeAaaTask, type ForgeAaaRouteCandidate } from "../src/index.js";

function candidate(over: Partial<ForgeAaaRouteCandidate> = {}): ForgeAaaRouteCandidate {
  return {
    modelId: "m1",
    providerId: "groq",
    providerModelId: "m1",
    domain: "managed_free",
    lifecycle: "ACTIVE",
    available: true,
    qualifiedRoles: ["CODER"],
    costClass: "free",
    privateCodeAllowed: true,
    ...over,
  };
}

describe("ForgeAAA capability router", () => {
  it("routes a modeling task as CODER with free domain first", () => {
    const decision = routeForgeAaaTask({
      taskId: "t1", specialty: "forge-modeler",
      candidates: [
        candidate({ modelId: "paid-model", domain: "managed_paid", costClass: "paid", providerId: "paid-auto" }),
        candidate({ modelId: "free-model" }),
      ],
    });
    expect(decision.outcome).toBe("selected");
    expect(decision.role).toBe("CODER");
    expect(decision.selected?.modelId).toBe("free-model");
    expect(decision.ordered.map((c) => c.modelId)).toEqual(["free-model", "paid-model"]);
  });

  it("routes verify tasks to REVIEWER-role candidates", () => {
    const decision = routeForgeAaaTask({
      taskId: "t2", specialty: "forge-verify",
      candidates: [
        candidate({ modelId: "coder-only", qualifiedRoles: ["CODER"] }),
        candidate({ modelId: "reviewer", qualifiedRoles: ["REVIEWER"] }),
      ],
    });
    expect(decision.selected?.modelId).toBe("reviewer");
    expect(decision.reasonCodes).toContain("EXCLUDED_ROLE:coder-only");
  });

  it("excludes non-private-code routes for private project content", () => {
    const decision = routeForgeAaaTask({
      taskId: "t3", specialty: "forge-gameplay", privateCode: true,
      candidates: [
        candidate({ modelId: "no-privacy", privateCodeAllowed: false }),
        candidate({ modelId: "private-ok" }),
      ],
    });
    expect(decision.selected?.modelId).toBe("private-ok");
    expect(decision.reasonCodes).toContain("EXCLUDED_PRIVACY:no-privacy");
  });

  it("prefers an independent route for review tasks without banning same-pool fallback", () => {
    const impl = candidate({ modelId: "impl-route", providerId: "groq", providerModelId: "impl" });
    const indep = candidate({ modelId: "indep-route", providerId: "cerebras", providerModelId: "indep" });
    const decision = routeForgeAaaTask({
      taskId: "t4", specialty: "forge-verify",
      candidates: [impl, indep].map((c) => ({ ...c, qualifiedRoles: ["REVIEWER"] })),
      preferIndependentFrom: "groq/impl",
    });
    expect(decision.selected?.providerModelId).toBe("indep");
    expect(decision.reasonCodes).toContain("INDEPENDENT_POOL_PREFERRED");
    expect(decision.ordered).toHaveLength(2);
  });

  it("reports no_eligible_route honestly", () => {
    const decision = routeForgeAaaTask({ taskId: "t5", specialty: "forge-audio", candidates: [candidate({ available: false })] });
    expect(decision.outcome).toBe("no_eligible_route");
    expect(decision.selected).toBeUndefined();
  });

  it("unknown specialty is a distinct outcome", () => {
    const decision = routeForgeAaaTask({ taskId: "t6", specialty: "nope" as never, candidates: [] });
    expect(decision.outcome).toBe("specialty_unknown");
  });
});
