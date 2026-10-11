import { describe, expect, it, vi } from "vitest";
import { ForgeAaaDirector, type ForgeAaaRun, type ForgeAaaTask, type ForgeAaaVerificationReport } from "../src/index.js";

function task(id: string, dependencies: string[] = []): ForgeAaaTask {
  return { id, title: id, objective: id, specialty: "forge-architect", dependencies, status: "planned", attempts: 0, artifacts: [], evidence: [] };
}

function pass(): ForgeAaaVerificationReport {
  return { checks: [{ id: "artifact", kind: "file-exists", status: "passed", durationMs: 1, evidenceRef: "fixture-output" }], passed: 1, failed: 0, blocked: 0, verified: true, ranAt: "now" };
}

const review = async () => ({ approved: true, independent: true, findings: [] });
const interruption = new Error("simulated process interruption");

function checkpoint(when: (run: ForgeAaaRun) => boolean): {
  persist: (run: ForgeAaaRun) => Promise<void>;
  snapshot: () => ForgeAaaRun;
} {
  let saved: ForgeAaaRun | undefined;
  return {
    persist: async (run) => {
      if (when(run)) {
        saved = JSON.parse(JSON.stringify(run)) as ForgeAaaRun;
        throw interruption;
      }
    },
    snapshot: () => {
      if (!saved) throw new Error("checkpoint was not reached");
      return saved;
    },
  };
}

