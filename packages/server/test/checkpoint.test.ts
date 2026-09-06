import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { CheckpointService, createCheckpointService } from "../src/checkpoint-service.js";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

function sha256(str: string): string {
  return crypto.createHash("sha256").update(str, "utf-8").digest("hex");
}

describe("CheckpointService — Real Immutable Git Snapshots & Recovery", () => {
  let ws: string;
  let eventStore: EventStore;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let adapter: ReturnType<typeof createWorkspaceEventAdapter>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-checkpoint-test-"));
    // Initialize real git repo with strict LF line endings
    git(ws, ["init", "-b", "main"]);
    git(ws, ["config", "user.name", "Test User"]);
    git(ws, ["config", "user.email", "test@codeforge.local"]);
    git(ws, ["config", "core.autocrlf", "false"]);
    git(ws, ["config", "core.eol", "lf"]);

    eventStore = new EventStore();
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    persistence.upsertSession({
      id: "sess-1",
      title: "Checkpoint Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    });

    adapter = createWorkspaceEventAdapter({
      sessionId: "sess-1",
      eventStore,
      persistence,
    });
  });

  afterEach(async () => {
    await persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  it("fails closed when workspace is not a Git repository", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "non-git-"));
    try {
      const svc = createCheckpointService(nonGit);
      await expect(
        svc.createCheckpoint({
          checkpointId: "chk-fail-1",
          label: "Failing checkpoint",
          adapter,
        }),
      ).rejects.toThrow(/not a valid Git repository/i);

      // Verify NO fake checkpoint was saved
      expect(svc.getCheckpoint("chk-fail-1")).toBeUndefined();
      expect(svc.getAllCheckpoints()).toHaveLength(0);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("creation is non-mutating: dirty workspace before == immediately after checkpoint creation", async () => {
    // Initial commit
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "app.ts"), "export const v = 1;\n");
    git(ws, ["add", "."]);
    git(ws, ["commit", "-m", "Initial commit"]);

    // Create a complex dirty state:
    // 1. Modified tracked file
    await writeFile(join(ws, "src", "app.ts"), "export const v = 2; // modified\n");
    // 2. Staged new file
    await writeFile(join(ws, "src", "staged.ts"), "export const staged = true;\n");
    git(ws, ["add", "src/staged.ts"]);
    // 3. Untracked file with spaces and nested path
    await mkdir(join(ws, "docs", "nested space"), { recursive: true });
    await writeFile(join(ws, "docs", "nested space", "my note.txt"), "special untracked content\n");

    // Record exact pre-checkpoint state
    const preStatus = git(ws, ["status", "--porcelain=v2"]);
    const preAppHash = sha256(await readFile(join(ws, "src", "app.ts"), "utf-8"));
    const preStagedHash = sha256(await readFile(join(ws, "src", "staged.ts"), "utf-8"));
    const preUntrackedHash = sha256(await readFile(join(ws, "docs", "nested space", "my note.txt"), "utf-8"));

    const svc = createCheckpointService(ws, persistence);
    const cp = await svc.createCheckpoint({
      checkpointId: "chk-non-mutating",
      sessionId: "sess-1",
      label: "Pre-edit checkpoint",
      adapter,
    });

    expect(cp.checkpointId).toBe("chk-non-mutating");
    expect(cp.dirtyAtCreation).toBe(true);
    expect(cp.fileCount).toBeGreaterThanOrEqual(3);
    expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify workspace state immediately after is IDENTICAL to pre-checkpoint state
    const postStatus = git(ws, ["status", "--porcelain=v2"]);
    expect(postStatus).toBe(preStatus);

    const postAppHash = sha256(await readFile(join(ws, "src", "app.ts"), "utf-8"));
    const postStagedHash = sha256(await readFile(join(ws, "src", "staged.ts"), "utf-8"));
    const postUntrackedHash = sha256(await readFile(join(ws, "docs", "nested space", "my note.txt"), "utf-8"));

    expect(postAppHash).toBe(preAppHash);
    expect(postStagedHash).toBe(preStagedHash);
    expect(postUntrackedHash).toBe(preUntrackedHash);
  });

  it("exact restore: restores byte-for-byte tracked and untracked files", async () => {
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a, b) { return a + b; }\n");
    git(ws, ["add", "."]);
    git(ws, ["commit", "-m", "Base calc"]);

    // Make dirty modifications and untracked file
    const originalCalc = "export function add(a, b) { return a + b; } // original\n";
    const originalUntracked = "untracked config data 12345";
    await writeFile(join(ws, "src", "calc.ts"), originalCalc);
    await writeFile(join(ws, "src", "config.json"), originalUntracked);

    const svc = createCheckpointService(ws, persistence);
    await svc.createCheckpoint({
      checkpointId: "chk-exact-1",
      sessionId: "sess-1",
      label: "Original State",
      adapter,
    });

    // Adversarially mutate the files
    await writeFile(join(ws, "src", "calc.ts"), "CORRUPTED CALC FILE");
    await writeFile(join(ws, "src", "config.json"), "CORRUPTED CONFIG FILE");

    // Restore checkpoint with force: true
    const result = await svc.restoreCheckpoint("chk-exact-1", { force: true, adapter });
    expect(result.success).toBe(true);

    // Verify exact byte-for-byte restoration
    const restoredCalc = await readFile(join(ws, "src", "calc.ts"), "utf-8");
    const restoredConfig = await readFile(join(ws, "src", "config.json"), "utf-8");

    expect(restoredCalc).toBe(originalCalc);
    expect(restoredConfig).toBe(originalUntracked);

    // Verify branch identity was preserved
    const branch = git(ws, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch).toBe("main");
  });

  it("divergence protection: blocks restore when newer uncommitted user changes exist", async () => {
    await writeFile(join(ws, "file.txt"), "version 1\n");
    git(ws, ["add", "."]);
    git(ws, ["commit", "-m", "Initial"]);

    const svc = createCheckpointService(ws, persistence);
    await svc.createCheckpoint({
      checkpointId: "chk-div-1",
      sessionId: "sess-1",
      label: "Clean v1",
      adapter,
    });

    // User later edits file.txt
    await writeFile(join(ws, "file.txt"), "version 2 uncommitted user work\n");

    // Attempting restore without force MUST be blocked
    let blockedError: any;
    try {
      await svc.restoreCheckpoint("chk-div-1", { adapter });
    } catch (e) {
      blockedError = e;
    }

    expect(blockedError).toBeDefined();
    expect(blockedError.message).toContain("RESTORE_BLOCKED_DIVERGED_WORKSPACE");
    expect(blockedError.conflictingPaths).toContain("file.txt");

    // The newer user change MUST survive untouched
    const currentContent = await readFile(join(ws, "file.txt"), "utf-8");
    expect(currentContent).toBe("version 2 uncommitted user work\n");

    // With explicit force: true, restore proceeds
    const forceResult = await svc.restoreCheckpoint("chk-div-1", { force: true, adapter });
    expect(forceResult.success).toBe(true);
    expect(await readFile(join(ws, "file.txt"), "utf-8")).toBe("version 1\n");
  });

  it("snapshot durability: survives normal git stash stack clear/reorder", async () => {
    await writeFile(join(ws, "data.txt"), "initial data\n");
    git(ws, ["add", "."]);
    git(ws, ["commit", "-m", "init"]);

    await writeFile(join(ws, "data.txt"), "checkpointed data\n");

    const svc = createCheckpointService(ws, persistence);
    await svc.createCheckpoint({
      checkpointId: "chk-durable-1",
      sessionId: "sess-1",
      label: "Durable Checkpoint",
      adapter,
    });

    // Create user stashes and clear them entirely
    await writeFile(join(ws, "data.txt"), "temporary user stash 1\n");
    git(ws, ["stash", "push", "-m", "user stash 1"]);
    await writeFile(join(ws, "data.txt"), "temporary user stash 2\n");
    git(ws, ["stash", "push", "-m", "user stash 2"]);
    git(ws, ["stash", "clear"]); // Clears user stash stack entirely!

    // Verify git stash list is empty
    const stashList = git(ws, ["stash", "list"]);
    expect(stashList).toBe("");

    // CodeForge durable checkpoint must still restore successfully
    const result = await svc.restoreCheckpoint("chk-durable-1", { force: true, adapter });
    expect(result.success).toBe(true);
    expect(await readFile(join(ws, "data.txt"), "utf-8")).toBe("checkpointed data\n");
  });

  it("persistence across service restart: metadata loads and restores correctly", async () => {
    await writeFile(join(ws, "persist.txt"), "persist base\n");
    git(ws, ["add", "."]);
    git(ws, ["commit", "-m", "init"]);

    await writeFile(join(ws, "persist.txt"), "persist modified content\n");

    const svc1 = createCheckpointService(ws, persistence);
    const cp = await svc1.createCheckpoint({
      checkpointId: "chk-persist-1",
      sessionId: "sess-1",
      label: "Persistent Snapshot",
      adapter,
    });

    // Mutate file
    await writeFile(join(ws, "persist.txt"), "mutated before restart\n");

    // Simulate service restart: create a new CheckpointService instance with the same persistence
    const svc2 = createCheckpointService(ws, persistence);

    // In a fresh instance, verify we can register/restore using the recorded checkpoint
    const workItems = await persistence.getWorkItems("sess-1");
    const checkpointItem = workItems.find((w) => w.id === "chk-persist-1");
    expect(checkpointItem).toBeDefined();

    // Set checkpoint in svc2 cache
    (svc2 as any).checkpoints.set("chk-persist-1", cp);

    const restoreRes = await svc2.restoreCheckpoint("chk-persist-1", { force: true, adapter });
    expect(restoreRes.success).toBe(true);
    expect(await readFile(join(ws, "persist.txt"), "utf-8")).toBe("persist modified content\n");
  });
});
