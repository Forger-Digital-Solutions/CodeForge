import { describe, expect, it } from "vitest";
import {
  PAID_AUTO_MODELS,
  PaidAutoService,
  type PaidAutoRouteId,
  type PaidRoleVerdict,
} from "../src/index.js";

const credentials = {
  get: () => "test-key",
  set: () => undefined,
  delete: () => true,
  has: () => true,
};

function qualifiedRoutes(): Partial<Record<PaidAutoRouteId, { state: "READY"; commercialEligibility: "verified"; privacy: "verified"; capabilityParity: "verified"; certification: "CERTIFIED" }>> {
  return Object.fromEntries(PAID_AUTO_MODELS.flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, {
    state: "READY",
    commercialEligibility: "verified",
    privacy: "verified",
    capabilityParity: "verified",
    certification: "CERTIFIED",
  }])) as never;
}

const NOW = Date.parse("2026-10-01T00:00:00.000Z");

function verdict(model: string, role: string, status: PaidRoleVerdict["status"], measuredAt = "2026-09-30T00:00:00.000Z"): PaidRoleVerdict {
  return { canonicalModelId: model as PaidRoleVerdict["canonicalModelId"], role, status, measuredAt, source: "test" };
}

function service(verdicts: readonly PaidRoleVerdict[], extra: Record<string, unknown> = {}): PaidAutoService {
  return new PaidAutoService({
    credentialStore: credentials,
    paidExecutionEnabled: true,
    openRouterFallbackEnabled: true,
    routeQualifications: qualifiedRoutes(),
    roleVerdicts: verdicts,
    now: () => NOW,
    ...extra,
  });
}

describe("R48 — per-role 16-Bit route selection", () => {
  it("ranks admissible candidates by expected cost inside the qualification tier", () => {
    const allCoder = PAID_AUTO_MODELS.map((m) => verdict(m.canonicalModelId, "CODER", "QUALIFIED"));
    const selection = service(allCoder).selectRoleRoute({ role: "coder" });
    expect(selection.outcome).toBe("selected");
    // Cheapest CURRENT-priced route wins when every model is qualified — qwen before glm before gpt.
    expect(selection.orderedCandidates.map((c) => c.canonicalModelId)).toEqual(["qwen3.8-flash", "glm-5.3-flash", "gpt-5.6-luna"]);
    expect(selection.selected?.route.routeId).toBe("qwen3.8-flash:direct");
  });

  it("fails closed with no_qualified_role_route when every model is measured-failed for the role", () => {
    const allExplorerFailed = PAID_AUTO_MODELS.map((m) => verdict(m.canonicalModelId, "EXPLORER", "NOT_QUALIFIED"));
    const selection = service(allExplorerFailed).selectRoleRoute({ role: "explorer" });
    expect(selection.outcome).toBe("no_qualified_role_route");
    expect(selection.selected).toBeUndefined();
    expect(selection.orderedCandidates).toHaveLength(0);
    expect(selection.ranking.selectionStatus).toBe("NO_QUALIFIED_ROLE_ROUTE");
  });

  it("an unmeasured model never price-outranks a measured QUALIFIED peer", () => {
    // qwen is the cheapest route but has no EXPLORER verdict; glm is measured QUALIFIED.
    const selection = service([verdict("glm-5.3-flash", "EXPLORER", "QUALIFIED")]).selectRoleRoute({ role: "explorer" });
    expect(selection.outcome).toBe("selected");
    expect(selection.selected?.canonicalModelId).toBe("glm-5.3-flash");
    expect(selection.orderedCandidates.map((c) => c.canonicalModelId)[0]).toBe("glm-5.3-flash");
  });

  it("a PROBATION verdict outranks unmeasured supply but not QUALIFIED", () => {
    const verdicts = [
      verdict("gpt-5.6-luna", "REVIEWER", "PROBATION"),
      verdict("glm-5.3-flash", "REVIEWER", "QUALIFIED"),
    ];
    const selection = service(verdicts).selectRoleRoute({ role: "reviewer" });
    expect(selection.orderedCandidates.map((c) => c.canonicalModelId)).toEqual(["glm-5.3-flash", "gpt-5.6-luna", "qwen3.8-flash"]);
  });

  it("stale verdicts revert to unmeasured — expired qualification cannot keep a floor seat", () => {
    const stale = verdict("glm-5.3-flash", "REVIEWER", "QUALIFIED", "2026-08-01T00:00:00.000Z");
    const selection = service([stale]).selectRoleRoute({ role: "reviewer" });
    // glm's stale verdict does not hold tier 0 — price resumes ranking the unmeasured field.
    expect(selection.selected?.canonicalModelId).toBe("qwen3.8-flash");
  });

  it("distinguishes no_executable_route from a qualification failure", () => {
    const verdicts = PAID_AUTO_MODELS.map((m) => verdict(m.canonicalModelId, "CODER", "QUALIFIED"));
    const disabled = service(verdicts, { paidExecutionEnabled: false });
    const selection = disabled.selectRoleRoute({ role: "coder" });
    expect(selection.outcome).toBe("no_executable_route");
    expect(selection.selected).toBeUndefined();
  });

  it("skips a candidate whose routes are all closed and serves the next admissible one", () => {
    // Cheapest model's routes both unqualified at the gate level → next qualified wins.
    const routes = qualifiedRoutes();
    for (const routeId of ["qwen3.8-flash:direct", "qwen3.8-flash:openrouter"] as PaidAutoRouteId[]) {
      routes[routeId] = { ...routes[routeId]!, certification: "NOT_CERTIFIED" } as never;
    }
    const verdicts = PAID_AUTO_MODELS.map((m) => verdict(m.canonicalModelId, "CODER", "QUALIFIED"));
    const selection = service(verdicts, { routeQualifications: routes }).selectRoleRoute({ role: "coder" });
    expect(selection.selected?.canonicalModelId).toBe("glm-5.3-flash");
    expect(selection.orderedCandidates.map((c) => c.canonicalModelId)).not.toContain("qwen3.8-flash");
  });

  it("resolves the OpenRouter fallback when only direct credentials are absent", () => {
    const routes = qualifiedRoutes();
    routes["deepseek-v4.1-flash:direct"] = { ...routes["deepseek-v4.1-flash:direct"]!, state: "NOT_CONFIGURED" } as never;
    const selection = service([verdict("deepseek-v4.1-flash", "CODER", "QUALIFIED")], {
      routeQualifications: routes,
    }).selectRoleRoute({
      role: "coder",
      // DeepSeek's direct route is price-UNKNOWN; the fallback carries its live card.
      priceOverrides: { "deepseek-v4.1-flash": { inputCostPerMillion: 0.07, outputCostPerMillion: 0.17, source: "test-openrouter-card" } },
    });
    expect(selection.selected?.canonicalModelId).toBe("deepseek-v4.1-flash");
    expect(selection.selected?.route.kind).toBe("openrouter");
  });
});
