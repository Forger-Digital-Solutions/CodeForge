import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";
import { CodeForgeServer, createSubagentManager } from "@codeforge/server";

describe("R58 production subagent wiring", () => {
  it("selects the real subagent path by default", async () => {
    const server = new CodeForgeServer({ dbPath: ":memory:" });
    try {
      expect((server as unknown as { subagentsR1Enabled: boolean }).subagentsR1Enabled).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("fails closed if an R1 worker has no real executor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-r58-executor-"));
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    try {
      await persistence.upsertSession({ id: "s", title: "Executor test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle" });
      const manager = createSubagentManager({ persistence, r1Enabled: true });
      const result = await manager.spawnChildAgent({
        parentRunId: "no-runtime",
        sessionId: "s",
        agentId: "coder",
        task: "Edit the repository",
        workspacePath: dir,
      });
      expect(result.status).not.toBe("completed");
      expect(result.summary).toContain("AUTONOMOUS_EXECUTOR_UNAVAILABLE");
      const worker = (await persistence.getWorkItemsByKind("subagent_run"))[0];
      expect(worker?.executorKind).toBe("unavailable");
    } finally {
      persistence.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
