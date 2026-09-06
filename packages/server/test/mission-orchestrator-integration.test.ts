import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  FEATURE_FLAG_REPO, IMPLEMENTATIONS, createHarness, createRepo, git, reviewerPass, scriptFromSpec,
  type MilestoneSpec, type MissionHarness,
} from "./helpers/mission-fixture.js";

const GOAL = "Add a persistent feature-flag system with a server API, UI toggle, and tests. Existing default behavior must remain unchanged.";
const SESSION = "cf09-mission-e2e";

const CRITERIA = [
  { id: "AC-1", description: "feature flag state has durable persistence" },
  { id: "AC-2", description: "server honors selected flags" },
  { id: "AC-3", description: "UI can toggle enabled flags" },
  { id: "AC-4", description: "existing default behavior is unchanged" },
  { id: "AC-5", description: "tests cover enabled and disabled behavior" },
];

const SETTINGS_TEST = "node --test test/settings.test.mjs";
const FEATURE_TEST = "node --test test/feature.test.mjs";
const SERVER_TEST = "node --test test/server.test.mjs";
const UI_TEST = "node --test test/ui.test.mjs";

const MODEL: MilestoneSpec = {
  id: "m-model", title: "Shared flag model", objective: "Implement the shared feature flag model and persistence",
  dependencies: [], acceptanceCriteria: ["AC-1", "AC-4"], verificationCommands: [SETTINGS_TEST, FEATURE_TEST],
  workstreams: [
    { id: "model-settings", objective: "Implement flag persistence in src/settings.mjs", expectedFiles: ["src/settings.mjs"], write: IMPLEMENTATIONS.settings },
    { id: "model-defaults", objective: "Implement flag defaults in src/defaults.mjs", expectedFiles: ["src/defaults.mjs"], write: IMPLEMENTATIONS.defaults },
  ],
};
const SERVER: MilestoneSpec = {
  id: "m-server", title: "Server runtime", objective: "Expose the feature flags through the server API",
  dependencies: ["m-model"], acceptanceCriteria: ["AC-2"], verificationCommands: [SERVER_TEST],
  workstreams: [{ id: "server-api", objective: "Implement handleFlagRequest in src/server.mjs", expectedFiles: ["src/server.mjs"], write: IMPLEMENTATIONS.server }],
};
const UI_BROKEN: MilestoneSpec = {
  id: "m-ui", title: "Desktop UI", objective: "Add the settings view toggle",
  dependencies: ["m-server"], acceptanceCriteria: ["AC-3"], verificationCommands: [UI_TEST],
  workstreams: [{ id: "ui-view", objective: "Render the flag toggle in ui/settings-view.mjs", expectedFiles: ["ui/settings-view.mjs"], write: IMPLEMENTATIONS.brokenUi }],
};
const UI_FIXED: MilestoneSpec = {
  id: "m-ui-2", title: "Desktop UI wiring", objective: "Rewire the settings view toggle to honor flag state",
  dependencies: ["m-server"], acceptanceCriteria: ["AC-3"], verificationCommands: [UI_TEST],
  workstreams: [{ id: "ui-view-2", objective: "Render the flag toggle state in ui/settings-view.mjs", expectedFiles: ["ui/settings-view.mjs"], write: IMPLEMENTATIONS.fixedUi }],
};
const certify = (dependency: string): MilestoneSpec => ({
  id: "m-certify", title: "Cross-package certification", objective: "Certify the feature flag system end to end",
  dependencies: [dependency], acceptanceCriteria: ["AC-5"], verificationCommands: [SETTINGS_TEST, FEATURE_TEST, SERVER_TEST, UI_TEST],
  workstreams: [{ id: "certify-docs", objective: "Record the certification evidence", expectedFiles: ["docs/mission-certification.md"], write: IMPLEMENTATIONS.certification }],
});

export const MISSION_PLANS = [
  { milestones: [MODEL, SERVER, UI_BROKEN, certify("m-ui")] },
  { milestones: [MODEL, SERVER, UI_FIXED, certify("m-ui-2")] },
];

