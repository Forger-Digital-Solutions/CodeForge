import { describe, expect, it, beforeEach } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { ModelQualificationReceipt } from "../src/qualification/types.js";
import {
  createRosterRevisionStore,
  createRosterChurnManager,
  type RosterChurnManager,
} from "../src/roster-revision.js";

function makeModel(overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId: "groq",
    modelId: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    tier: "free",
    accessClass: "FREE_NATIVE",
    authMode: "no_auth",
    privacyClass: "public",
    family: "llama",
    upstreamSource: "groq",
    deprecated: false,
    contextWindow: 128000,
    maxOutput: 4096,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date().toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "groq",
    },
    benchmarkProfile: { coding: 85, reasoning: 80, speed: 90, toolCalling: 85 },
    health: { status: "healthy", consecutiveSuccesses: 10, recentFailureCount: 0, lastCheckAt: new Date().toISOString() },
    ...overrides,
  };
}

function makeReceipt(model: FreeModelRecord, state: "QUALIFIED" | "NOT_QUALIFIED" = "QUALIFIED"): ModelQualificationReceipt {
  return {
    suiteVersion: "R10_FREE_QUALIFICATION_V1",
    providerId: model.providerId,
    modelId: model.modelId,
    modelDisplayName: model.displayName,
    accessClass: "FREE_NATIVE",
    freeStatus: "verified_free",
    roleResults: {
      CODER: {
        role: "CODER",
        status: state === "QUALIFIED" ? "QUALIFIED" : "NOT_QUALIFIED",
        testCases: [],
        hardFailures: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalLatencyMs: 150,
    qualificationState: state,
    hardFailureRoles: [],
  };
}

describe("8-Bit Roster Revision and Churn Management", () => {
  let persistence: ISessionPersistence;
  let manager: RosterChurnManager;

  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    const store = createRosterRevisionStore(persistence);
    manager = createRosterChurnManager(store);
    await manager.init();
  });

  it("discovery creates candidate only, never qualified directly (§27)", () => {
    const candidate = makeModel({ modelId: "candidate-model-1" });
    const reg = manager.registerCandidate(candidate);
    expect(reg.candidate).toBe(true);

    // Active roster does NOT contain candidate
    const active = manager.getActiveRoster();
    expect(active.find(e => e.modelId === "candidate-model-1")).toBeUndefined();

    // Stored as candidate
    expect(manager.getCandidate("groq", "candidate-model-1")).toBeDefined();
  });

  it("policy authority ALWAYS wins (§28): policy denial blocks qualification even for high benchmark", async () => {
    const candidate = makeModel({ modelId: "benchmark-champ" });
    const receipt = makeReceipt(candidate, "QUALIFIED");

    // Policy denies (e.g. legal terms change, embargoed provider)
    const outcome = await manager.promoteModel(
      candidate,
      receipt,
      { allowed: false, reason: "terms_of_service_restricted" },
    );

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("POLICY_DENIED");
    const active = manager.getActiveRoster();
    expect(active.find(e => e.modelId === "benchmark-champ")).toBeUndefined();
  });

  it("policy expiration blocks route even if health remains healthy (§64)", async () => {
    const model = makeModel({ modelId: "healthy-model" });
    const receipt = makeReceipt(model, "QUALIFIED");
    await manager.promoteModel(model, receipt, { allowed: true });
    expect(manager.getActiveRoster().find(e => e.modelId === "healthy-model")).toBeDefined();

    // Policy expires
    const newRev = await manager.expirePolicy("groq", "healthy-model", ["quarterly_policy_recheck_expired"]);
    expect(newRev.changes[0]!.action).toBe("POLICY_EXPIRED");
    expect(newRev.changes[0]!.reasonCodes).toContain("quarterly_policy_recheck_expired");

    // Model is blocked/excluded
    const active = manager.getActiveRoster();
    expect(active.find(e => e.modelId === "healthy-model")).toBeUndefined();
  });

  it("simulates full roster churn: Model A retired -> Model B candidate promoted (§63)", async () => {
    // 1. Initial: Model A is qualified and in active roster
    const modelA = makeModel({ providerId: "groq", modelId: "model-a", displayName: "Model A" });
    const receiptA = makeReceipt(modelA, "QUALIFIED");
    const rev1 = await manager.promoteModel(modelA, receiptA, { allowed: true });
    expect(rev1.success).toBe(true);
    expect(manager.getActiveRoster().map(e => e.modelId)).toContain("model-a");

    const revNumAfterA = manager.getCurrentRevision().revisionNumber;

    // 2. Model A is retired (e.g. provider drops free tier)
    const rev2 = await manager.retireModel("groq", "model-a", ["free_eligibility_ended"]);
    expect(rev2.revisionNumber).toBe(revNumAfterA + 1);
    expect(rev2.changes[0]!.action).toBe("RETIRED");
    expect(rev2.changes[0]!.reasonCodes).toContain("free_eligibility_ended");
    expect(manager.getActiveRoster().find(e => e.modelId === "model-a")).toBeUndefined();

    // 3. Model B discovered as candidate
    const modelB = makeModel({ providerId: "cloudflare", modelId: "model-b", displayName: "Model B" });
    manager.registerCandidate(modelB);
    expect(manager.getActiveRoster().find(e => e.modelId === "model-b")).toBeUndefined();

    // 4. Model B qualifies and is promoted
    const receiptB = makeReceipt(modelB, "QUALIFIED");
    const rev3 = await manager.promoteModel(modelB, receiptB, { allowed: true }, ["CODER"]);
    expect(rev3.success).toBe(true);
    expect(rev3.newRevision!.revisionNumber).toBe(revNumAfterA + 2);
    expect(manager.getActiveRoster().map(e => e.modelId)).toContain("model-b");
    expect(manager.getActiveRoster().map(e => e.modelId)).not.toContain("model-a");
  });

  it("persists revisions durably across restart", async () => {
    const model = makeModel({ modelId: "persistent-model" });
    await manager.promoteModel(model, makeReceipt(model, "QUALIFIED"), { allowed: true });
    const currentRev = manager.getCurrentRevision();

    // Create fresh manager with same persistence
    const store2 = createRosterRevisionStore(persistence);
    const manager2 = createRosterChurnManager(store2);
    await manager2.init();

    expect(manager2.getCurrentRevision().revisionNumber).toBe(currentRev.revisionNumber);
    expect(manager2.getActiveRoster().map(e => e.modelId)).toContain("persistent-model");
  });
});