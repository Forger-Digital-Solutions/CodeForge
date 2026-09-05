import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SMALL_CRITERIA, SMALL_IMPL, SMALL_REPO, TWO_TEST, createHarness, createRepo, reviewerPass,
  scriptFromSpec, smallMilestones, type MilestoneSpec, type MissionHarness,
} from "./helpers/mission-fixture.js";
import { MISSION_ERRORS } from "../src/mission-state.js";

const GOAL = "Implement the first and second modules";
const SESSION = "cf09-budget";
const MISSING_TEST = "node --test test/missing.test.mjs";

const FIRST = smallMilestones()[0]!;
const brokenSecond = (id: string, verification: string[]): MilestoneSpec => ({
  id, title: id, objective: `Implement the second module (${id})`, dependencies: ["s-one"],
  acceptanceCriteria: ["AC-2"], verificationCommands: verification,
  workstreams: [{ id: `${id}-write`, objective: "Implement src/two.mjs", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.brokenTwo }],
});

describe("CF-09 mission budgets and loop detection are hard limits", () => {
  let repoDir: string; let worktreeDir: string; let harness: MissionHarness;

  beforeEach(async () => {
    repoDir = await createRepo(SMALL_REPO, "cf09-budget-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-budget-wt-"));
  });

  afterEach(async () => {
    harness?.persistence.close();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("stops replanning at the configured replan ceiling", async () => {
    harness = createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({
        missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
        // Each attempt fails a *different* real command, so the loop detector cannot fire first.
        plans: [
          { milestones: [FIRST, brokenSecond("s-two", [TWO_TEST])] },
          { milestones: [FIRST, brokenSecond("s-two-b", [MISSING_TEST])] },
        ],
        reviewer: () => reviewerPass(),
      }),
    });

    const result = await harness.supervisor.startMission({
      sessionId: SESSION, workspacePath: repoDir, goal: GOAL, budget: { maxReplans: 1 },
    });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toContain(MISSION_ERRORS.MISSION_REPLAN_LIMIT);
    expect(mission.usage.replans).toBe(1);
    expect(mission.planVersions).toHaveLength(2);
    expect(harness.missionEvents.filter((event) => event.type === "mission.replan.completed")).toHaveLength(1);
    expect(harness.missionEvents.some((event) => event.type === "mission.replan.blocked" && event.payload.code === MISSION_ERRORS.MISSION_REPLAN_LIMIT)).toBe(true);
    // The certified milestone and its evidence survive the ceiling.
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    expect(result.retainedWork?.some((work) => work.kind === "milestone_checkpoint")).toBe(true);
  }, 300_000);

  it("detects an equivalent replan cycle instead of running forever", async () => {
    harness = createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({
        missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
        // The Replanner keeps proposing the same failing roadmap for the same failing command.
        plans: [{ milestones: [FIRST, brokenSecond("s-two", [TWO_TEST])] }, { milestones: [FIRST, brokenSecond("s-two", [TWO_TEST])] }],
        reviewer: () => reviewerPass(),
      }),
    });

    const result = await harness.supervisor.startMission({
      sessionId: SESSION, workspacePath: repoDir, goal: GOAL, budget: { maxReplans: 5 },
    });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toBe(MISSION_ERRORS.MISSION_REPLAN_LOOP_DETECTED);
    // Bounded well below the replan ceiling: the cycle is caught by fingerprint, not by budget.
    expect(mission.usage.replans).toBe(1);
    expect(mission.usage.replans).toBeLessThan(mission.budget.maxReplans);
    const blocked = harness.missionEvents.find((event) => event.type === "mission.replan.blocked" && event.payload.code === MISSION_ERRORS.MISSION_REPLAN_LOOP_DETECTED);
    expect(blocked?.payload.fingerprint).toEqual(expect.any(String));
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
  }, 300_000);

  it("refuses to dispatch a new wave once the aggregate ceiling is reached", async () => {
    harness = createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() }),
    });

    const result = await harness.supervisor.startMission({
      sessionId: SESSION, workspacePath: repoDir, goal: GOAL, budget: { maxWaves: 1 },
    });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toContain(MISSION_ERRORS.MISSION_BUDGET_EXHAUSTED);
    expect(mission.error).toContain("waves 1/1");
    // Exactly one wave ran and the second milestone was never dispatched.
    expect(mission.usage.waves).toBe(1);
    expect(mission.waves).toHaveLength(1);
    expect(mission.milestones.find((milestone) => milestone.id === "s-two")?.status).toBe("pending");
    expect(harness.missionEvents.filter((event) => event.type === "mission.wave.started")).toHaveLength(1);
    // Everything produced so far is preserved rather than collapsed into a failure.
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    expect(mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-1")?.status).toBe("proven");
    expect(result.retainedWork?.length).toBeGreaterThan(0);
  }, 300_000);

});