describe("ForgeAAA interruption recovery", () => {
  it("preserves verified work, artifacts, evidence, and counters instead of replanning", async () => {
    const saved = checkpoint((run) => run.tasks[0]?.status === "verified");
    const first = new ForgeAaaDirector({
      planner: () => [task("inspect"), task("build", ["inspect"])],
      executeTask: async () => ({ ok: true, artifacts: ["inspection.json"], modelCalls: 1, adapterOps: 2 }),
      verifyTask: async () => pass(), persist: saved.persist,
    });
    const run = first.createRun({ goal: "bounded repair" });
    await expect(first.execute(run.id)).rejects.toBe(interruption);
    expect(first.serialize(run.id)).toEqual(saved.snapshot());

    const planner = vi.fn(() => [task("replacement")]);
    const executeTask = vi.fn(async () => ({ ok: true, artifacts: ["build.glb"], modelCalls: 0, adapterOps: 1 }));
    const restored = new ForgeAaaDirector({ planner, executeTask, verifyTask: async () => pass(), reviewRun: review });
    restored.restore(saved.snapshot());
    const recovered = await restored.execute(run.id);
    expect(planner).not.toHaveBeenCalled();
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(executeTask.mock.calls[0]?.[0]?.id).toBe("build");
    expect(recovered.tasks[0]).toEqual(saved.snapshot().tasks[0]);
    expect(recovered.tasks[1]?.artifacts).toEqual(["build.glb"]);
    expect(recovered.verificationReports).toHaveLength(2);
    expect(recovered.counters).toEqual({ taskAttempts: 2, retries: 0, modelCalls: 1, adapterOps: 3 });
    expect(recovered.finalStatus).toBe("FORGEAAA_VERIFIED");
  });

  it.each(["integrating", "testing"])("resumes the %s checkpoint without replaying successful execution", async (stage) => {
    const saved = checkpoint((run) => run.tasks[0]?.status === stage);
    const first = new ForgeAaaDirector({
      planner: () => [task("build")], executeTask: async () => ({ ok: true, artifacts: ["build.glb"], adapterOps: 1 }),
      verifyTask: async () => pass(), persist: saved.persist,
    });
    const run = first.createRun({ goal: "g" });
    await expect(first.execute(run.id)).rejects.toBe(interruption);
    const executeTask = vi.fn(async () => ({ ok: true }));
    const restored = new ForgeAaaDirector({ executeTask, verifyTask: async () => pass(), reviewRun: review });
    restored.restore(saved.snapshot());
    const recovered = await restored.execute(run.id);
    expect(executeTask).not.toHaveBeenCalled();
    expect(recovered.tasks[0]?.artifacts).toEqual(["build.glb"]);
    expect(recovered.tasks[0]?.attempts).toBe(1);
    expect(recovered.counters).toEqual({ taskAttempts: 1, retries: 0, modelCalls: 0, adapterOps: 1 });
    expect(recovered.finalStatus).toBe("FORGEAAA_VERIFIED");
  });

  it("keeps the original attempt limit through repeated restarts and a larger new limit", async () => {
    let state: ForgeAaaRun | undefined;
    for (let restart = 0; restart < 2; restart++) {
      const saved = checkpoint((run) => run.tasks[0]?.status === "generating" && run.counters.taskAttempts === restart + 1);
      const executeTask = vi.fn(async () => ({ ok: true }));
      const director = new ForgeAaaDirector({ planner: () => [task("build")], maxAttemptsPerTask: restart === 0 ? 2 : 20, executeTask, persist: saved.persist });
      if (state) director.restore(state);
      else state = director.createRun({ goal: "g" });
      await expect(director.execute(state.id)).rejects.toBe(interruption);
      expect(executeTask).not.toHaveBeenCalled();
      state = saved.snapshot();
      expect(state.tasks[0]?.attempts).toBe(restart + 1);
    }
    const executeTask = vi.fn(async () => ({ ok: true }));
    const restored = new ForgeAaaDirector({ maxAttemptsPerTask: 20, executeTask });
    restored.restore(state!);
    const run = await restored.execute(state!.id);
    expect(executeTask).not.toHaveBeenCalled();
    expect(run.maxAttemptsPerTask).toBe(2);
    expect(run.counters).toEqual({ taskAttempts: 2, retries: 1, modelCalls: 0, adapterOps: 0 });
    expect(run.tasks[0]?.detail).toContain("budget exhausted");
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
  });

  it("preserves repeated failure detection and usage after a restart", async () => {
    const saved = checkpoint((run) => run.tasks[0]?.lastFailureSignature !== undefined);
    const first = new ForgeAaaDirector({
      planner: () => [task("build")], maxAttemptsPerTask: 5,
      executeTask: async () => ({ ok: false, detail: "engine unavailable", adapterOps: 1 }), persist: saved.persist,
    });
    const run = first.createRun({ goal: "g" });
    await expect(first.execute(run.id)).rejects.toBe(interruption);
    const restored = new ForgeAaaDirector({ maxAttemptsPerTask: 5, executeTask: async () => ({ ok: false, detail: "engine unavailable", adapterOps: 1 }) });
    restored.restore(saved.snapshot());
    const recovered = await restored.execute(run.id);
    expect(recovered.tasks[0]?.status).toBe("blocked");
    expect(recovered.tasks[0]?.detail).toContain("repeated failure signature");
    expect(recovered.counters).toEqual({ taskAttempts: 2, retries: 1, modelCalls: 0, adapterOps: 2 });
  });

  it("persists independent review without rerunning execution or review after restart", async () => {
    const saved = checkpoint((run) => run.review !== undefined);
    const first = new ForgeAaaDirector({ planner: () => [task("build")], executeTask: async () => ({ ok: true }), verifyTask: async () => pass(), reviewRun: review, persist: saved.persist });
    const run = first.createRun({ goal: "g" });
    await expect(first.execute(run.id)).rejects.toBe(interruption);
    const reviewRun = vi.fn(review);
    const executeTask = vi.fn(async () => ({ ok: true }));
    const restored = new ForgeAaaDirector({ reviewRun, executeTask });
    restored.restore(saved.snapshot());
    expect((await restored.execute(run.id)).finalStatus).toBe("FORGEAAA_VERIFIED");
    expect(executeTask).not.toHaveBeenCalled();
    expect(reviewRun).not.toHaveBeenCalled();
  });

  it("orders tasks by verified dependencies while preserving the persisted plan order", async () => {
    const executed: string[] = [];
    const director = new ForgeAaaDirector({
      planner: () => [task("finish", ["build"]), task("build", ["inspect"]), task("inspect")],
      executeTask: async (current) => { executed.push(current.id); return { ok: true }; }, verifyTask: async () => pass(), reviewRun: review,
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(executed).toEqual(["inspect", "build", "finish"]);
    expect(run.tasks.map((current) => current.id)).toEqual(["finish", "build", "inspect"]);
    expect(run.finalStatus).toBe("FORGEAAA_VERIFIED");
  });

  it.each([
    ["duplicate ids", [task("same"), task("same")]],
    ["missing dependency", [task("build", ["missing"])]],
    ["self cycle", [task("build", ["build"])]],
    ["dependency cycle", [task("a", ["b"]), task("b", ["a"])]],
    ["oversized plan", Array.from({ length: 25 }, (_, index) => task(String(index)))],
  ])("blocks %s before dispatch", async (_label, tasks) => {
    const executeTask = vi.fn(async () => ({ ok: true }));
    const director = new ForgeAaaDirector({ planner: () => tasks as ForgeAaaTask[], executeTask });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(executeTask).not.toHaveBeenCalled();
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
    expect(run.blockers[0]).toContain("invalid plan");
    expect(run.counters.taskAttempts).toBe(0);
  });

  it.each(["partial", "blocked", "failed"] as const)("does not execute a task depending on a restored %s task", async (status) => {
    const executeTask = vi.fn(async () => ({ ok: true }));
    const director = new ForgeAaaDirector({ executeTask, verifyTask: async () => pass() });
    const initial = director.createRun({ goal: "g" });
    initial.status = "executing";
    initial.tasks = [{ ...task("inspect"), status, attempts: 1 }, task("build", ["inspect"])];
    director.restore(initial);
    const run = await director.execute(initial.id);
    expect(executeTask).not.toHaveBeenCalled();
    expect(run.tasks[0]?.status).toBe(status);
    expect(run.tasks[1]?.status).toBe("blocked");
    expect(run.tasks[1]?.detail).toContain("dependency unfinished: inspect");
  });

  it("successful execution without verification stays partial and blocks dependents", async () => {
    const executeTask = vi.fn(async () => ({ ok: true, artifacts: ["artifact.glb"], adapterOps: 1 }));
    const director = new ForgeAaaDirector({ planner: () => [task("build"), task("import", ["build"])], executeTask, reviewRun: review });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(run.tasks.map((current) => current.status)).toEqual(["partial", "blocked"]);
    expect(run.finalStatus).not.toBe("FORGEAAA_VERIFIED");
    expect(run.counters.modelCalls).toBe(0);
  });

  it.each([undefined, false])("requires approved independent review (independent=%s)", async (independent) => {
    const director = new ForgeAaaDirector({
      planner: () => [task("build")], executeTask: async () => ({ ok: true }), verifyTask: async () => pass(),
      ...(independent === undefined ? {} : { reviewRun: async () => ({ approved: true, independent, findings: [] }) }),
    });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(run.tasks[0]?.status).toBe("verified");
    expect(run.finalStatus).toBe("FORGEAAA_PARTIAL");
  });

  it("does not accept zero-check or failed reports as verification", async () => {
    const director = new ForgeAaaDirector({ planner: () => [task("build")], executeTask: async () => ({ ok: true }), verifyTask: async () => ({ ...pass(), checks: [], passed: 0 }), reviewRun: review });
    const run = await director.execute(director.createRun({ goal: "g" }).id);
    expect(run.tasks[0]?.status).toBe("blocked");
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
  });

  it("blocks legacy interrupted verification without a durable execution result", async () => {
    const executeTask = vi.fn(async () => ({ ok: true }));
    const director = new ForgeAaaDirector({ executeTask, verifyTask: async () => pass() });
    const initial = director.createRun({ goal: "g" });
    initial.status = "verifying";
    initial.tasks = [{ ...task("build"), status: "testing", attempts: 1, artifacts: ["existing.glb"] }];
    director.restore(initial);
    const run = await director.execute(initial.id);
    expect(executeTask).not.toHaveBeenCalled();
    expect(run.tasks[0]?.artifacts).toEqual(["existing.glb"]);
    expect(run.finalStatus).toBe("FORGEAAA_BLOCKED");
  });
});
