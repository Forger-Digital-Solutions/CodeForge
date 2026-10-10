import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { SubagentRunWorkItemSchema } from "@codeforge/protocol";
import { createSubagentManager } from "../src/subagent-manager.js";
import type { AgentRuntime, AgentRuntimeRequest } from "../src/agent-runtime.js";
import type { RosterRouteAllowance } from "../src/forgeauto-roster.js";

describe("trusted parent workspace and personal routing survive child execution", () => {
  let directory: string;
  let parentWorkspace: string;
  let childWorkspace: string;
  let persistence: ISessionPersistence;
  let requests: AgentRuntimeRequest[];
  let runtime: AgentRuntime;
  const sessionId = "authorization-session";
  const allowance: RosterRouteAllowance = {
    freeRoutes: [], paidModelIds: [], personalRoutingMode: "FREE_PREFERRED",
    userRoutes: [{ sourceId: "alice-personal", providerId: "user-api-personal", modelId: "model-1", sourceClass: "USER_API", pinned: false, personalConnectionId: "connection-a", personalAdmission: "PAID_AUTHORIZED", inputCostPerMillion: 1, outputCostPerMillion: 2, costConfidence: "AUTHORITATIVE" }],
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cf-subagent-auth-"));
    parentWorkspace = join(directory, "parent"); childWorkspace = join(directory, "isolated");
    await mkdir(parentWorkspace); await mkdir(childWorkspace);
    persistence = createSessionPersistence({ dbPath: join(directory, "session.db") });
    await persistence.init();
    const now = new Date().toISOString();
    await persistence.upsertSession({ id: sessionId, title: "Child authorization", status: "running", createdAt: now, updatedAt: now });
    requests = [];
    runtime = { executeAgentRun: async (request: AgentRuntimeRequest) => {
      requests.push(request);
      return { status: "completed", summary: "Recorded", findings: [], evidence: [], toolExecutions: [], filesChanged: [], stopReason: "completed", usage: { inputTokens: 0, outputTokens: 0, requestCount: 0, toolCount: 0 } };
    } } as unknown as AgentRuntime;
  });
  afterEach(async () => { await persistence.close(); await rm(directory, { recursive: true, force: true }); });

  it("stamps initial children and persists the personal connection without replacing execution workspace", async () => {
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    await manager.spawnChildAgent({ parentRunId: "parent", sessionId, agentId: "coder", task: "Implement", workspacePath: childWorkspace, authorizationWorkspacePath: parentWorkspace, rosterAllowance: allowance });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ workspacePath: childWorkspace, authorizationWorkspacePath: parentWorkspace, rosterAllowance: allowance });
    expect(requests[0]?.modelSelection).toBeUndefined();
    const raw = (await persistence.getWorkItemsByKind("subagent_run"))[0];
    const parsed = SubagentRunWorkItemSchema.parse(raw);
    expect(parsed.workspacePath).toBe(childWorkspace);
    expect(parsed.routingHints?.authorizationWorkspacePath).toBe(parentWorkspace);
    expect(parsed.rosterAllowance).toEqual(allowance);
    expect(JSON.stringify(parsed.rosterAllowance)).not.toContain("credentialRef");
  });

  it("preserves the first-route pin for legacy user allowances without a personal policy", async () => {
    const { personalRoutingMode: _mode, ...legacy } = allowance;
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    await manager.spawnChildAgent({ parentRunId: "parent", sessionId, agentId: "coder", task: "Implement", workspacePath: childWorkspace, rosterAllowance: legacy });
    expect(requests[0]?.modelSelection).toEqual({ providerId: "user-api-personal", modelId: "model-1" });
  });

  async function interruptedWorker(authorizationWorkspacePath?: string, agentId: "coder" | "reviewer" = "coder") {
    const now = new Date().toISOString();
    const worker = SubagentRunWorkItemSchema.parse({
      kind: "subagent_run", id: "interrupted-child", sessionId, parentRunId: "parent", agentId, role: agentId === "reviewer" ? "Independent Code Reviewer" : "coder", task: "Implement", depth: 1, status: "running",
      capsule: { schemaVersion: 1, assignment: "Coder", goal: "Implement", relevantFiles: [], knownEvidence: [], constraints: [], requiredOutput: [] },
      permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, allowedTools: [], workspace: { id: "isolated", kind: "git-worktree" }, workspacePath: childWorkspace,
      routingHints: authorizationWorkspacePath ? { authorizationWorkspacePath } : {}, rosterAllowance: allowance,
      budget: { maxModelTurns: 10, maxToolCalls: 20, maxContextTokens: 64_000, wallTimeMs: 60_000 },
      telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 }, artifacts: [], createdAt: now, updatedAt: now,
    });
    await persistence.upsertWorkItem(worker);
    await persistence.upsertWorkItem({ kind: "agent_run_journal", id: "agent-run-journal-interrupted-child", sessionId, runId: worker.id, agentId, role: worker.role, state: "active", recoveryOutcome: "none", messages: [{ role: "system", content: agentId }, { role: "user", content: "Implement" }], turnCount: 1, toolCallCount: 0, writeCallCount: 0, commandCallCount: 0, createdAt: now, updatedAt: now } as never);
    await persistence.close();
    persistence = createSessionPersistence({ dbPath: join(directory, "session.db") }); await persistence.init();
  }

  it("restores parent disclosure identity and personal mode after reopening storage", async () => {
    await interruptedWorker(parentWorkspace);
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    expect((await manager.recoverInterruptedWorkers()).resumed).toBe(1);
    expect(requests[0]).toMatchObject({ workspacePath: childWorkspace, authorizationWorkspacePath: parentWorkspace, rosterAllowance: allowance });
    expect(requests[0]?.modelSelection).toBeUndefined();
    expect(requests[0]?.resumeJournal).toBeDefined();
  });

  it("uses a matching trusted parent recovery identity for legacy child records", async () => {
    await interruptedWorker();
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    expect((await manager.recoverInterruptedWorkers({ parentRunId: "parent", authorizationWorkspacePath: parentWorkspace })).resumed).toBe(1);
    expect(requests[0]).toMatchObject({ workspacePath: childWorkspace, authorizationWorkspacePath: parentWorkspace });
  });

  it("does not attach an unscoped recovery workspace to unrelated parents", async () => {
    await interruptedWorker();
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    expect((await manager.recoverInterruptedWorkers({ authorizationWorkspacePath: parentWorkspace })).resumed).toBe(1);
    expect(requests[0]?.authorizationWorkspacePath).toBeUndefined();
  });

  it("recovers the Reviewer machine role rather than routing its display label as Coder", async () => {
    await interruptedWorker(parentWorkspace, "reviewer");
    const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
    expect((await manager.recoverInterruptedWorkers({ parentRunId: "parent", authorizationWorkspacePath: parentWorkspace })).resumed).toBe(1);
    expect(requests[0]).toMatchObject({ role: "reviewer", structuredOutput: "reviewer", authorizationWorkspacePath: parentWorkspace });
  });
});
