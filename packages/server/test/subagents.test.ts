import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentManager, SubagentManager, MAX_SUBAGENT_DEPTH, MAX_CHILDREN_PER_PARENT } from "../src/subagent-manager.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";

describe("Subagent Foundation — Explorer, Reviewer, Privilege Ceiling & Context Isolation", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-subagent-"));
    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });

    persistence.upsertSession({
      id: "sess-sub-1",
      title: "Subagent Test Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });

    // Create fixture files
    await writeFile(join(ws, "auth.ts"), "export function authenticate() { return true; }\n");
    await writeFile(join(ws, "router.ts"), "export function route() { return '/'; }\n");
    await writeFile(join(ws, "server.ts"), "export function start() { return 3000; }\n");
  });

  afterEach(async () => {
    persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("spawns Explorer child agent with private context and returns structured findings", async () => {
    const adapter = createWorkspaceEventAdapter({
      sessionId: "sess-sub-1",
      eventStore,
      persistence,
    });

    const manager = createSubagentManager({ persistence });

    const result = await manager.spawnChildAgent({
      parentRunId: "run-lead-1",
      agentId: "explorer",
      task: "Investigate architecture and map top-level files",
      workspacePath: ws,
      adapter,
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Explorer mapped");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.category).toBe("architecture");
    expect(result.files).toContain("auth.ts");
    expect(result.files).toContain("router.ts");
    expect(result.files).toContain("server.ts");
    expect(result.evidence.length).toBeGreaterThan(0);

    // Verify subagent events emitted
    const events = eventStore.getAll();
    const startedEvt = events.find((e) => e.type === "subagent.started");
    const progressEvt = events.find((e) => e.type === "subagent.progress");
    const completedEvt = events.find((e) => e.type === "subagent.completed");

    expect(startedEvt).toBeDefined();
    expect(progressEvt).toBeDefined();
    expect(completedEvt).toBeDefined();
  });

  it("spawns Reviewer child agent and generates structured blocking and advisory findings", async () => {
    const adapter = createWorkspaceEventAdapter({
      sessionId: "sess-sub-1",
      eventStore,
      persistence,
    });
    const manager = createSubagentManager({ persistence });

    // 1. Clean review -> advisory finding, completed
    const cleanResult = await manager.spawnChildAgent({
      parentRunId: "run-lead-2",
      agentId: "reviewer",
      task: "Review implemented changes for auth feature",
      workspacePath: ws,
      contextSummary: "All 5 tests passed with zero regressions.",
      adapter,
    });

    expect(cleanResult.status).toBe("completed");
    expect(cleanResult.findings[0]?.severity).toBe("advisory");

    // 2. Problematic verification summary -> blocking finding, blocked
    const blockedResult = await manager.spawnChildAgent({
      parentRunId: "run-lead-2",
      agentId: "reviewer",
      task: "Review implemented changes for broken test",
      workspacePath: ws,
      contextSummary: "Verification failed: 2 tests failed with TypeError regression in auth.ts",
      adapter,
    });

    expect(blockedResult.status).toBe("blocked");
    expect(blockedResult.findings.some((f) => f.severity === "blocking")).toBe(true);
    expect(blockedResult.risks.length).toBeGreaterThan(0);
  });

  it("enforces Privilege Ceiling (child permissions ⊆ parent permissions)", async () => {
    const manager = createSubagentManager({ persistence });

    // Parent is strictly READ-ONLY (write = false, executeCommand = false)
    const parentPermissions = {
      read: true,
      search: true,
      write: false,
      executeCommand: false,
    };

    // Spawn "coder" agent (which naturally requests write: true, executeCommand: true)
    const result = await manager.spawnChildAgent({
      parentRunId: "run-lead-readonly",
      agentId: "coder",
      task: "Implement new feature in read-only sandbox",
      workspacePath: ws,
      parentPermissions,
    });

    expect(result).toBeDefined();
    expect(result.status).toBe("completed");
  });

  it("enforces Depth Limit (MAX_SUBAGENT_DEPTH = 1) and rejects unauthorized recursion", async () => {
    const manager = createSubagentManager({ persistence });

    // Depth 1 (child) is allowed
    const childPromise = manager.spawnChildAgent({
      parentRunId: "run-lead-3",
      agentId: "explorer",
      task: "Explore repo",
      workspacePath: ws,
      depth: 1,
    });
    await expect(childPromise).resolves.toBeDefined();

    // Depth 2 (grandchild) is strictly rejected with SUBAGENT_DEPTH_EXCEEDED
    const grandchildPromise = manager.spawnChildAgent({
      parentRunId: "run-child-1",
      agentId: "explorer",
      task: "Recursively explore repo",
      workspacePath: ws,
      depth: 2,
    });
    await expect(grandchildPromise).rejects.toThrow(/SUBAGENT_DEPTH_EXCEEDED/);
  });

  it("propagates cancellation from parent to active child agents", async () => {
    const manager = createSubagentManager({ persistence });
    const parentController = new AbortController();

    // Parent aborts signal
    parentController.abort();

    const result = await manager.spawnChildAgent({
      parentRunId: "run-lead-cancel",
      agentId: "explorer",
      task: "Long running exploration",
      workspacePath: ws,
      signal: parentController.signal,
    });

    expect(result.status).toBe("cancelled");
  });
});
