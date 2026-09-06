import { beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { EightBitHandoffBuilder, renderHandoffMessage } from "../src/index.js";

let persistence: ISessionPersistence;

beforeEach(async () => {
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
});

async function seed(items: WorkItem[]) {
  for (const item of items) await persistence.upsertWorkItem(item);
}

describe("EightBitHandoffBuilder — bounded deterministic handoff from authoritative runtime state", () => {
  it("[PASS] surfaces completed commands, changed files, and pending approval/question from persisted work items only", async () => {
    await seed([
      { kind: "command", id: "c1", sessionId: "s1", turnId: "t1", command: "npm test", status: "completed", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" },
      { kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "src/index.ts", changeType: "modified", additions: 3, deletions: 1, appliedAt: "2026-01-01T00:00:02.000Z" },
      { kind: "approval", id: "a1", sessionId: "s1", turnId: "t1", tool: "run_command", action: "rm", description: "delete temp", risk: "medium", createdAt: "2026-01-01T00:00:03.000Z" },
      { kind: "question", id: "q1", sessionId: "s1", turnId: "t1", prompt: "Which branch?", createdAt: "2026-01-01T00:00:04.000Z" },
      // Different turn — must not leak in.
      { kind: "file_change", id: "f2", sessionId: "s1", turnId: "t2", path: "other.ts", changeType: "created", additions: 1, deletions: 0 },
    ]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "Fix the failing test");
    expect(ctx.changedFiles).toEqual(["src/index.ts"]);
    expect(ctx.changedFiles).not.toContain("other.ts");
    expect(ctx.completedActions.some((a) => a.summary.includes("npm test"))).toBe(true);
    expect(ctx.approvalPending).toBe(true);
    expect(ctx.questionPending).toBe(true);
    expect(ctx.verificationRequired).toBe(true);
  });

  it("[PASS] a resolved approval/question does not appear as pending", async () => {
    await seed([
      { kind: "approval", id: "a1", sessionId: "s1", turnId: "t1", tool: "run_command", action: "rm", description: "delete temp", risk: "low", decision: "approved", resolvedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { kind: "question", id: "q1", sessionId: "s1", turnId: "t1", prompt: "Which branch?", answer: "main", resolvedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective");
    expect(ctx.approvalPending).toBe(false);
    expect(ctx.questionPending).toBe(false);
  });

  it("[PASS] a running command is not reported as an already-completed action", async () => {
    await seed([{ kind: "command", id: "c1", sessionId: "s1", turnId: "t1", command: "long build", status: "running", startedAt: "2026-01-01T00:00:00.000Z" }]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective");
    expect(ctx.completedActions).toHaveLength(0);
  });

  it("[PASS] repository intelligence PARTIAL/UNKNOWN completeness is preserved verbatim, never upgraded to COMPLETE", async () => {
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective", { getCompleteness: () => "PARTIAL" });
    expect(ctx.repositoryIntelligenceCompleteness).toBe("PARTIAL");
  });

  it("[PASS] renderHandoffMessage never claims an action happened that was not recorded, and states pending approval/question explicitly", () => {
    const message = renderHandoffMessage({
      sessionId: "s1",
      turnId: "t1",
      objective: "Fix bug",
      completedActions: [{ kind: "command", summary: "npm test" }],
      changedFiles: ["a.ts"],
      verificationRequired: true,
      approvalPending: true,
      questionPending: false,
      generatedAt: new Date().toISOString(),
    });
    expect(message).toContain("npm test");
    expect(message).toContain("a.ts");
    expect(message).toContain("approval is pending");
    expect(message).not.toContain("question");
  });
});
