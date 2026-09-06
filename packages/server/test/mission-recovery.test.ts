import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence, type SessionPersistence } from "@codeforge/sessions";
import {
  SMALL_CRITERIA, SMALL_IMPL, SMALL_REPO, TWO_TEST, createHarness, createRepo, crashOnEvent,
  MissionProvider, reviewerPass, scriptFromSpec, smallMilestones, type MilestoneSpec, type MissionHarness, type ScriptContext,
} from "./helpers/mission-fixture.js";
import { MISSION_ERRORS } from "../src/mission-state.js";

const GOAL = "Implement the first and second modules";
const SESSION = "cf09-recovery";
const MISSION_ID = "mission-cf09-recovery";
const FIRST = smallMilestones()[0]!;

const brokenSecond: MilestoneSpec = {
  id: "s-two", title: "Second", objective: "Implement the second module", dependencies: ["s-one"],
  acceptanceCriteria: ["AC-2"], verificationCommands: [TWO_TEST],
  workstreams: [{ id: "two-write", objective: "Implement src/two.mjs", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.brokenTwo }],
};
const repairedSecond: MilestoneSpec = {
  id: "s-two-fix", title: "Second (repaired)", objective: "Repair the second module", dependencies: ["s-one"],
  acceptanceCriteria: ["AC-2"], verificationCommands: [TWO_TEST],
  workstreams: [{ id: "two-fix", objective: "Repair src/two.mjs", expectedFiles: ["src/two.mjs"], write: SMALL_IMPL.two }],
};

