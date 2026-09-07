import { beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import { EightBitHandoffBuilder, renderHandoffMessage } from "../src/index.js";

let persistence: ISessionPersistence;

beforeEach(async () => {
  persistence = createSessionPersistence({ dbPath: ":memory:" });
  await persistence.init();
  await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
});

async function seed(items: WorkItem[]): Promise<void> {
  for (const item of items) await persistence.upsertWorkItem(item);
}

describe("FG-3 — EightBitHandoffBuilder embeds the authoritative Context Kernel and reusable Context Page references", () => {
  it("[PASS] attaches a kernel derived from the SAME persisted state as the pre-FG-3 fields (no second WorkItem reader)", async () => {
    await seed([
      { kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "src/index.ts", changeType: "modified", additions: 3, deletions: 1 },
      { kind: "approval", id: "a1", sessionId: "s1", turnId: "t1", tool: "run_command", action: "rm", description: "delete temp", risk: "medium", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "Fix the failing test");
    expect(ctx.kernel).toBeDefined();
    expect(ctx.kernel!.changedFiles).toEqual(ctx.changedFiles);
    expect(ctx.kernel!.approval.pending).toBe(ctx.approvalPending);
  });

  it("[PASS] preserves unconsumed steer state across a handoff and renders it for the replacement model", async () => {
    await seed([{ kind: "steer_receipt", id: "sr1", sessionId: "s1", steerId: "steer-42", turnId: "t1", message: "focus on the retry path", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective");
    expect(ctx.kernel!.steer.unconsumedSteerIds).toContain("steer-42");
    const message = renderHandoffMessage(ctx);
    expect(message).toContain("1 user steering instruction(s)");
  });

  it("[PASS] a consumed steer is never presented as something to (re)apply", async () => {
    await seed([{ kind: "steer_receipt", id: "sr1", sessionId: "s1", steerId: "steer-42", turnId: "t1", message: "a", consumedAt: "2026-01-01T00:00:05.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:05.000Z" }]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective");
    const message = renderHandoffMessage(ctx);
    expect(message).toContain("do not re-apply it");
    expect(message).not.toContain("queued and not yet applied");
  });

  it("[PASS] surfaces recorded verification status without ever claiming completion", async () => {
    await seed([
      { kind: "verification", id: "v1", sessionId: "s1", runId: "r1", recordType: "plan", planId: "p1", payload: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { kind: "verification", id: "v2", sessionId: "s1", runId: "r1", recordType: "attempt", planId: "p1", status: "running", payload: {}, createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
    ]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective");
    const message = renderHandoffMessage(ctx);
    expect(message).toContain("Latest recorded verification status: running");
    expect(message).not.toMatch(/verification status.{0,10}(passed|complete)/i);
  });

  it("[PASS] a supplied Context Page builder callback receives the kernel's authoritative changed-files list and its output is rendered", async () => {
    await seed([{ kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "src/a.ts", changeType: "modified", additions: 1, deletions: 0 }]);
    const builder = new EightBitHandoffBuilder(persistence);
    let receivedFiles: string[] = [];
    const ctx = await builder.build("s1", "t1", "objective", undefined, async (changedFiles) => {
      receivedFiles = changedFiles;
      return [{ type: "dependency_neighborhood", path: "src/a.ts", reused: true }];
    });
    expect(receivedFiles).toEqual(["src/a.ts"]);
    expect(ctx.contextPages).toEqual([{ type: "dependency_neighborhood", path: "src/a.ts", reused: true }]);
    const message = renderHandoffMessage(ctx);
    expect(message).toContain("src/a.ts [dependency_neighborhood, cached]");
    expect(message).toContain("repo_dependencies");
  });

  it("[PASS] a failing Context Page builder callback never fails or blocks the handoff (advisory only)", async () => {
    await seed([{ kind: "file_change", id: "f1", sessionId: "s1", turnId: "t1", path: "src/a.ts", changeType: "modified", additions: 1, deletions: 0 }]);
    const builder = new EightBitHandoffBuilder(persistence);
    const ctx = await builder.build("s1", "t1", "objective", undefined, async () => {
      throw new Error("intelligence unavailable");
    });
    expect(ctx.contextPages).toBeUndefined();
    expect(ctx.changedFiles).toEqual(["src/a.ts"]);
  });

  it("[PASS] pre-FG-3 handoff.test.ts behavior is unaffected: renderHandoffMessage without a kernel never mentions steer/verification-status/pages", () => {
    const message = renderHandoffMessage({
      sessionId: "s1",
      turnId: "t1",
      objective: "Fix bug",
      completedActions: [],
      changedFiles: [],
      verificationRequired: true,
      approvalPending: false,
      questionPending: false,
      generatedAt: new Date().toISOString(),
    });
    expect(message).not.toContain("steering instruction");
    expect(message).not.toContain("recorded status");
    expect(message).not.toContain("Reusable structural context");
  });
});
