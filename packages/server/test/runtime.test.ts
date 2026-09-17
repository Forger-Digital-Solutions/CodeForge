import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventStore } from "@codeforge/sessions";
import { WorkspaceEventAdapter, createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { AgentRuntime, createAgentRuntime } from "../src/agent-runtime.js";
import { FileSystemService, createFileSystemService } from "../src/filesystem-service.js";
import { CommandService, createCommandService } from "../src/command-service.js";
import { createValidationService } from "../src/validation-service.js";
import { CheckpointService, createCheckpointService } from "../src/checkpoint-service.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// better-sqlite3 check removed - CodeForge now uses node:sqlite

describe("WorkspaceEventAdapter (in-memory)", () => {
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;

  beforeEach(() => {
    eventStore = new EventStore();
    adapter = createWorkspaceEventAdapter({
      sessionId: "test-session",
      eventStore,
      persistence: {
        appendEvent: () => {},
        upsertSession: () => {},
        upsertTurn: () => {},
        getSession: () => undefined,
        listSessions: () => [],
        getTurns: () => [],
        getWorkItems: () => [],
        getEvents: () => [],
        close: () => {},
      } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>,
    });
  });

  it("should emit turn.started event", () => {
    adapter.emitTurnStarted("turn-1", "Hello world");
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn.started");
  });

  it("should emit file.read event", () => {
    adapter.emitFileRead("call-1", "src/index.ts", 100);
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("file.read");
  });

  it("should emit command events", () => {
    adapter.emitCommandStarted("cmd-1", "npm test", "/workspace");
    adapter.emitCommandOutput("cmd-1", "running tests...", "stdout");
    adapter.emitCommandCompleted("cmd-1", 0, 1500);
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("command.started");
    expect(events[1].type).toBe("command.output");
    expect(events[2].type).toBe("command.completed");
  });

  it("should emit approval events", () => {
    adapter.emitApprovalRequested("approval-1", "execute", "run", "Run command", "moderate");
    adapter.emitApprovalResolved("approval-1", "allow_once");
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("approval.requested");
    expect(events[1].type).toBe("approval.resolved");
  });

  it("should increment sequence numbers", () => {
    adapter.emitTurnStarted("turn-1", "Hello");
    adapter.emitTurnCompleted("turn-1", "Done");
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });
});

describe("AgentRuntime (in-memory)", () => {
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let runtime: AgentRuntime;
  let providerCatalog: InMemoryProviderCatalog;

  beforeEach(() => {
    eventStore = new EventStore();
    firewall = new ForgeZero();

    const model: FreeModelRecord = {
      providerId: "test",
      modelId: "test-model",
      displayName: "Test Model",
      freeStatus: "verified_free",
      contextWindow: 128000,
      capabilities: {
        text: true,
        coding: true,
        toolCalling: true,
        vision: false,
        structuredOutput: true,
        longContext: true,
      },
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: "test",
      },
      isRemote: true,
      isCloudHosted: true,
      // Without a health state ForgeZero never admits the route; these turns then exercised the
      // runtime's (former) fall-through to "completed" without a model instead of the mock provider.
      health: { status: "available", lastCheckedAt: new Date().toISOString() },
    };
    firewall.register(model);

    providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(createMockProvider({
      providerId: "test",
      streamEvents: [[
        { type: "text_delta", delta: "Processing" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { type: "finish", finishReason: "stop" },
      ]],
    }));

    runtime = createAgentRuntime({
      sessionId: "test-session",
      eventStore,
      persistence: {
        appendEvent: () => {},
        upsertSession: () => {},
        upsertTurn: () => {},
        getSession: () => undefined,
        listSessions: () => [],
        getTurns: () => [],
        getWorkItems: () => [],
        getEvents: () => [],
        close: () => {},
      } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>,
      firewall,
      providerCatalog,
    });
  });

  const settle = async (turnId: string) => {
    for (let i = 0; i < 200 && runtime.getTurn(turnId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    return runtime.getTurn(turnId);
  };

  it("should start a turn", async () => {
    const turnId = await runtime.startTurn("Hello world");
    expect(turnId).toBeDefined();
    expect(runtime.getTurn(turnId)).toBeDefined();
    // The mock provider answers immediately, so the real model turn settles as completed.
    const state = await settle(turnId);
    expect(state?.status).toBe("completed");
    expect(state?.modelId).toBe("test-model");
  });

  it("should track active turns", async () => {
    // One real turn at a time per session: the second starts once the first has settled.
    const turnId1 = await runtime.startTurn("First task");
    await settle(turnId1);
    const turnId2 = await runtime.startTurn("Second task");
    await settle(turnId2);
    expect(runtime.getTurn(turnId1)?.status).toBe("completed");
    expect(runtime.getTurn(turnId2)?.status).toBe("completed");
    expect(runtime.getActiveTurns().filter((t) => t.status === "running")).toHaveLength(0);
  });

  it("should handle cancellation", async () => {
    const turnId = await runtime.startTurn("Long running task");
    await runtime.cancelTurn(turnId, "User requested");
    const state = runtime.getTurn(turnId);
    expect(state?.status).toBe("cancelled");
  });
});

describe("FileSystemService (in-memory)", () => {
  let tempDir: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codeforge-test-"));
    eventStore = new EventStore();
    adapter = createWorkspaceEventAdapter({
      sessionId: "test-session",
      eventStore,
      persistence: {
        appendEvent: () => {},
        upsertSession: () => {},
        upsertTurn: () => {},
        getSession: () => undefined,
        listSessions: () => [],
        getTurns: () => [],
        getWorkItems: () => [],
        getEvents: () => [],
        close: () => {},
      } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>,
    });
    fsService = createFileSystemService({
      workspaceRoot: tempDir,
      adapter,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should read a file and emit event", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "Hello world");
    const content = await fsService.readFile("test.txt");
    expect(content).toBe("Hello world");
    const events = eventStore.getAll({ sessionId: "test-session" });
    expect(events.some((e) => e.type === "file.read")).toBe(true);
  });

  it("should propose and apply a change", async () => {
    const changeId = await fsService.proposeChange("new.txt", "created", "New content");
    expect(changeId).toBeDefined();
    const pending = fsService.getPendingChange(changeId);
    expect(pending).toBeDefined();

    await fsService.applyChange(changeId);
    const content = await readFile(join(tempDir, "new.txt"), "utf-8");
    expect(content).toBe("New content");
  });

  it("should detect path traversal attempts", async () => {
    await expect(fsService.readFile("../../../etc/passwd")).rejects.toThrow("Path traversal");
  });
});

describe("CommandService", () => {
  let commandService: CommandService;
  let tempDir: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;

  beforeEach(async () => {
    commandService = createCommandService();
    tempDir = await mkdtemp(join(tmpdir(), "codeforge-command-"));
    eventStore = new EventStore();
    adapter = createWorkspaceEventAdapter({
      sessionId: "command-session",
      eventStore,
      persistence: {
        appendEvent: () => {}, upsertSession: () => {}, upsertTurn: () => {},
        getSession: () => undefined, listSessions: () => [], getTurns: () => [],
        getWorkItems: () => [], getEvents: () => [], close: () => {},
      } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("should classify safe commands", () => {
    const result = commandService.classifyCommand("ls -la");
    expect(result.risk).toBe("safe");
  });

  it("should classify high-risk commands", () => {
    const result = commandService.classifyCommand("rm -rf /");
    expect(result.risk).toBe("critical");
  });

  it("should classify build commands as moderate", () => {
    const result = commandService.classifyCommand("npm run build");
    expect(result.risk).toBe("moderate");
  });

  it("times out once, reports the timeout exit, and releases its active slot", async () => {
    const result = await commandService.execute({
      commandId: "timeout-command",
      command: "node -e \"setTimeout(()=>{},5000)\"",
      cwd: tempDir,
      timeoutMs: 100,
      adapter,
    });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(commandService.getActiveCommands()).toEqual([]);
    expect(eventStore.getAll().filter((event) => event.type === "command.completed")).toHaveLength(1);
  });

  it("settles a cancel race once and does not mutate after terminal completion", async () => {
    const pending = commandService.execute({
      commandId: "cancel-command",
      command: "node -e \"setTimeout(()=>{},5000)\"",
      cwd: tempDir,
      timeoutMs: 5_000,
      adapter,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commandService.cancel("cancel-command")).toBe(true);
    const result = await pending;
    expect(result.exitCode).toBe(130);
    expect(result.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(eventStore.getAll().filter((event) => event.type === "command.completed")).toHaveLength(1);
    expect(commandService.getActiveCommands()).toEqual([]);
  });
});

describe("ValidationService", () => {
  it("should be creatable", () => {
    const validationService = createValidationService();
    expect(validationService).toBeDefined();
  });
});

describe("CheckpointService (in-memory)", () => {
  let tempDir: string;
  let checkpointService: CheckpointService;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codeforge-test-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: tempDir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir });

    eventStore = new EventStore();
    adapter = createWorkspaceEventAdapter({
      sessionId: "test-session",
      eventStore,
      persistence: {
        appendEvent: () => {},
        upsertSession: () => {},
        upsertTurn: () => {},
        getSession: () => undefined,
        listSessions: () => [],
        getTurns: () => [],
        getWorkItems: () => [],
        getEvents: () => [],
        close: () => {},
      } as unknown as ReturnType<typeof import("@codeforge/sessions").createSessionPersistence>,
    });
    checkpointService = createCheckpointService(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should create a checkpoint", async () => {
    const checkpoint = await checkpointService.createCheckpoint({
      checkpointId: "checkpoint-1",
      label: "Test checkpoint",
      workspaceRoot: tempDir,
      adapter,
    });
    expect(checkpoint).toBeDefined();
    expect(checkpoint.label).toBe("Test checkpoint");
  });

  it("should list checkpoints", async () => {
    await checkpointService.createCheckpoint({
      checkpointId: "cp-1",
      label: "First",
      workspaceRoot: tempDir,
      adapter,
    });
    await checkpointService.createCheckpoint({
      checkpointId: "cp-2",
      label: "Second",
      workspaceRoot: tempDir,
      adapter,
    });
    const all = checkpointService.getAllCheckpoints();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
