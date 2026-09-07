import { beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { buildContextKernel, createMinimalContextKernel, renderContextKernel } from "../src/kernel.js";

let persistence: ISessionPersistence;

beforeEach(async () => {
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
});

async function seed(items: WorkItem[]): Promise<void> {
  for (const item of items) await persistence.upsertWorkItem(item);
}

describe("FG-3A Context Kernel — authoritative runtime state, never fabricated, never silently dropped", () => {
  it("[PASS] cannot drop a pending approval", async () => {
    await seed([{ kind: "approval", id: "a1", sessionId: "s1", turnId: "t1", tool: "run_command", action: "rm -rf tmp", description: "cleanup", risk: "medium", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.approval.pending).toBe(true);
    expect(kernel.approval.summary).toContain("run_command");
    expect(renderContextKernel(kernel)).toContain("approval is pending");
  });

  it("[PASS] a resolved approval is not reported as pending", async () => {
    await seed([{ kind: "approval", id: "a1", sessionId: "s1", turnId: "t1", tool: "run_command", action: "rm", description: "cleanup", risk: "low", decision: "approved", resolvedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.approval.pending).toBe(false);
  });

  it("[PASS] cannot drop a pending question", async () => {
    await seed([{ kind: "question", id: "q1", sessionId: "s1", turnId: "t1", prompt: "Which branch?", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.question.pending).toBe(true);
    expect(kernel.question.summary).toBe("Which branch?");
    expect(renderContextKernel(kernel)).toContain("question to the user is pending");
  });

  it("[PASS] cannot drop an unconsumed steer", async () => {
    await seed([{ kind: "steer_receipt", id: "sr1", sessionId: "s1", steerId: "steer-1", turnId: "t1", message: "focus on auth.ts", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.steer.unconsumedSteerIds).toContain("steer-1");
    expect(kernel.steer.lastConsumedSteerId).toBeUndefined();
    expect(renderContextKernel(kernel)).toContain("1 user steering instruction(s)");
  });

  it("[PASS] distinguishes a consumed steer, never allowing it to be replayed as unconsumed", async () => {
    await seed([{ kind: "steer_receipt", id: "sr1", sessionId: "s1", steerId: "steer-1", turnId: "t1", message: "focus on auth.ts", consumedAt: "2026-01-01T00:00:05.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" }]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.steer.unconsumedSteerIds).not.toContain("steer-1");
    expect(kernel.steer.lastConsumedSteerId).toBe("steer-1");
    expect(renderContextKernel(kernel)).toContain("do not re-apply it");
  });

  it("[PASS] folds in session-level queued steers from the hold record without duplicating a receipt-tracked steer", async () => {
    await seed([
      { kind: "steer_receipt", id: "sr1", sessionId: "s1", steerId: "steer-1", turnId: "t1", message: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      {
        kind: "user_intent_hold",
        id: "hold-s1",
        sessionId: "s1",
        runId: "r1",
        turnId: "t1",
        state: "steer_queued",
        reason: "user_steer_queued",
        generation: 1,
        queuedSteers: [
          { steerId: "steer-1", turnId: "t1", message: "a", submittedAt: "2026-01-01T00:00:00.000Z" },
          { steerId: "steer-2", turnId: "t1", message: "b", submittedAt: "2026-01-01T00:00:01.000Z" },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(new Set(kernel.steer.unconsumedSteerIds)).toEqual(new Set(["steer-1", "steer-2"]));
    expect(kernel.steer.queuedCount).toBe(2);
  });

  it("[PASS] cannot drop an already-executed side effect (command / file change), and never leaks a running command as completed", async () => {
    await seed([
      { kind: "command", id: "c1", sessionId: "s1", turnId: "t1", command: "npm test", status: "completed", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" },
      { kind: "command", id: "c2", sessionId: "s1", turnId: "t1", command: "npm run build", status: "running", startedAt: "2026-01-01T00:00:02.000Z" },
      { kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "src/a.ts", changeType: "modified", additions: 2, deletions: 1, appliedAt: "2026-01-01T00:00:03.000Z" },
    ]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.changedFiles).toEqual(["src/a.ts"]);
    expect(kernel.completedActions.some((a) => a.summary.includes("npm test"))).toBe(true);
    expect(kernel.completedActions.some((a) => a.summary.includes("npm run build"))).toBe(false);
    const rendered = renderContextKernel(kernel);
    expect(rendered).toContain("npm test");
    expect(rendered).toContain("src/a.ts");
  });

  it("[PASS] scopes to one turn — a different turn's changed files never leak in", async () => {
    await seed([
      { kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "a.ts", changeType: "modified", additions: 1, deletions: 0 },
      { kind: "file_change", id: "f2", sessionId: "s1", turnId: "t2", path: "other.ts", changeType: "created", additions: 1, deletions: 0 },
    ]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    expect(kernel.changedFiles).toEqual(["a.ts"]);
    expect(kernel.changedFiles).not.toContain("other.ts");
  });

  it("[PASS] captures verification plan/attempt/evidence state without ever claiming it is complete", async () => {
    await seed([
      { kind: "verification", id: "v1", sessionId: "s1", runId: "r1", recordType: "plan", planId: "plan-1", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { kind: "verification", id: "v2", sessionId: "s1", runId: "r1", recordType: "attempt", planId: "plan-1", status: "failed", payload: {}, createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
    ]);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", objective: "obj" });
    expect(kernel.verification.required).toBe(true);
    expect(kernel.verification.planId).toBe("plan-1");
    expect(kernel.verification.latestStatus).toBe("failed");
    expect(kernel.verification.hasEvidence).toBe(false);
    expect(renderContextKernel(kernel)).toContain("latest recorded status: failed");
  });

  it("[PASS] preserves PARTIAL/UNKNOWN repository intelligence completeness verbatim, never upgrading it", async () => {
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", objective: "obj", repositoryIntelligenceCompleteness: "PARTIAL" });
    expect(kernel.repositoryIntelligenceCompleteness).toBe("PARTIAL");
    expect(renderContextKernel(kernel)).toContain("PARTIAL");
  });

  it("[PASS] is deterministic given identical persisted state (aside from generatedAt)", async () => {
    await seed([{ kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "a.ts", changeType: "modified", additions: 1, deletions: 0 }]);
    const k1 = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    const k2 = await buildContextKernel(persistence, { sessionId: "s1", turnId: "t1", objective: "obj" });
    const { generatedAt: _a, ...rest1 } = k1;
    const { generatedAt: _b, ...rest2 } = k2;
    expect(rest1).toEqual(rest2);
  });

  it("[PASS] bounds constraints and truncates an oversized objective rather than growing unboundedly", async () => {
    const hugeObjective = "x".repeat(10_000);
    const manyConstraints = Array.from({ length: 100 }, (_, i) => `constraint ${i}`);
    const kernel = await buildContextKernel(persistence, { sessionId: "s1", objective: hugeObjective, constraints: manyConstraints });
    expect(kernel.objective.length).toBeLessThan(500);
    expect(kernel.constraints.length).toBeLessThanOrEqual(20);
  });
});

describe("FG-3A minimal kernel — honest emptiness when no persistence is available", () => {
  it("[PASS] every runtime-state field is honestly empty/false, never fabricated", () => {
    const kernel = createMinimalContextKernel({ sessionId: "workspace-only", objective: "do the thing" });
    expect(kernel.changedFiles).toEqual([]);
    expect(kernel.completedActions).toEqual([]);
    expect(kernel.approval.pending).toBe(false);
    expect(kernel.question.pending).toBe(false);
    expect(kernel.steer.unconsumedSteerIds).toEqual([]);
    expect(kernel.steer.queuedCount).toBe(0);
    expect(kernel.repositoryIntelligenceCompleteness).toBeUndefined();
    expect(kernel.verification.required).toBe(true);
    expect(kernel.verification.hasEvidence).toBe(false);
  });

  it("[PASS] still renders a coherent, bounded prompt block", () => {
    const kernel = createMinimalContextKernel({ sessionId: "workspace-only", objective: "do the thing" });
    const rendered = renderContextKernel(kernel);
    expect(rendered).toContain("Objective: do the thing");
    expect(rendered).not.toContain("undefined");
  });
});
