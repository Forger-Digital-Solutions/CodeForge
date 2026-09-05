import { describe, expect, it, vi } from "vitest";
import {
  ForgeGreenAdvisor,
  asEfficiencyScore,
  type ContextCacheIdentity,
} from "../src/index.js";

function identity(overrides: Partial<ContextCacheIdentity> = {}): ContextCacheIdentity {
  return {
    workspaceId: "workspace-a",
    repositoryGeneration: 3,
    taskIdentity: "task-a",
    agentRole: "coder",
    retrievalPolicyVersion: "policy-1",
    contextBudget: 16_000,
    featureVersion: "feature-1",
    authorityState: "approval-a",
    ...overrides,
  };
}

describe("ForgeGreen advisor safety contract", () => {
  it("reuses context only for an exact identity and rejects stale generations by key", () => {
    const advisor = new ForgeGreenAdvisor();
    advisor.putContext(identity(), { value: "safe" });
    expect(advisor.getContext(identity())).toEqual({ value: "safe" });
    expect(advisor.getContext(identity({ repositoryGeneration: 4 }))).toBeUndefined();
    expect(advisor.getContext(identity({ taskIdentity: "task-b" }))).toBeUndefined();
    expect(advisor.getContext(identity({ authorityState: "approval-b" }))).toBeUndefined();
  });

  it("keeps verification recommendations candidate-only", () => {
    const advisor = new ForgeGreenAdvisor();
    const recommendation = advisor.recommendVerification({
      changedPaths: ["src/auth.ts"],
      candidateTests: ["test/auth.test.ts"],
    });
    expect(recommendation.completeness).toBe("candidate-only");
    expect(recommendation.candidateTests).toEqual(["test/auth.test.ts"]);
    expect(recommendation).not.toHaveProperty("approved");
    expect(recommendation).not.toHaveProperty("completed");
  });

  it("falls back safely when analysis is unavailable or disabled", () => {
    const unavailable = new ForgeGreenAdvisor().recommendVerification({ changedPaths: ["src/a.ts"], analysisAvailable: false });
    expect(unavailable.reasonCodes).toEqual(["analysis_unavailable", "safe_fallback"]);
    expect(unavailable.completeness).toBe("unknown");

    const disabledAdvisor = new ForgeGreenAdvisor({ enabled: false });
    const disabled = disabledAdvisor.recommendVerification({ changedPaths: ["src/a.ts"] });
    expect(disabled.reasonCodes).toEqual(["forgegreen_disabled", "safe_fallback"]);
  });

  it("does not treat prompt-injection text as an optimization signal", () => {
    const advisor = new ForgeGreenAdvisor();
    const recommendation = advisor.recommendVerification({
      changedPaths: ["README.md"],
      candidateTests: [],
      analysisAvailable: true,
    });
    expect(recommendation.completeness).toBe("candidate-only");
    expect(recommendation.rationale.join(" ")).not.toMatch(/skip|complete|permission/i);
  });

  it("deduplicates only identical authority-scoped requests and never caches failures", async () => {
    const advisor = new ForgeGreenAdvisor();
    const operation = vi.fn(async () => "result");
    const first = await advisor.runDeduplicated("request:approval-a", operation);
    const second = await advisor.runDeduplicated("request:approval-a", operation);
    const distinct = await advisor.runDeduplicated("request:approval-b", operation);
    expect(first.suppressed).toBe(false);
    expect(second.suppressed).toBe(true);
    expect(distinct.suppressed).toBe(false);
    expect(operation).toHaveBeenCalledTimes(2);

    const fail = vi.fn(async () => { throw new Error("transient"); });
    await expect(advisor.runDeduplicated("failure", fail)).rejects.toThrow("transient");
    await expect(advisor.runDeduplicated("failure", fail)).rejects.toThrow("transient");
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("reports provider prompt accounting as unavailable instead of inventing cache hits", () => {
    const advisor = new ForgeGreenAdvisor();
    expect(advisor.observeStablePrefix("provider", "model", "stable")).toBe(false);
    expect(advisor.observeStablePrefix("provider", "model", "stable")).toBe(true);
    const receipt = advisor.createReceipt({ workspaceId: "workspace-a", repositoryGeneration: 1 });
    expect(receipt.promptCacheAccounting).toBe("unavailable");
    expect(receipt.promptPrefixCacheHits).toBe(1);
  });

  it("lets cancellation interrupt a deduplicated wait", async () => {
    const advisor = new ForgeGreenAdvisor();
    let resolveOperation: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => { resolveOperation = resolve; });
    const first = advisor.runDeduplicated("slow", () => pending);
    const controller = new AbortController();
    const second = advisor.runDeduplicated("slow", () => Promise.resolve("wrong"), controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow("cancelled");
    resolveOperation?.("done");
    await expect(first).resolves.toMatchObject({ value: "done", suppressed: false });
  });

  it("keeps advisor scores branded at the type boundary", () => {
    const score = asEfficiencyScore(0.5);
    expect(score).toBe(0.5);
  });
});
