import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { ProviderCapacityGovernor, rateLimitScopeFor } from "@codeforge/providers";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter } from "../src/router.js";
import { EightBitDecisionStore } from "../src/persistence.js";
import { EightBitFailoverCoordinator, type FailoverRequest } from "../src/failover.js";
import { makeModel } from "./fixtures.js";

// R56 live evidence (roster-live-run-blocked-tpd.json): Groq's TPD wall is model-scoped —
// the 429 names `openai/gpt-oss-120b` while `openai/gpt-oss-20b` still has budget. The
// route-scoped failure used to be projected provider-wide (applyToFirewall →
// markProviderHealth) and the governor cooled the whole provider, so the sibling that could
// have completed the task was excluded by both layers at once.
const GROQ_TPD_429 = "groq error (429): {\"error\":{\"message\":\"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199005\"}}";

let fw: ForgeZero;
let health: EightBitHealthTracker;
let router: EightBitRouter;
let store: EightBitDecisionStore;
let coordinator: EightBitFailoverCoordinator;
let persistence: ISessionPersistence;

beforeEach(async () => {
  fw = new ForgeZero();
  health = new EightBitHealthTracker(fw);
  router = new EightBitRouter(fw, health, new EightBitReliabilityTracker());
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  store = new EightBitDecisionStore(persistence);
  coordinator = new EightBitFailoverCoordinator(health, router, store);
});

const baseReq: Omit<FailoverRequest, "error" | "current"> = {
  sessionId: "s1",
  turnId: "t1",
  role: "EXPLORER",
  isExactPin: false,
  policyMode: "adaptive",
  hasAdapter: () => true,
};

describe("R56 — model-scoped failure marking (within-provider failover)", () => {
  it("[PASS] a model-bucket daily 429 rotates to the SAME provider's sibling route", async () => {
    fw.register(makeModel({ providerId: "groq", modelId: "openai/gpt-oss-120b", codingScore: 95 }));
    fw.register(makeModel({ providerId: "groq", modelId: "openai/gpt-oss-20b", codingScore: 60 }));
    const outcome = await coordinator.handleFailure({
      ...baseReq,
      current: { providerId: "groq", modelId: "openai/gpt-oss-120b" },
      error: new Error(GROQ_TPD_429),
    });
    // 20b is the legal replacement: same provider, unaffected daily bucket.
    expect(outcome.action).toBe("rotate");
    if (outcome.action === "rotate") {
      expect(outcome.replacement).toEqual({ providerId: "groq", modelId: "openai/gpt-oss-20b" });
      expect(outcome.receipt.reasonCodes).toContain("RATE_LIMITED");
    }
    // The firewall marks only the exhausted model — the sibling stays eligible.
    const eligible = fw.eligibleModels().map((m) => m.modelId);
    expect(eligible).toContain("openai/gpt-oss-20b");
    expect(eligible).not.toContain("openai/gpt-oss-120b");
    // And the mark holds until the daily reset, not a fake 30s cooldown.
    const marked = fw.getModel("groq", "openai/gpt-oss-120b");
    expect(marked?.health?.status).toBe("rate_limited");
    expect(marked?.health?.retryAfter).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });

  it("[PASS] an account-scoped quota wall still marks every sibling (provider scope preserved)", async () => {
    fw.register(makeModel({ providerId: "openrouter", modelId: "a:free" }));
    fw.register(makeModel({ providerId: "openrouter", modelId: "b:free" }));
    const outcome = await coordinator.handleFailure({
      ...baseReq,
      current: { providerId: "openrouter", modelId: "a:free" },
      error: new Error("429 Too Many Requests: free-models-per-day limit exceeded for this account"),
    });
    expect(outcome.action).toBe("no_replacement");
    expect(fw.eligibleModels().filter((m) => m.providerId === "openrouter")).toHaveLength(0);
  });

  it("[PASS] an auth failure marks provider-scoped (the credential is organization-wide)", async () => {
    fw.register(makeModel({ providerId: "groq", modelId: "m1" }));
    fw.register(makeModel({ providerId: "groq", modelId: "m2" }));
    health.recordFailure("groq", "m1", "AUTH_FAILURE");
    expect(fw.getModel("groq", "m1")?.health?.status).toBe("auth_required");
    expect(fw.getModel("groq", "m2")?.health?.status).toBe("auth_required");
  });

  it("[PASS] a sibling's success does not clear an exhausted route's mark", () => {
    fw.register(makeModel({ providerId: "groq", modelId: "hot" }));
    fw.register(makeModel({ providerId: "groq", modelId: "cold" }));
    health.recordFailure("groq", "hot", "QUOTA_EXHAUSTED");
    expect(fw.getModel("groq", "hot")?.health?.status).toBe("quota_exhausted");
    health.recordSuccess("groq", "cold");
    expect(fw.getModel("groq", "cold")?.health?.status).toBe("available");
    expect(fw.getModel("groq", "hot")?.health?.status).toBe("quota_exhausted");
  });

  it("[PASS] hydrated pre-scope records derive scope from their failure reason", () => {
    fw.register(makeModel({ providerId: "groq", modelId: "old-a" }));
    fw.register(makeModel({ providerId: "groq", modelId: "old-b" }));
    health.hydrate({ providerId: "groq", modelId: "old-a", consecutiveFailures: 1, lastFailureReason: "RATE_LIMITED", status: "RATE_LIMITED", cooldownUntil: Date.now() + 60_000 });
    expect(fw.getModel("groq", "old-a")?.health?.status).toBe("rate_limited");
    expect(fw.getModel("groq", "old-b")?.health?.status).toBe("available");
    health.hydrate({ providerId: "groq", modelId: "old-a", consecutiveFailures: 3, lastFailureReason: "AUTH_FAILURE", status: "SUSPENDED" });
    expect(fw.getModel("groq", "old-b")?.health?.status).toBe("auth_required");
  });
});

