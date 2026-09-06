import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  ONE_TEST, SMALL_CRITERIA, SMALL_IMPL, SMALL_REPO, TWO_TEST, createHarness, createRepo, git,
  reviewerBlock, reviewerPass, scriptFromSpec, smallMilestones, type MilestoneSpec, type MissionHarness,
} from "./helpers/mission-fixture.js";
import { MISSION_ERRORS } from "../src/mission-state.js";

const execFile = promisify(execFileCallback);
const GOAL = "Implement the first and second modules";
const SESSION = "cf09-acceptance";
const FIRST = smallMilestones()[0]!;

const unverifiedSecond: MilestoneSpec = {
  id: "s-two", title: "Second", objective: "Implement the second module", dependencies: ["s-one"],
  acceptanceCriteria: ["AC-2"], verificationCommands: [], // no deterministic check for AC-2
  workstreams: [{ id: "two-write", objective: "Implement src/two.mjs", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.two }],
};
const alternativeSecond: MilestoneSpec = {
  id: "s-two-alt", title: "Second (module two owns it)", objective: "Implement the second module in its own file",
  dependencies: ["s-one"], acceptanceCriteria: ["AC-2"], verificationCommands: [TWO_TEST],
  workstreams: [{ id: "two-alt", objective: "Implement src/two.mjs", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.two }],
};

describe("CF-09 acceptance, assumptions, and the final gate", () => {
  let repoDir: string; let worktreeDir: string; let harness: MissionHarness;

  beforeEach(async () => {
    repoDir = await createRepo(SMALL_REPO, "cf09-accept-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-accept-wt-"));
  });

  afterEach(async () => {
    await harness?.persistence.close();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("refuses to complete while a mandatory criterion lacks deterministic evidence", async () => {
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: [FIRST, unverifiedSecond] }], reviewer: () => reviewerPass() }),
    });

    const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toContain(MISSION_ERRORS.MISSION_ACCEPTANCE_UNPROVEN);
    expect(mission.error).toContain("AC-2");
    // Every milestone finished, yet acceptance without a passing command is only partial.
    expect(mission.milestones.every((milestone) => milestone.status === "completed")).toBe(true);
    expect(mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-1")?.status).toBe("proven");
    expect(mission.acceptanceCriteria.find((criterion) => criterion.id === "AC-2")?.status).toBe("partially_proven");
    // No promotion happened.
    expect(await git(repoDir, ["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(mission.finalRevision).toBeUndefined();
  }, 300_000);

  it("blocks promotion when the independent final Reviewer finds a missing requirement", async () => {
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({
        missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }],
        reviewer: (context) => context.goalHint.startsWith("Final acceptance review") ? reviewerBlock("offline behaviour is not covered by any test", "cf09-final-gap") : reviewerPass(),
      }),
    });

    const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("blocked");
    expect(mission.error).toBe(MISSION_ERRORS.MISSION_FINAL_REVIEW_BLOCKED);
    expect(result.findings?.map((finding) => finding.id)).toContain("cf09-final-gap");
    // The reviewer is read-only: it cannot rewrite acceptance, and nothing was promoted.
    expect(mission.acceptanceCriteria.map((criterion) => criterion.status)).toEqual(["proven", "proven"]);
    expect(await git(repoDir, ["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(harness.missionEvents.some((event) => event.type === "mission.final_review.completed" && event.payload.passed === false)).toBe(true);
    expect(result.retainedWork?.some((work) => work.kind === "mission_branch")).toBe(true);
  }, 300_000);

  it("replans when repository evidence invalidates a planner assumption", async () => {
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({
        missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
        plans: [
          { milestones: smallMilestones(), assumptions: [{ id: "as-owner", statement: "src/one.mjs owns the second module behaviour" }] },
          { milestones: [FIRST, alternativeSecond] },
        ],
        reviewer: () => reviewerPass(),
        // The Explorer cites a real file that contradicts the assumption.
        explorer: () => JSON.stringify({
          summary: "module two owns the behaviour",
          findings: [{ id: "assumption:as-owner:invalidated", severity: "advisory", category: "architecture", message: "the second module lives in its own file", path: "src/two.mjs" }],
          evidence: [],
        }),
      }),
    });

    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL });
    const mission = harness.supervisor.getMission(result.missionId)!;

    expect(result.status).toBe("completed");
    // The runtime, not the planner, flipped the assumption, and only against real evidence.
    const assumption = mission.assumptions.find((candidate) => candidate.id === "as-owner")!;
    expect(assumption).toMatchObject({ status: "invalidated", updatedBy: "runtime" });
    expect(assumption.evidence[0]?.ref).toBe("src/two.mjs");
    // Invalidation drove a replan rather than forcing the stale plan through.
    const replan = mission.planVersions.find((version) => version.version === 2)!;
    expect(replan.reason).toEqual({ type: "assumption_invalidated", assumptionId: "as-owner" });
    expect(mission.milestones.map((milestone) => milestone.id)).toEqual(["s-one", "s-two-alt"]);
    expect(harness.missionEvents.some((event) => event.type === "mission.assumption.invalidated")).toBe(true);
    // No milestone ran before the assumption was resolved.
    expect(mission.waves.every((wave) => wave.planVersion === 2)).toBe(true);
  }, 300_000);

  it("revalidates the target between milestones and refuses to promote over user work", async () => {
    let advanced = false;
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: (context) => {
        const base = scriptFromSpec({
          missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
          plans: [{ milestones: smallMilestones() }, { milestones: smallMilestones() }],
          reviewer: () => reviewerPass(),
        });
        // The user advances their own checkout over a file the mission already changed.
        if (!advanced && context.role === "reviewer" && context.goalHint.includes("Review synthesized implementation") && context.all.includes("mission milestone s-one")) {
          advanced = true;
          return (async () => {
            await fs.writeFile(path.join(repoDir, "src/one.mjs"), "export function one() { return 'ONE'; } // user edit\n");
            await execFile("git", ["commit", "-am", "user advances the target"], { cwd: repoDir });
            return base(context);
          })();
        }
        return base(context);
      },
    });

    const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL });
    const mission = harness.supervisor.getMission(result.missionId)!;
    const userRevision = await git(repoDir, ["rev-parse", "HEAD"]);

    // The drift was classified from real Git, not assumed away.
    const drift = harness.missionEvents.find((event) => event.type === "mission.repository.drift")!;
    expect(drift.payload).toMatchObject({ classification: "REPLAN_REQUIRED", expected: baseRevision, actual: userRevision });
    expect(drift.payload.overlappingPaths).toEqual(["src/one.mjs"]);
    // It caused a replan rather than blind continuation, and promotion still failed closed.
    expect(mission.planVersions.find((version) => version.version === 2)?.reason).toMatchObject({ type: "repository_divergence" });
    expect(result.status).toBe("blocked");
    expect(mission.error).toContain(MISSION_ERRORS.MISSION_REPOSITORY_DRIFT);
    // The user's own commit is untouched and remains the target HEAD.
    expect(userRevision).not.toBe(baseRevision);
    expect((await fs.readFile(path.join(repoDir, "src/one.mjs"), "utf8"))).toContain("user edit");
    expect(mission.finalRevision).toBeUndefined();
    expect(result.retainedWork?.some((work) => work.kind === "milestone_checkpoint")).toBe(true);
  }, 300_000);
});
