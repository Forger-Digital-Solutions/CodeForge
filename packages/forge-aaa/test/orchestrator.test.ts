import { describe, expect, it } from "vitest";
import { createManifest, ForgeAaaDirector, sha256Hex, type ForgeAaaTask } from "../src/index.js";

const manifest = () => createManifest({
  assetId: "a/test", taskId: "t", provenance: { generator: "test", tool: "blender" },
  license: { commercialUse: "yes" },
  files: [{ path: "f", role: "output", sha256: sha256Hex("x"), bytes: 1 }],
  units: { system: "metric", scale: 1, upAxis: "Z" },
  engines: {}, validation: { checks: [] }, revision: 1,
});

function plan(): ForgeAaaTask[] {
  return [
    { id: "inspect", title: "Inspect", objective: "look", specialty: "forge-architect", dependencies: [], status: "planned", attempts: 0, artifacts: [], evidence: [] },
    { id: "impl", title: "Implement", objective: "do", specialty: "forge-modeler", dependencies: ["inspect"], status: "planned", attempts: 0, artifacts: [], evidence: [] },
    { id: "verify", title: "Verify", objective: "check", specialty: "forge-verify", dependencies: ["impl"], status: "planned", attempts: 0, artifacts: [], evidence: [] },
  ];
}

const passReport = { checks: [], passed: 1, failed: 0, blocked: 0, verified: true, ranAt: "now" };

describe("ForgeAaaDirector", () => {
  it("runs plan → route → execute → verify → review to FORGEAAA_VERIFIED", async () => {
    const director = new ForgeAaaDirector({
      planner: () => plan(),
      routeTask: (task) => ({ taskId: task.id, specialty: task.specialty, role: "CODER", outcome: "selected", ordered: [], reasonCodes: ["ROUTE_SELECTED"], decidedAt: "now" }),
      executeTask: async (task) => ({ ok: true, detail: `did ${task.id}`, ...(task.id === "impl" ? { manifests: [manifest()] } : {}) }),
      verifyTask: async () => passReport,
      reviewRun: async () => ({ approved: true, findings: [], independent: true }),
    });
    const run = await director.execute(director.createRun({ goal: "fix stairs" }).id);
    expect(run.status).toBe("done");
    expect(run.finalStatus).toBe("FORGEAAA_VERIFIED");
    expect(run.tasks.map((t) => t.status)).toEqual(["verified", "verified", "verified"]);
    expect(run.review?.independent).toBe(true);
    expect(run.routeDecisions).toHaveLength(3);
    expect(run.manifests).toHaveLength(1);
  });

  it("blocked routes block tasks — no execution, no claim", async () => {
    const director = new ForgeAaaDirector({
      planner: () => plan(),
      routeTask: (task) => ({ taskId: task.id, specialty: task.specialty, role: "CODER", outcome: "no_eligible_route", ordered: [], reasonCodes: ["NO_ELIGIBLE_ROUTE"], decidedAt: "now" }),
      executeTask: async () => ({ ok: true }),
      verifyTask: async () => passReport,
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(run.tasks.every((t) => t.status === "blocked")).toBe(true);
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
    expect(run.counters.modelCalls).toBe(0);
  });

  it("identical failure signature blocks instead of looping", async () => {
    let calls = 0;
    const director = new ForgeAaaDirector({
      planner: () => [plan()[0]!],
      executeTask: async () => { calls++; return { ok: false, detail: "same provider error 429" }; },
      maxAttemptsPerTask: 5,
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(calls).toBe(2);
    expect(run.tasks[0]?.status).toBe("blocked");
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
  });

  it("failed verification fails the task, and blocked downstream deps don't run", async () => {
    const executed: string[] = [];
    const director = new ForgeAaaDirector({
      planner: () => plan(),
      executeTask: async (task) => { executed.push(task.id); return { ok: true }; },
      verifyTask: async (task) => task.id === "impl"
        ? { checks: [], passed: 0, failed: 1, blocked: 0, verified: false, ranAt: "now" }
        : passReport,
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(executed).toEqual(["inspect", "impl"]);
    expect(run.tasks.map((t) => t.status)).toEqual(["verified", "failed", "blocked"]);
    expect(run.finalStatus).toBe("FORGEAAA_FAILED");
  });

  it("partial execution evidence yields FORGEAAA_PARTIAL — never VERIFIED", async () => {
    const director = new ForgeAaaDirector({
      planner: () => plan(),
      executeTask: async (task) => ({ ok: true, partial: task.id === "impl", ...(task.id === "impl" ? { manifests: [manifest()] } : {}) }),
      verifyTask: async () => passReport,
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(run.tasks[1]?.status).toBe("partial");
    expect(run.finalStatus).toBe("FORGEAAA_PARTIAL");
  });

  it("durable state round-trips through serialize/restore", async () => {
    const persisted: string[] = [];
    const director = new ForgeAaaDirector({ planner: () => plan(), persist: async (run) => { persisted.push(JSON.stringify(run.status)); } });
    const run = director.createRun({ goal: "g" });
    await director.execute(run.id);
    const snap = director.serialize(run.id);
    const restored = new ForgeAaaDirector();
    restored.restore(JSON.parse(JSON.stringify(snap)));
    expect(restored.getRun(run.id)?.finalStatus).toBe(snap?.finalStatus);
    expect(persisted.length).toBeGreaterThan(0);
  });
});