describe("CF-09 long-horizon mission end to end", () => {
  let repoDir: string; let worktreeDir: string; let harness: MissionHarness;

  beforeEach(async () => {
    repoDir = await createRepo(FEATURE_FLAG_REPO, "cf09-e2e-repo-");
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf09-e2e-wt-"));
    harness = await createHarness({
      repoDir, worktreeDir, sessionId: SESSION,
      script: scriptFromSpec({ missionId: "flags", goal: GOAL, criteria: CRITERIA, plans: MISSION_PLANS, reviewer: () => reviewerPass() }),
    });
  });

  afterEach(async () => {
    harness.persistence.close();
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
  });

  it("runs multiple waves, replans on a real verification failure, preserves certified work, and promotes once", async () => {
    const baseRevision = await git(repoDir, ["rev-parse", "HEAD"]);
    const result = await harness.supervisor.startMission({ sessionId: SESSION, workspacePath: repoDir, goal: GOAL, budget: { maxWaves: 5 } });

    expect(result.status).toBe("completed");
    const mission = harness.supervisor.getMission(result.missionId)!;

    // ---- multi-wave execution through the certified parallel layer
    expect(result.planVersions).toBe(2);
    expect(result.replans).toBe(1);
    expect(result.wavesExecuted).toBe(5);
    expect(mission.milestones.map((milestone) => milestone.id)).toEqual(["m-model", "m-server", "m-ui-2", "m-certify"]);
    expect(mission.milestones.every((milestone) => milestone.status === "completed")).toBe(true);
    expect(harness.parallelEvents.filter((event) => event.type === "workstream.completed").length).toBeGreaterThanOrEqual(5);
    // The user checkout is untouched until the single final promotion.
    expect(mission.missionBranch).toMatch(/^codeforge\//);

    // ---- the replan was caused by a real command, not a simulated flag
    const replanVersion = mission.planVersions.find((version) => version.version === 2)!;
    expect(replanVersion.reason).toMatchObject({ type: "verification_failure", command: UI_TEST, exitCode: 1 });
    const failedWave = mission.waves.find((wave) => wave.milestoneId === "m-ui")!;
    expect(failedWave.status).toBe("blocked");
    expect(failedWave.error).toBe("GLOBAL_VERIFICATION_FAILED");

    // ---- minimal-diff replanning preserved the two certified milestones
    expect(replanVersion.diff).toMatchObject({
      fromVersion: 1, toVersion: 2,
      preservedMilestones: ["m-model", "m-server"],
      invalidatedMilestones: ["m-certify"],
      addedMilestones: ["m-ui-2"],
      removedMilestones: ["m-ui"],
    });
    expect(replanVersion.diff!.preservedWorkstreams).toHaveLength(2);
    // Preserved milestones were never re-executed: exactly one wave each, same revision.
    expect(mission.waves.filter((wave) => wave.milestoneId === "m-model")).toHaveLength(1);
    expect(mission.waves.filter((wave) => wave.milestoneId === "m-server")).toHaveLength(1);
    const model = mission.milestones.find((milestone) => milestone.id === "m-model")!;
    expect(model.resultRevision).toBe(mission.waves.find((wave) => wave.milestoneId === "m-model")!.resultingRevision);

    // ---- the replanner could not touch the authorized intent
    expect(mission.intent.goal).toBe(GOAL);
    expect(mission.intent.version).toBe(2); // v1 seed + acceptance compilation only
    expect(mission.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"]);

    // ---- acceptance is evidence-backed
    for (const criterion of mission.acceptanceCriteria) {
      expect(criterion.status).toBe("proven");
      expect(criterion.evidence.length).toBeGreaterThan(0);
      expect(criterion.provenBy?.verificationIds?.length).toBeGreaterThan(0);
    }

    // ---- milestone checkpoints are real durable refs
    for (const milestone of mission.milestones) {
      expect(milestone.checkpointId).toBeTruthy();
      expect(milestone.resultRevision).toMatch(/^[0-9a-f]{40}$/);
    }
    const missionWorkspace = harness.workspaceService.getWorkspace(mission.missionWorkspaceId!)!;
    for (const milestone of mission.milestones) {
      expect(await git(missionWorkspace.rootPath, ["rev-parse", "--verify", `refs/codeforge/checkpoints/${milestone.checkpointId}`]).catch(() => "")).not.toBe("");
    }

    // ---- final promotion happened exactly once, into the user checkout
    expect(mission.finalRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(repoDir, ["rev-parse", "HEAD"])).toBe(mission.finalRevision);
    expect(await git(repoDir, ["rev-parse", "HEAD"])).not.toBe(baseRevision);
    // Git may apply the platform's autocrlf rule on checkout; compare content, not line endings.
    const read = async (relative: string) => (await fs.readFile(path.join(repoDir, relative), "utf8")).split(String.fromCharCode(13)).join("");
    expect(await read("ui/settings-view.mjs")).toBe(IMPLEMENTATIONS.fixedUi.content);
    expect(await read("src/server.mjs")).toBe(IMPLEMENTATIONS.server.content);
    expect(await read("src/feature.mjs")).toBe(FEATURE_FLAG_REPO["src/feature.mjs"]);
    expect(existsSync(path.join(repoDir, "docs/mission-certification.md"))).toBe(true);

    // ---- mission memory stays bounded and structured
    const memoryBytes = Buffer.byteLength(JSON.stringify(mission.memory), "utf8");
    expect(memoryBytes).toBeLessThanOrEqual(16_000);
    expect(mission.memory.milestoneSummaries.map((entry) => entry.milestoneId)).toEqual(["m-model", "m-server", "m-ui-2", "m-certify"]);
    expect(mission.memory.compactions).toBeGreaterThan(0);

    // ---- usage is measured, not fabricated
    expect(mission.usage.waves).toBe(5);
    expect(mission.usage.replans).toBe(1);
    expect(mission.usage.workstreams).toBeGreaterThanOrEqual(5);
    expect(mission.usage.verificationRuns).toBeGreaterThan(0);
    expect(mission.usage.agentTurns).toBeGreaterThan(0);
    expect(mission.usage.writeCalls).toBeGreaterThanOrEqual(5);
    // A structured warning is emitted before the ceiling, and the ceiling never blocked the gate.
    expect(harness.missionEvents.some((event) => event.type === "mission.budget.warning" && String(event.payload.warning).startsWith("waves:4/5"))).toBe(true);

    // ---- lifecycle events describe the whole mission publicly
    const emitted = new Set(harness.missionEvents.map((event) => event.type));
    for (const type of [
      "mission.created", "mission.intent.recorded", "mission.acceptance.updated", "mission.plan.created", "mission.plan.validated",
      "mission.milestone.started", "mission.milestone.completed", "mission.wave.started", "mission.wave.completed", "mission.wave.blocked",
      "mission.replan.requested", "mission.replan.started", "mission.replan.completed", "mission.plan.replaced",
      "mission.acceptance.proven", "mission.memory.compacted", "mission.final_verification.completed", "mission.final_review.completed",
      "mission.promotion.completed", "mission.completed",
    ]) expect(emitted).toContain(type);
  }, 600_000);
});