describe("CF-09 mission restart recovery", () => {
  let repoDir: string; let worktreeDir: string; let stateDir: string; let dbPath: string;
  let live: SessionPersistence | undefined; let crashed: SessionPersistence | undefined;

  beforeEach(async () => {
    repoDir = await createRepo(SMALL_REPO, "cf09-recovery-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-recovery-wt-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-recovery-db-"));
    dbPath = path.join(stateDir, "codeforge.sqlite");
  });

  afterEach(async () => {
    try { await live?.close(); } catch {}
    try { await crashed?.close(); } catch {}
    live = undefined; crashed = undefined;
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  /** Runs a mission until the durable store dies at `crashEvent`, exactly as a killed process would. */
  async function crashDuring(crashEvent: string, script: (context: ScriptContext) => unknown, provider: MissionProvider): Promise<void> {
    crashed = createSessionPersistence({ dbPath });
    const harness = await createHarness({ repoDir, worktreeDir, sessionId: SESSION, script, provider, persistence: crashOnEvent(crashed, crashEvent) });
    await expect(harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, missionId: MISSION_ID })).rejects.toThrow(/PROCESS_TERMINATED/);
    await crashed.close(); crashed = undefined;
  }

  async function freshHarness(script: (context: ScriptContext) => unknown, provider: MissionProvider): Promise<MissionHarness> {
    live = createSessionPersistence({ dbPath });
    return await createHarness({ repoDir, worktreeDir, sessionId: SESSION, script, provider, persistence: live });
  }

  /** Counts Coder *dispatches* (each run's first turn), not every provider round trip. */
  const coderDispatches = (provider: MissionProvider, workstreamId: string) =>
    provider.requestsFor((entry) => entry.role === "coder"
      && entry.payload.includes(JSON.stringify(`"workstream":"${workstreamId}"`).slice(1, -1))
      && !entry.payload.includes('"role":"tool"')).length;

  it("does not re-run the Mission Planner after a crash during planning", async () => {
    const script = scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() });
    const provider = new MissionProvider(script);
    await crashDuring("mission.plan.validated", script, provider);

    const beforeResume = createSessionPersistence({ dbPath });
    const persisted = await beforeResume.getWorkItem(MISSION_ID) as unknown as { status: string; currentPlanVersion: number };
    expect(persisted.status).toBe("planning");
    expect(persisted.currentPlanVersion).toBe(1);
    await beforeResume.close();

    const harness = await freshHarness(script, provider);
    const result = await harness.supervisor.resumeMission(MISSION_ID);
    const mission = harness.supervisor.getMission(MISSION_ID)!;

    expect(result.status).toBe("completed");
    // The roadmap was produced once, across both process lifetimes.
    expect(provider.requestsFor((entry) => entry.role === "mission-planner" && entry.goalHint.startsWith("Mission roadmap"))).toHaveLength(1);
    expect(mission.planVersions).toHaveLength(1);
    expect(mission.currentPlanVersion).toBe(1);
    expect(mission.milestones.every((milestone) => milestone.status === "completed")).toBe(true);
  }, 300_000);

  it("never re-dispatches a wave whose workstream was in flight when the process died", async () => {
    const script = scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() });
    const provider = new MissionProvider(script);
    await crashDuring("workstream.completed", script, provider);
    expect(coderDispatches(provider, "one-write")).toBe(1);

    const harness = await freshHarness(script, provider);
    const result = await harness.supervisor.resumeMission(MISSION_ID);
    const mission = harness.supervisor.getMission(MISSION_ID)!;

    // The finished workstream is recognised as completed and its wave is resumed into
    // synthesis instead of being dispatched a second time.
    expect([result.status, result.error]).toEqual(["completed", undefined]);
    expect(coderDispatches(provider, "one-write")).toBe(1);
    const recovered = harness.missionEvents.find((event) => event.type === "mission.wave.recovered")!;
    expect(recovered.payload.recovery).toMatchObject({ "one-write": "completed" });
    expect(harness.parallelEvents.some((event) => event.type === "synthesis.started" && event.payload.recovered === true)).toBe(true);
    expect(mission.waves.filter((wave) => wave.milestoneId === "s-one")).toHaveLength(1);
    expect(mission.milestones.every((milestone) => milestone.status === "completed")).toBe(true);
    expect(mission.acceptanceCriteria.every((criterion) => criterion.status === "proven")).toBe(true);
  }, 300_000);

  it("keeps a completed milestone completed and runs the next wave exactly once after a restart", async () => {
    const script = scriptFromSpec({ missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA, plans: [{ milestones: smallMilestones() }], reviewer: () => reviewerPass() });
    const provider = new MissionProvider(script);
    await crashDuring("mission.milestone.completed", script, provider);
    expect(coderDispatches(provider, "one-write")).toBe(1);
    expect(coderDispatches(provider, "two-write")).toBe(0);

    const harness = await freshHarness(script, provider);
    const mission0 = harness.supervisor.getMission(MISSION_ID)!;
    expect(mission0.milestones.find((milestone) => milestone.id === "s-one")?.status).toBe("completed");
    const preservedRevision = mission0.milestones.find((milestone) => milestone.id === "s-one")!.resultRevision;
    const preservedUsage = mission0.usage.waves;

    const result = await harness.supervisor.resumeMission(MISSION_ID);
    const mission = harness.supervisor.getMission(MISSION_ID)!;

    expect(result.status).toBe("completed");
    // Milestone one was neither repeated nor re-dispatched; only milestone two ran.
    expect(coderDispatches(provider, "one-write")).toBe(1);
    expect(coderDispatches(provider, "two-write")).toBe(1);
    expect(mission.waves.filter((wave) => wave.milestoneId === "s-one")).toHaveLength(1);
    expect(mission.milestones.find((milestone) => milestone.id === "s-one")?.resultRevision).toBe(preservedRevision);
    // Budget counters and acceptance evidence survived the restart.
    expect(mission.usage.waves).toBe(preservedUsage + 1);
    expect(mission.acceptanceCriteria.every((criterion) => criterion.status === "proven")).toBe(true);
    expect(harness.missionEvents.some((event) => event.type === "mission.resumed")).toBe(true);
  }, 300_000);

  it("creates the replacement plan version at most once across a crash during replanning", async () => {
    const script = scriptFromSpec({
      missionId: "small", goal: GOAL, criteria: SMALL_CRITERIA,
      plans: [{ milestones: [FIRST, brokenSecond] }, { milestones: [FIRST, repairedSecond] }],
      reviewer: () => reviewerPass(),
    });
    const provider = new MissionProvider(script);
    await crashDuring("mission.replan.completed", script, provider);

    const harness = await freshHarness(script, provider);
    const mission0 = harness.supervisor.getMission(MISSION_ID)!;
    expect(mission0.currentPlanVersion).toBe(2);
    expect(mission0.usage.replans).toBe(1);

    const result = await harness.supervisor.resumeMission(MISSION_ID);
    const mission = harness.supervisor.getMission(MISSION_ID)!;

    expect(result.status).toBe("completed");
    // The Replanner ran once and produced exactly one replacement version.
    expect(provider.requestsFor((entry) => entry.role === "replanner")).toHaveLength(1);
    expect(mission.planVersions).toHaveLength(2);
    expect(mission.usage.replans).toBe(1);
    expect(mission.milestones.map((milestone) => milestone.id)).toEqual(["s-one", "s-two-fix"]);
    expect(mission.milestones.every((milestone) => milestone.status === "completed")).toBe(true);
    expect(mission.error).toBeUndefined();
  }, 300_000);
});
