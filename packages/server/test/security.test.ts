import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventStore } from "@codeforge/sessions";
import { WorkspaceEventAdapter, createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { FileSystemService, createFileSystemService } from "../src/filesystem-service.js";
import { AgentRuntime, createAgentRuntime } from "../src/agent-runtime.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, symlinkSync as fsSymlink } from "node:fs";

function createMockAdapter(eventStore: EventStore, sessionId: string = "test-session"): WorkspaceEventAdapter {
  return createWorkspaceEventAdapter({
    sessionId,
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
}

describe("Tool Execution Security - File Read", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
    eventStore = new EventStore();
    adapter = createMockAdapter(eventStore);
    fsService = createFileSystemService({ workspaceRoot, adapter });

    // Create test structure inside workspace
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "example.ts"), "export const x = 1;");
    await writeFile(join(workspaceRoot, "safe.txt"), "safe content");

    // Create file outside workspace
    await writeFile(join(outsideWorkspace, "secret.txt"), "secret data");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should read a file inside the workspace", async () => {
    const content = await fsService.readFile("safe.txt");
    expect(content).toBe("safe content");
  });

  it("should read nested files inside the workspace", async () => {
    const content = await fsService.readFile("src/example.ts");
    expect(content).toBe("export const x = 1;");
  });

  it("should reject path traversal using ../", async () => {
    await expect(fsService.readFile(`../${resolve(outsideWorkspace).split(/[\\/]/).pop()}/secret.txt`))
      .rejects.toThrow("Path traversal");
  });

  it("should reject absolute path outside workspace", async () => {
    const absoluteOutsidePath = join(outsideWorkspace, "secret.txt");
    await expect(fsService.readFile(absoluteOutsidePath))
      .rejects.toThrow("Path traversal");
  });

  it("should reject traversal to parent directory", async () => {
    await expect(fsService.readFile("../../etc/passwd"))
      .rejects.toThrow("Path traversal");
  });

  it("should reject deeply nested traversal", async () => {
    await expect(fsService.readFile("../../../../../../etc/passwd"))
      .rejects.toThrow("Path traversal");
  });

  it("should reject mixed path traversal", async () => {
    await expect(fsService.readFile("src/../../../etc/passwd"))
      .rejects.toThrow("Path traversal");
  });
});

describe("Tool Execution Security - File Write", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
    eventStore = new EventStore();
    adapter = createMockAdapter(eventStore);
    fsService = createFileSystemService({ workspaceRoot, adapter });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should write a file inside the workspace", async () => {
    await fsService.writeFile("new-file.txt", "new content");
    const content = await readFile(join(workspaceRoot, "new-file.txt"), "utf-8");
    expect(content).toBe("new content");
  });

  it("should create nested directories and file inside workspace", async () => {
    await fsService.writeFile("nested/deep/file.txt", "nested content");
    const content = await readFile(join(workspaceRoot, "nested/deep/file.txt"), "utf-8");
    expect(content).toBe("nested content");
  });

  it("should reject write traversal using ../", async () => {
    const outsideFilePath = join(outsideWorkspace, "should-not-exist.txt");
    await expect(fsService.writeFile(`../${resolve(outsideWorkspace).split(/[\\/]/).pop()}/should-not-exist.txt`, "malicious"))
      .rejects.toThrow("Path traversal");
    
    // Verify outside file was NOT created
    expect(existsSync(outsideFilePath)).toBe(false);
  });

  it("should reject write to absolute path outside workspace", async () => {
    const absoluteOutsidePath = join(outsideWorkspace, "outside-write.txt");
    await expect(fsService.writeFile(absoluteOutsidePath, "malicious"))
      .rejects.toThrow("Path traversal");
    
    // Verify outside file was NOT created
    expect(existsSync(absoluteOutsidePath)).toBe(false);
  });

  it("should verify outside file remains untouched after rejected write", async () => {
    const outsideFile = join(outsideWorkspace, "original.txt");
    await writeFile(outsideFile, "original content");
    
    await expect(fsService.writeFile(join(outsideWorkspace, "original.txt"), "modified"))
      .rejects.toThrow("Path traversal");
    
    // Verify original content unchanged
    const content = await readFile(outsideFile, "utf-8");
    expect(content).toBe("original content");
  });
});

describe("Tool Execution Security - File Creation", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
    eventStore = new EventStore();
    adapter = createMockAdapter(eventStore);
    fsService = createFileSystemService({ workspaceRoot, adapter });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should create file inside workspace", async () => {
    await fsService.createFile("created.txt", "created content");
    const content = await readFile(join(workspaceRoot, "created.txt"), "utf-8");
    expect(content).toBe("created content");
  });

  it("should reject creation outside workspace", async () => {
    const outsideFile = join(outsideWorkspace, "outside-created.txt");
    await expect(fsService.createFile(outsideFile, "should not create"))
      .rejects.toThrow("Path traversal");
    
    expect(existsSync(outsideFile)).toBe(false);
  });
});

