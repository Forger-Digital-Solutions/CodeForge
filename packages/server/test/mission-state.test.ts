import { describe, expect, it } from "vitest";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  DEFAULT_MISSION_BUDGET, MISSION_ERRORS, MISSION_MEMORY_LIMITS, MissionStore,
  checkMissionBudget, compactMissionMemory, diffMissionPlans, emptyMissionMemory, emptyMissionUsage,
  markMemoryStaleness, missionIntentDigest, replanFingerprint, unprovenMandatoryCriteria,
  validateMilestoneRoadmap, verifyMissionIntent,
  type AutonomousMission, type MissionIntent, type MissionMilestone,
} from "../src/mission-state.js";

function milestone(id: string, overrides: Partial<MissionMilestone> = {}): MissionMilestone {
  return { id, title: id, objective: `objective ${id}`, dependencies: [], acceptanceCriteria: [], status: "pending", planVersion: 1, waveIds: [], evidence: [], ...overrides };
}

function intent(overrides: Partial<Omit<MissionIntent, "digest">> = {}): MissionIntent {
  const seed = { version: 1, goal: "ship flags", acceptanceCriteriaIds: ["AC-1"], explicitExclusions: [], securityConstraints: [], initialUserInstructions: "ship flags", authorizedBy: "user" as const, createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
  return { ...seed, digest: missionIntentDigest(seed) };
}

function mission(overrides: Partial<AutonomousMission> = {}): AutonomousMission {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    kind: "mission", id: "mission-1", sessionId: "s1", workspaceId: "ws", originalGoal: "ship flags", baseRevision: "base",
    intent: intent(), intentHistory: [], acceptanceCriteria: [], constraints: [], status: "executing",
    currentPlanVersion: 1, currentWave: 0, planVersions: [], milestones: [], assumptions: [], waves: [], steering: [],
    budget: { ...DEFAULT_MISSION_BUDGET }, usage: emptyMissionUsage(), evidence: [], memory: emptyMissionMemory(), driftHandledRevisions: [],
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("CF-09 mission intent is immutable and tamper-evident", () => {
  it("detects any rewrite of the authorized goal, criteria, or constraints", () => {
    const authorized = intent();
    expect(verifyMissionIntent(authorized)).toBe(true);
    expect(verifyMissionIntent({ ...authorized, goal: "a different objective" })).toBe(false);
    expect(verifyMissionIntent({ ...authorized, acceptanceCriteriaIds: ["AC-1", "AC-99"] })).toBe(false);
    expect(verifyMissionIntent({ ...authorized, explicitExclusions: ["skip security"] })).toBe(false);
    // Criterion ordering is not semantic, so a reordering is still the same authorized intent.
    expect(verifyMissionIntent(intent({ acceptanceCriteriaIds: ["AC-1"] }))).toBe(true);
  });
});

describe("CF-09 milestone roadmap validation", () => {
  const criteria = ["AC-1", "AC-2"];
  it("accepts a dependency-ordered roadmap and returns a deterministic order", () => {
    const validation = validateMilestoneRoadmap([
      milestone("b", { dependencies: ["a"], acceptanceCriteria: ["AC-2"] }),
      milestone("a", { acceptanceCriteria: ["AC-1"] }),
    ], DEFAULT_MISSION_BUDGET, criteria);
    expect(validation).toMatchObject({ valid: true, order: ["a", "b"] });
  });

  it("rejects cycles, unknown dependencies, duplicates, and unknown acceptance criteria", () => {
    expect(validateMilestoneRoadmap([milestone("a", { dependencies: ["b"] }), milestone("b", { dependencies: ["a"] })], DEFAULT_MISSION_BUDGET, criteria).valid).toBe(false);
    expect(validateMilestoneRoadmap([milestone("a", { dependencies: ["ghost"] })], DEFAULT_MISSION_BUDGET, criteria).valid).toBe(false);
    expect(validateMilestoneRoadmap([milestone("a"), milestone("a")], DEFAULT_MISSION_BUDGET, criteria).valid).toBe(false);
    // A planning role cannot invent an acceptance criterion by referencing one.
    const invented = validateMilestoneRoadmap([milestone("a", { acceptanceCriteria: ["AC-INVENTED"] })], DEFAULT_MISSION_BUDGET, criteria);
    expect(invented.valid).toBe(false);
    expect(invented.error).toContain("AC-INVENTED");
  });

  it("refuses a roadmap larger than the mission milestone ceiling", () => {
    const many = Array.from({ length: 4 }, (_, index) => milestone(`m${index}`));
    expect(validateMilestoneRoadmap(many, { ...DEFAULT_MISSION_BUDGET, maxMilestones: 3 }, criteria)).toMatchObject({ valid: false, error: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED });
  });
});

describe("CF-09 plan diff and replan fingerprints", () => {
  it("separates preserved, invalidated, added, and removed milestones", () => {
    const previous = [milestone("a", { status: "completed" }), milestone("b", { status: "blocked" }), milestone("c")];
    const next = [milestone("a", { status: "completed" }), milestone("b2"), milestone("c", { dependencies: ["b2"] })];
    const diff = diffMissionPlans(previous, next, { type: "verification_failure", verificationId: "node --test x" }, ["b"]);
    expect(diff.preservedMilestones).toEqual(["a"]);
    expect(diff.invalidatedMilestones).toEqual(["c"]);
    expect(diff.removedMilestones).toEqual(["b"]);
    expect(diff.addedMilestones).toEqual(["b2"]);
  });

  it("produces a stable fingerprint per trigger and roadmap shape", () => {
    const trigger = { type: "verification_failure", verificationId: "id", command: "node --test test/ui.test.mjs" } as const;
    const shape = [milestone("a"), milestone("b")];
    expect(replanFingerprint(trigger, shape)).toBe(replanFingerprint(trigger, [...shape].reverse()));
    expect(replanFingerprint(trigger, shape)).not.toBe(replanFingerprint(trigger, [milestone("a"), milestone("b", { objective: "different" })]));
    expect(replanFingerprint(trigger, shape)).not.toBe(replanFingerprint({ type: "review_block", findingIds: ["f1"] }, shape));
  });
});

describe("CF-09 mission memory stays bounded", () => {
  it("compacts to a hard byte ceiling no matter how much history accumulates", () => {
    let memory = emptyMissionMemory();
    memory.missionSummary = "x".repeat(5_000);
    for (let index = 0; index < 200; index++) {
      memory.milestoneSummaries.push({ milestoneId: `m${index}`, summary: "y".repeat(2_000), revision: `rev${index}`, contextRevision: `rev${index}` });
      memory.openRisks.push("risk ".repeat(200));
      memory.recentFailures.push("failure ".repeat(200));
      memory.keyContracts.push({ id: `c${index}`, revision: `r${index}`, summary: "z".repeat(1_000) });
      memory.evidenceRefs.push({ kind: "file", ref: `src/file-${index}.ts` });
      memory = compactMissionMemory(memory);
    }
    expect(Buffer.byteLength(JSON.stringify(memory), "utf8")).toBeLessThanOrEqual(MISSION_MEMORY_LIMITS.maxSerializedBytes);
    expect(memory.milestoneSummaries.length).toBeLessThanOrEqual(MISSION_MEMORY_LIMITS.maxMilestoneSummaries);
    expect(memory.openRisks.length).toBeLessThanOrEqual(MISSION_MEMORY_LIMITS.maxOpenRisks);
    expect(memory.compactions).toBe(200);
    // The most recent milestone is the one that survives compaction.
    expect(memory.milestoneSummaries.at(-1)?.milestoneId).toBe("m199");
  });

  it("marks summaries stale once the repository revision moves", () => {
    const memory = compactMissionMemory({ ...emptyMissionMemory(), milestoneSummaries: [{ milestoneId: "m1", summary: "done", revision: "rev1", contextRevision: "rev1" }] });
    expect(markMemoryStaleness(memory, "rev1").milestoneSummaries[0]!.stale).toBe(false);
    expect(markMemoryStaleness(memory, "rev2").milestoneSummaries[0]!.stale).toBe(true);
  });
});

describe("CF-09 aggregate mission budget", () => {
  it("warns before exhaustion and then fails closed on hard ceilings", () => {
    const nearly = mission({ budget: { ...DEFAULT_MISSION_BUDGET, maxWaves: 10 }, usage: { ...emptyMissionUsage(), waves: 9 } });
    expect(checkMissionBudget(nearly, "wave").ok).toBe(true);
    expect(checkMissionBudget(nearly, "wave").warnings.join()).toContain("waves:9/10");

    const outOfWaves = mission({ budget: { ...DEFAULT_MISSION_BUDGET, maxWaves: 2 }, usage: { ...emptyMissionUsage(), waves: 2 } });
    expect(checkMissionBudget(outOfWaves, "wave")).toMatchObject({ ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED });

    const outOfReplans = mission({ budget: { ...DEFAULT_MISSION_BUDGET, maxReplans: 1 }, usage: { ...emptyMissionUsage(), replans: 1 } });
    expect(checkMissionBudget(outOfReplans, "replan")).toMatchObject({ ok: false, code: MISSION_ERRORS.MISSION_REPLAN_LIMIT });

    // Aggregate ceilings stop every kind of new work, not just the one being requested.
    const outOfTurns = mission({ budget: { ...DEFAULT_MISSION_BUDGET, maxTotalAgentTurns: 5 }, usage: { ...emptyMissionUsage(), agentTurns: 5 } });
    expect(checkMissionBudget(outOfTurns, "wave")).toMatchObject({ ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED });
    expect(checkMissionBudget(outOfTurns, "replan")).toMatchObject({ ok: false, code: MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED });
  });
});

describe("CF-09 acceptance gating", () => {
  it("treats only proven or waived mandatory criteria as satisfied", () => {
    const gated = mission({ acceptanceCriteria: [
      { id: "AC-1", description: "one", mandatory: true, status: "proven", evidence: [], introducedInIntentVersion: 1 },
      { id: "AC-2", description: "two", mandatory: true, status: "partially_proven", evidence: [], introducedInIntentVersion: 1 },
      { id: "AC-3", description: "three", mandatory: false, status: "unproven", evidence: [], introducedInIntentVersion: 1 },
      { id: "AC-4", description: "four", mandatory: true, status: "waived", evidence: [], introducedInIntentVersion: 1 },
    ] });
    expect(unprovenMandatoryCriteria(gated).map((criterion) => criterion.id)).toEqual(["AC-2"]);
  });
});

describe("CF-09 mission persistence", () => {
  it("round-trips the full mission record through durable storage", () => {
    const persistence = createSessionPersistence();
    const now = new Date().toISOString();
    persistence.upsertSession({ id: "s1", title: "mission", createdAt: now, updatedAt: now, status: "running" });
    const store = new MissionStore(persistence);
    const saved = mission({
      createdAt: now, updatedAt: now, currentWave: 3, currentPlanVersion: 2,
      milestones: [milestone("a", { status: "completed", resultRevision: "rev-a", checkpointId: "cp-a" })],
      acceptanceCriteria: [{ id: "AC-1", description: "one", mandatory: true, status: "proven", evidence: [{ kind: "revision", ref: "rev-a" }], introducedInIntentVersion: 1 }],
      assumptions: [{ id: "as-1", statement: "settings owns state", status: "invalidated", evidence: [], declaredInPlanVersion: 1, updatedBy: "runtime" }],
      usage: { ...emptyMissionUsage(), waves: 3, replans: 1 },
    });
    store.save(saved);
    const loaded = store.get("mission-1")!;
    expect(loaded.currentWave).toBe(3);
    expect(loaded.milestones[0]).toMatchObject({ id: "a", status: "completed", resultRevision: "rev-a", checkpointId: "cp-a" });
    expect(loaded.acceptanceCriteria[0]?.status).toBe("proven");
    expect(loaded.assumptions[0]?.status).toBe("invalidated");
    expect(loaded.usage.replans).toBe(1);
    expect(verifyMissionIntent(loaded.intent)).toBe(true);
    expect(store.list("s1").map((entry) => entry.id)).toEqual(["mission-1"]);
    persistence.close();
  });
});