describe("R56 — governor model-scoped cooldown", () => {
  it("[PASS] rateLimitScopeFor follows the provider's own bucket evidence", () => {
    expect(rateLimitScopeFor(GROQ_TPD_429)).toBe("model");
    expect(rateLimitScopeFor("429 rate limit reached on tokens per minute (TPM)")).toBe("model");
    expect(rateLimitScopeFor("429 free-models-per-day limit exceeded")).toBe("provider");
    expect(rateLimitScopeFor("429 insufficient_quota: account credit balance exhausted")).toBe("provider");
    expect(rateLimitScopeFor("429")).toBe("provider");
  });

  it("[PASS] a model-scoped cooldown never gates the sibling's dispatch", async () => {
    const governor = new ProviderCapacityGovernor();
    // Past the governor's 60s wait horizon so the cooled model rejects instead of sleeping.
    const until = Date.now() + 120_000;
    governor.recordRateLimit("groq", until, { modelId: "openai/gpt-oss-120b", scope: "model" });
    expect(governor.isCoolingDown("groq", "openai/gpt-oss-120b")).toBe(true);
    expect(governor.isCoolingDown("groq", "openai/gpt-oss-20b")).toBe(false);
    expect(governor.isCoolingDown("groq")).toBe(false);
    await expect(governor.acquire("groq", 500, undefined, { modelId: "openai/gpt-oss-20b" })).resolves.toBeDefined();
    await expect(governor.acquire("groq", 500, undefined, { modelId: "openai/gpt-oss-120b" })).rejects.toThrow(/RATE_LIMITED/);
  });

  it("[PASS] a provider-scoped cooldown still gates every model", async () => {
    const governor = new ProviderCapacityGovernor();
    governor.recordRateLimit("groq", Date.now() + 120_000, { scope: "provider" });
    expect(governor.isCoolingDown("groq", "openai/gpt-oss-20b")).toBe(true);
    await expect(governor.acquire("groq", 500, undefined, { modelId: "openai/gpt-oss-20b" })).rejects.toThrow(/RATE_LIMITED/);
  });
});