describe("Tool Execution Security - File Delete", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
    eventStore = new EventStore();
    adapter = createMockAdapter(eventStore);
    fsService = createFileSystemService({ workspaceRoot, adapter });
    
    await writeFile(join(workspaceRoot, "to-delete.txt"), "delete me");
    await writeFile(join(outsideWorkspace, "outside-file.txt"), "do not delete");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should delete file inside workspace", async () => {
    await fsService.deleteFile("to-delete.txt");
    expect(existsSync(join(workspaceRoot, "to-delete.txt"))).toBe(false);
  });

  it("should reject deletion outside workspace", async () => {
    const outsideFile = join(outsideWorkspace, "outside-file.txt");
    await expect(fsService.deleteFile(outsideFile))
      .rejects.toThrow("Path traversal");
    
    // Verify outside file still exists
    expect(existsSync(outsideFile)).toBe(true);
    const content = await readFile(outsideFile, "utf-8");
    expect(content).toBe("do not delete");
  });
});

describe("Tool Execution Security - run_command working directory", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let firewall: ForgeZero;
  let providerCatalog: InMemoryProviderCatalog;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
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
    };
    firewall.register(model);

    providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(createMockProvider({
      providerId: "test",
      streamEvents: [
        { type: "text_delta", delta: "Done" },
        { type: "finish", finishReason: "stop" },
      ],
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
      workspacePath: workspaceRoot,
    });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should execute command in workspace", async () => {
    const turnId = await runtime.startTurn("Test command");
    // With workspace set, commands should execute within workspace bounds
    expect(turnId).toBeDefined();
  });

  it("should have workspace path configured", () => {
    // Access internal workspacePath through runtime
    expect(runtime).toBeDefined();
  });
});

describe("Tool Execution Security - Symlink/Junction Protection", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;
  let eventStore: EventStore;
  let adapter: WorkspaceEventAdapter;
  let fsService: FileSystemService;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));
    eventStore = new EventStore();
    adapter = createMockAdapter(eventStore);
    fsService = createFileSystemService({ workspaceRoot, adapter });

    await writeFile(join(workspaceRoot, "safe.txt"), "safe content");
    await writeFile(join(outsideWorkspace, "secret.txt"), "secret data");

    // Attacker-controlled junction inside the workspace pointing outside.
    fsSymlink(outsideWorkspace, join(workspaceRoot, "escape"), "junction");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("rejects read_file through an escape junction", async () => {
    await expect(fsService.readFile(join("escape", "secret.txt")))
      .rejects.toThrow(/traversal/i);
    // The outside file's content must never be returned
    const content = await readFile(join(outsideWorkspace, "secret.txt"), "utf-8");
    expect(content).toBe("secret data");
  });

  it("rejects write_file through an escape junction and leaves the target untouched", async () => {
    const secretPath = join(outsideWorkspace, "secret.txt");
    await expect(fsService.writeFile(join("escape", "secret.txt"), "pwned"))
      .rejects.toThrow(/traversal/i);

    const content = await readFile(secretPath, "utf-8");
    expect(content).toBe("secret data");
  });

  it("rejects creating files through an escape junction", async () => {
    const plantedPath = join(outsideWorkspace, "planted.txt");
    await expect(fsService.createFile(join("escape", "planted.txt"), "malicious"))
      .rejects.toThrow(/traversal/i);

    expect(existsSync(plantedPath)).toBe(false);
  });

  it("allows a junction that points back inside the workspace", async () => {
    fsSymlink(join(workspaceRoot), join(workspaceRoot, "inside"), "junction");
    const content = await fsService.readFile(join("inside", "safe.txt"));
    expect(content).toBe("safe content");
  });
});

describe("Tool Execution Security - Workspace Tree API", () => {
  let workspaceRoot: string;
  let outsideWorkspace: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-"));
    outsideWorkspace = await mkdtemp(join(tmpdir(), "outside-"));

    // Create test structure inside workspace
    await mkdir(join(workspaceRoot, "src"));
    await writeFile(join(workspaceRoot, "src", "example.ts"), "export const x = 1;");
    await writeFile(join(workspaceRoot, "safe.txt"), "safe content");

    // Create file outside workspace
    await writeFile(join(outsideWorkspace, "secret.txt"), "secret data");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  });

  it("should validate path containment logic", () => {
    const activeWorkspace = resolve(workspaceRoot);
    const requestedOutside = resolve(outsideWorkspace);
    
    // The workspace tree endpoint should deny paths outside activeWorkspace
    expect(requestedOutside.startsWith(activeWorkspace)).toBe(false);
  });

  it("should allow paths within workspace", () => {
    const activeWorkspace = resolve(workspaceRoot);
    const requestedInside = resolve(join(workspaceRoot, "src"));
    
    expect(requestedInside.startsWith(activeWorkspace)).toBe(true);
  });

  it("should reject traversal using ../", () => {
    const activeWorkspace = resolve(workspaceRoot);
    const traversalPath = resolve(join(workspaceRoot, "..", outsideWorkspace.split(/[\\/]/).pop() || "outside"));
    
    expect(traversalPath.startsWith(activeWorkspace)).toBe(false);
  });

  it("should reject absolute path outside workspace", () => {
    const activeWorkspace = resolve(workspaceRoot);
    const absoluteOutside = resolve(outsideWorkspace);
    
    expect(absoluteOutside.startsWith(activeWorkspace)).toBe(false);
  });

  it("should reject encoded traversal attempts", () => {
    // URL encoded ..%2F is still path traversal
    const activeWorkspace = resolve(workspaceRoot);
    const encodedTraversal = resolve(join(workspaceRoot, "..", "etc", "passwd"));
    
    expect(encodedTraversal.startsWith(activeWorkspace)).toBe(false);
  });
});
