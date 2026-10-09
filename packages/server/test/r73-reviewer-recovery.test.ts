import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";
import { createSubagentManager } from "../src/subagent-manager.js";
import type { AgentRuntime, AgentRuntimeRequest } from "../src/agent-runtime.js";

describe("R73 durable Reviewer routing constraints", () => {
  it("retains every failed Reviewer route and implementer independence after reopening storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "r73-reviewer-recovery-"));
    const dbPath = join(directory, "session.db");
    const now = new Date().toISOString();
    const hints = {
      preferIndependentFromPoolId: "implementer:pool",
      excludeRoleRoute: { providerId: "provider-b", modelId: "reviewer-b" },
      excludeRoleRoutes: [{ providerId: "provider-a", modelId: "reviewer-a" }, { providerId: "provider-b", modelId: "reviewer-b" }],
      routeReplacementReason: "SEMANTIC_VERIFIER_FALLBACK" as const,
      reviewEvidence: { workspacePath: directory, inputStateHash: "a".repeat(64), contextHash: "b".repeat(64), complete: true },
    };
    const before = createSessionPersistence({ dbPath });
    await before.init();
    await before.upsertSession({ id: "session-reviewer", title: "Reviewer recovery", status: "running", createdAt: now, updatedAt: now });
    await before.upsertWorkItem({
      kind: "subagent_run", id: "reviewer-replacement", sessionId: "session-reviewer", parentRunId: "parent", agentId: "reviewer", role: "reviewer", task: "Review the isolated implementation", depth: 1, status: "running",
      capsule: { schemaVersion: 1, assignment: "Review", goal: "Review", relevantFiles: [], knownEvidence: [], constraints: [], requiredOutput: [], context: "persisted review snapshot" },
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false }, allowedTools: [],
      workspace: { id: "isolated", kind: "local" }, workspacePath: directory, routingHints: hints,
      budget: { maxModelTurns: 10, maxToolCalls: 20, maxContextTokens: 64_000, wallTimeMs: 60_000 },
      telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
      artifacts: [], createdAt: now, updatedAt: now,
    });
    await before.upsertWorkItem({
      kind: "agent_run_journal", id: "agent-run-journal-reviewer-replacement", sessionId: "session-reviewer", runId: "reviewer-replacement", agentId: "reviewer", role: "reviewer", state: "active", recoveryOutcome: "none",
      messages: [{ role: "system", content: "CodeForge Reviewer" }, { role: "user", content: "Review" }], turnCount: 1, toolCallCount: 0, writeCallCount: 0, commandCallCount: 0, createdAt: now, updatedAt: now,
    } as never);
    await before.close();
    const after = createSessionPersistence({ dbPath });
    await after.init();
    try {
      const requests: AgentRuntimeRequest[] = [];
      const runtime = {
        executeAgentRun: async (request: AgentRuntimeRequest) => {
          requests.push(request);
          return { status: "completed", summary: "Reviewed", findings: [], evidence: [], toolExecutions: [], filesChanged: [], stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0, requestCount: 1, toolCount: 0 }, structuredData: { verdict: "pass", findings: [], summary: "Reviewed" } };
        },
      } as unknown as AgentRuntime;
      const manager = createSubagentManager({ persistence: after, agentRuntime: runtime, r1Enabled: true });
      const report = await manager.recoverInterruptedWorkers();
      expect(report.resumed).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject(hints);
      expect(requests[0]?.resumeJournal).toBeDefined();
      expect(requests[0]?.structuredOutput).toBe("reviewer");
      expect(requests[0]?.diff).toBe("persisted review snapshot");
      expect(requests[0]?.permissions.write).toBe(false);
      expect(requests[0]?.permissions.executeCommand).toBe(false);
    } finally {
      await after.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
