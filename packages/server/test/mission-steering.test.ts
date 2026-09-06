import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ONE_TEST, SMALL_CRITERIA, SMALL_IMPL, SMALL_REPO, TWO_TEST, createHarness, createRepo, reviewerPass,
  scriptFromSpec, smallMilestones, type MilestoneSpec, type MissionHarness,
} from "./helpers/mission-fixture.js";
import { MISSION_ERRORS, verifyMissionIntent } from "../src/mission-state.js";

const GOAL = "Implement the first and second modules";
const SESSION = "cf09-steering";

/** Plan v2 keeps the certified first milestone and rewrites only the pending second one. */
const STEERED_SECOND: MilestoneSpec = {
  id: "s-two-steered", title: "Second (steered)", objective: "Implement the second module using the existing module one helper",
  dependencies: ["s-one"], acceptanceCriteria: ["AC-2"], verificationCommands: [TWO_TEST],
  workstreams: [{ id: "two-steered", objective: "Implement src/two.mjs through the existing helper", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.two }],
};
const FIRST = smallMilestones()[0]!;

describe("CF-09 human steering is durable and authoritative", () => {
  let repoDir: string; let worktreeDir: string; let harness: MissionHarness;

  beforeEach(async () => {
    repoDir = await createRepo(SMALL_REPO, "cf09-steer-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-steer-wt-"));
  });

  afterEach(async () => {
    await harness?.persistence.close();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("turns a user clarification into a bounded replan that preserves completed work", async () => {
    let missionId = "";
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: (context) => {
        const base = scriptFromSpec({
          missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
          plans: [{ milestones: smallMilestones() }, { milestones: [FIRST, STEERED_SECOND] }],
          reviewer: () => reviewerPass(),
        });
        // Trusted steering arrives right after the first milestone is certified.
        if (context.role === "reviewer" && context.goalHint.includes("Review synthesized implementation") && context.all.includes("mission milestone s-one")) {
          queueMicrotask(() => harness.supervisor.steerMission(missionId, { type: "clarification", message: "Do not create a new persistence service; use the existing module one helper." }));
        }
        return base(context);
      },
    });

    const started = harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, missionId: `mission-${SESSION}` });
    missionId = `mission-${SESSION}`;
    const result = await started;
    expect([result.status, result.error]).toEqual(["completed", undefined]);

    const mission = harness.supervisor.getMission(missionId)!;
    const steering = mission.steering.find((entry) => entry.type === "clarification")!;
    expect(steering.message).toContain("existing module one helper");
    expect(steering.appliedAt).toBeTruthy();
    expect(steering.resultingPlanVersion).toBe(2);

    const replan = mission.planVersions.find((version) => version.version === 2)!;
    expect(replan.reason).toEqual({ type: "human_steering", steeringId: steering.id });
    expect(replan.diff?.preservedMilestones).toEqual(["s-one"]);
    expect(replan.diff?.removedMilestones).toEqual(["s-two"]);
    expect(replan.diff?.addedMilestones).toEqual(["s-two-steered"]);

    // Completed, unrelated work was preserved, not repeated.
    expect(mission.waves.filter((wave) => wave.milestoneId === "s-one")).toHaveLength(1);
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    expect(mission.milestones.map((milestone) => milestone.id)).toEqual(["s-one", "s-two-steered"]);
    // Steering never rewrites the objective itself.
    expect(mission.intent.goal).toBe(GOAL);
    expect(verifyMissionIntent(mission.intent)).toBe(true);
    expect(harness.missionEvents.some((event) => event.type === "mission.steered")).toBe(true);
  }, 300_000);

  it("starts a newly added acceptance criterion unproven and refuses to complete without evidence", async () => {
    let missionId = "";
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: (context) => {
        const base = scriptFromSpec({
          missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
          // The replan cannot cover AC-3: no milestone claims it, so it stays unproven.
          plans: [{ milestones: smallMilestones() }, { milestones: [FIRST, smallMilestones()[1]!] }],
          reviewer: () => reviewerPass(),
        });
        if (context.role === "reviewer" && context.goalHint.includes("Review synthesized implementation") && context.all.includes("mission milestone s-one")) {
          queueMicrotask(() => harness.supervisor.steerMission(missionId, {
            type: "acceptance_change", message: "Also make sure this works offline.",
            addedAcceptanceCriteria: [{ id: "AC-3", description: "the modules work offline" }],
          }));
        }
        return base(context);
      },
    });

    missionId = `mission-${SESSION}-acceptance`;
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, missionId });
    const mission = harness.supervisor.getMission(missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toContain(MISSION_ERRORS.MISSION_ACCEPTANCE_UNPROVEN);
    expect(mission.error).toContain("AC-3");
    // The new criterion begins unproven; earlier evidence does not retroactively prove it.
    const added = mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-3")!;
    expect(added).toMatchObject({ status: "unproven", mandatory: true, introducedInIntentVersion: 3 });
    expect(added.evidence).toEqual([]);
    // Intent was versioned by the trusted steering path, and still verifies.
    expect(mission.intent.version).toBe(3);
    expect(mission.intent.acceptanceCriteriaIds).toContain("AC-3");
    expect(verifyMissionIntent(mission.intent)).toBe(true);
    expect(mission.intentHistory).toHaveLength(2);
    // Work already certified is retained rather than discarded.
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    expect(result.retainedWork?.some((work) => work.kind === "milestone_checkpoint")).toBe(true);
  }, 300_000);

  it("stops removed scope without destroying earlier certified work", async () => {
    let missionId = "";
    const onlyFirst: MilestoneSpec = { ...FIRST, acceptanceCriteria: ["AC-1"], verificationCommands: [ONE_TEST] };
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: (context) => {
        const base = scriptFromSpec({
          missionId: "small", goal: GOAL, criteria: [{ id: "AC-1", description: "the first module returns ONE" }, { id: "AC-2", description: "the second module returns TWO", mandatory: false }],
          plans: [{ milestones: smallMilestones() }, { milestones: [onlyFirst] }],
          reviewer: () => reviewerPass(),
        });
        if (context.role === "reviewer" && context.goalHint.includes("Review synthesized implementation") && context.all.includes("mission milestone s-one")) {
          queueMicrotask(() => harness.supervisor.steerMission(missionId, { type: "scope_reduction", message: "Skip the second module for now.", removedMilestoneIds: ["s-two"] }));
        }
        return base(context);
      },
    });

    missionId = `mission-${SESSION}-scope`;
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, missionId });
    const mission = harness.supervisor.getMission(missionId)!;

    expect([result.status, result.error]).toEqual(["completed", undefined]);
    // Future work stopped; no wave ever ran for the removed milestone.
    expect(mission.milestones.map((milestone) => milestone.id)).toEqual(["s-one"]);
    expect(mission.waves.some((wave) => wave.milestoneId === "s-two")).toBe(false);
    expect(mission.planVersions[1]?.diff?.removedMilestones).toEqual(["s-two"]);
    // The completed milestone and its evidence survive the reduction.
    expect(mission.milestones[0]).toMatchObject({ id: "s-one", status: "completed" });
    expect(mission.milestones[0]!.checkpointId).toBeTruthy();
    expect(mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-1")?.status).toBe("proven");
    expect(mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-2")?.status).toBe("unproven");
  }, 300_000);

  it("pauses at a safe boundary without dispatching a new wave, then resumes without repeating work", async () => {
    let missionId = "";
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: (context) => {
        const base = scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() });
        // Pause while the first wave's Coder is genuinely mid-flight.
        if (context.role === "coder" && context.all.includes('"workstream":"one-write"') && context.call === 1) {
          queueMicrotask(() => harness.supervisor.pauseMission(missionId, "hold for review"));
        }
        return base(context);
      },
    });

    missionId = `mission-${SESSION}-pause`;
    const paused = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, missionId });
    const afterPause = harness.supervisor.getMission(missionId)!;

    expect(paused.error).toBe(MISSION_ERRORS.MISSION_PAUSED);
    expect(afterPause.status).toBe("paused");
    // The in-flight wave finished deterministically; the next wave was never dispatched.
    expect(afterPause.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    expect(afterPause.milestones.find((milestone) => milestone.id === "s-two")?.status).toBe("pending");
    expect(afterPause.waves).toHaveLength(1);
    expect(afterPause.currentWave).toBe(1);
    expect(harness.missionEvents.some((event) => event.type === "mission.paused")).toBe(true);
    expect(harness.missionEvents.filter((event) => event.type === "mission.wave.started")).toHaveLength(1);
    const firstRevision = afterPause.milestones.find((milestone) => milestone.id === "s-one")!.resultRevision;

    // Resume revalidates and continues; the certified milestone is not repeated.
    harness.supervisor.steerMission(missionId, { type: "resume" });
    const resumed = await harness.supervisor.resumeMission(missionId);
    const mission = harness.supervisor.getMission(missionId)!;

    expect(resumed.status).toBe("completed");
    expect(mission.waves.filter((wave) => wave.milestoneId === "s-one")).toHaveLength(1);
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.resultRevision).toBe(firstRevision);
    expect(mission.usage.waves).toBe(2);
    expect(harness.missionEvents.some((event) => event.type === "mission.resumed")).toBe(true);
    expect(mission.acceptanceCriteria.every((criterion) => criterion.status === "proven")).toBe(true);
  }, 300_000);
});
