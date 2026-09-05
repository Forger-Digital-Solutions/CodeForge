import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { createWorkspaceService, WorkspaceService, validateSafeBranchName } from "../src/workspace-service.js";
import { createCheckpointService } from "../src/checkpoint-service.js";
import { createSessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

describe("ForgeWorkspaces — Structured Identity, Leases & Git Worktrees", () => {
  let parentRepo: string;
  let worktreeBaseDir: string;
  let dbDir: string;
  let dbFile: string;

  beforeEach(async () => {
    parentRepo = await mkdtemp(join(tmpdir(), "cf-ws-parent-"));
    worktreeBaseDir = await mkdtemp(join(tmpdir(), "cf-ws-worktrees-"));
    dbDir = await mkdtemp(join(tmpdir(), "cf-ws-db-"));
    dbFile = join(dbDir, "sessions.db");

    // Initialize git repository in parentRepo
    await execFile("git", ["init"], { cwd: parentRepo });
    await execFile("git", ["config", "user.name", "CodeForge Tester"], { cwd: parentRepo });
    await execFile("git", ["config", "user.email", "test@codeforge.ai"], { cwd: parentRepo });
    await execFile("git", ["config", "commit.gpgsign", "false"], { cwd: parentRepo });
    await execFile("git", ["config", "core.autocrlf", "false"], { cwd: parentRepo });
    await execFile("git", ["config", "core.eol", "lf"], { cwd: parentRepo });

    await writeFile(join(parentRepo, "src.ts"), "export const val = 1;\n");
    await execFile("git", ["add", "."], { cwd: parentRepo });
    await execFile("git", ["commit", "-m", "initial commit"], { cwd: parentRepo });
  });

  afterEach(async () => {
    await rm(parentRepo, { recursive: true, force: true });
    await rm(worktreeBaseDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("validates safe branch names and rejects injection attempts", () => {
    expect(validateSafeBranchName("codeforge/worktree/run1-abc")).toBe(true);
    expect(validateSafeBranchName("feature/isolated-task_123")).toBe(true);

    // Injections
    expect(validateSafeBranchName("branch..name")).toBe(false);
    expect(validateSafeBranchName("branch~1")).toBe(false);
    expect(validateSafeBranchName("branch^2")).toBe(false);
    expect(validateSafeBranchName("branch:name")).toBe(false);
    expect(validateSafeBranchName("branch?name")).toBe(false);
    expect(validateSafeBranchName("branch*name")).toBe(false);
    expect(validateSafeBranchName("branch[name]")).toBe(false);
    expect(validateSafeBranchName("branch with spaces")).toBe(false);
    expect(validateSafeBranchName("/leading-slash")).toBe(false);
    expect(validateSafeBranchName("trailing-slash/")).toBe(false);
    expect(validateSafeBranchName("double//slash")).toBe(false);
    expect(validateSafeBranchName("test.lock")).toBe(false);
  });

  it("registers local workspace and canonicalizes paths and aliases", async () => {
    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });
    const ws1 = await wsService.registerLocalWorkspace(parentRepo);

    expect(ws1.kind).toBe("local");
    expect(ws1.repositoryRoot).toBeDefined();
    expect(ws1.status).toBe("ready");

    // Path alias (e.g. parentRepo + "/.") resolves to the same workspace identity
    const ws2 = await wsService.registerLocalWorkspace(join(parentRepo, "."));
    expect(ws2.id).toBe(ws1.id);
  });

  it("enforces conventional Read/Write ownership and writer exclusivity", () => {
    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });

    // 1. Writer A acquires lease
    const leaseA = wsService.acquireLease(parentRepo, "run-writer-A", "write");
    expect(leaseA.mode).toBe("write");
    expect(leaseA.runId).toBe("run-writer-A");

    // 2. Competing Writer B rejected
    expect(() => wsService.acquireLease(parentRepo, "run-writer-B", "write")).toThrow(
      /WORKSPACE_LEASE_CONFLICT/,
    );

    // 3. Competing Reader C rejected while writer active
    expect(() => wsService.acquireLease(parentRepo, "run-reader-C", "read")).toThrow(
      /WORKSPACE_LEASE_CONFLICT/,
    );

    // 4. Wrong-owner release attempt rejected
    expect(() => wsService.releaseLease(leaseA.leaseId, "run-impostor")).toThrow(
      /WORKSPACE_LEASE_PERMISSION_DENIED/,
    );

    // 5. Writer A releases lease
    const released = wsService.releaseLease(leaseA.leaseId, "run-writer-A");
    expect(released).toBe(true);

    // 6. Multiple concurrent readers now succeed
    const read1 = wsService.acquireLease(parentRepo, "run-reader-1", "read");
    const read2 = wsService.acquireLease(parentRepo, "run-reader-2", "read");
    expect(read1.mode).toBe("read");
    expect(read2.mode).toBe("read");

    // 7. Writer rejected while readers active
    expect(() => wsService.acquireLease(parentRepo, "run-writer-C", "write")).toThrow(
      /WORKSPACE_LEASE_CONFLICT/,
    );

    // Clean up readers
    wsService.releaseLease(read1.leaseId);
    wsService.releaseLease(read2.leaseId);
  });

  it("handles atomic lease acquisition contention with 20 simultaneous write requests", () => {
    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });

    let successCount = 0;
    let conflictCount = 0;

    for (let i = 0; i < 20; i++) {
      try {
        wsService.acquireLease(parentRepo, `run-${i}`, "write");
        successCount++;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "WORKSPACE_LEASE_CONFLICT") {
          conflictCount++;
        }
      }
    }

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(19);
  });

  it("creates isolated Git worktree from HEAD without altering parent workspace state", async () => {
    // Modify parent file to make parent dirty
    await writeFile(join(parentRepo, "parent_untracked.txt"), "parent content\n");
    const { stdout: parentStatusBefore } = await execFile("git", ["status", "--porcelain=v2"], { cwd: parentRepo });
    const { stdout: parentHeadBefore } = await execFile("git", ["rev-parse", "HEAD"], { cwd: parentRepo });

    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });
    const parentWs = await wsService.registerLocalWorkspace(parentRepo);

    // Create isolated worktree
    const worktree = await wsService.createWorktree({
      parentWorkspaceId: parentWs.id,
      base: "head",
      runId: "run-001",
    });

    expect(worktree.kind).toBe("git-worktree");
    expect(worktree.status).toBe("ready");
    expect(worktree.rootPath).not.toContain(parentRepo);

    // Verify parent state is 100% UNTOUCHED
    const { stdout: parentStatusAfter } = await execFile("git", ["status", "--porcelain=v2"], { cwd: parentRepo });
    const { stdout: parentHeadAfter } = await execFile("git", ["rev-parse", "HEAD"], { cwd: parentRepo });
    expect(parentStatusAfter).toBe(parentStatusBefore);
    expect(parentHeadAfter).toBe(parentHeadBefore);

    // Modify file inside isolated worktree
    await writeFile(join(worktree.rootPath, "src.ts"), "export const val = 999;\n");
    expect(await readFile(join(worktree.rootPath, "src.ts"), "utf-8")).toBe("export const val = 999;\n");

    // Parent file remains untouched!
    expect(await readFile(join(parentRepo, "src.ts"), "utf-8")).toBe("export const val = 1;\n");

    // Independent write leases: worktree and parent can be written concurrently
    const parentLease = wsService.acquireLease(parentRepo, "run-parent", "write");
    const worktreeLease = wsService.acquireLease(worktree.rootPath, "run-child", "write");
    expect(parentLease).toBeDefined();
    expect(worktreeLease).toBeDefined();

    wsService.releaseLease(parentLease.leaseId);
    wsService.releaseLease(worktreeLease.leaseId);
  });

  it("creates isolated Git worktree from Checkpoint and materializes exact development snapshot", async () => {
    // Setup dirty + staged state in parent repo
    await writeFile(join(parentRepo, "src.ts"), "export const val = 42;\n");
    await execFile("git", ["add", "src.ts"], { cwd: parentRepo });
    await writeFile(join(parentRepo, "src.ts"), "export const val = 100;\n");
    await writeFile(join(parentRepo, "new_file.txt"), "staged new\n");
    await execFile("git", ["add", "new_file.txt"], { cwd: parentRepo });
    await writeFile(join(parentRepo, "untracked.txt"), "untracked data\n");

    const checkpointSvc = createCheckpointService(parentRepo);
    const chk = await checkpointSvc.createCheckpoint({
      checkpointId: "chk-wt-001",
      label: "Worktree base snapshot",
    });

    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });
    const parentWs = await wsService.registerLocalWorkspace(parentRepo);

    // Create worktree from checkpoint
    const worktree = await wsService.createWorktree({
      parentWorkspaceId: parentWs.id,
      base: "checkpoint",
      checkpointId: "chk-wt-001",
      runId: "run-chk-test",
    });

    expect(worktree.baseKind).toBe("checkpoint");
    expect(worktree.checkpointId).toBe("chk-wt-001");

    // Check materialized files in child worktree
    expect(await readFile(join(worktree.rootPath, "src.ts"), "utf-8")).toBe("export const val = 100;\n");
    expect(await readFile(join(worktree.rootPath, "new_file.txt"), "utf-8")).toBe("staged new\n");
    expect(await readFile(join(worktree.rootPath, "untracked.txt"), "utf-8")).toBe("untracked data\n");
  });

  it("handles worktree cleanup with preservation-first policy", async () => {
    const wsService = createWorkspaceService({ worktreeParentDir: worktreeBaseDir });
    const parentWs = await wsService.registerLocalWorkspace(parentRepo);

    // 1. Dirty worktree cleanup without force -> retained_dirty (NO deletion)
    const wt1 = await wsService.createWorktree({
      parentWorkspaceId: parentWs.id,
      runId: "run-dirty",
    });
    await writeFile(join(wt1.rootPath, "dirty_work.txt"), "important work\n");

    const cleanResult1 = await wsService.releaseWorktree(wt1.id, false);
    expect(cleanResult1.cleaned).toBe(false);
    expect(cleanResult1.status).toBe("retained_dirty");

    // 2. Clean worktree with NO new commits -> safe removal and branch deletion
    const wt2 = await wsService.createWorktree({
      parentWorkspaceId: parentWs.id,
      runId: "run-clean",
    });
    const cleanResult2 = await wsService.releaseWorktree(wt2.id, false);
    expect(cleanResult2.cleaned).toBe(true);
    expect(cleanResult2.status).toBe("cleaned");
    expect(cleanResult2.branchPreserved).toBe(false);

    // 3. Worktree with autonomous commits ahead of base -> removes directory but PRESERVES result Git branch!
    const wt3 = await wsService.createWorktree({
      parentWorkspaceId: parentWs.id,
      runId: "run-committed",
    });
    await writeFile(join(wt3.rootPath, "src.ts"), "export const committed = true;\n");
    await execFile("git", ["add", "."], { cwd: wt3.rootPath });
    await execFile("git", ["commit", "-m", "autonomous implementation commit"], { cwd: wt3.rootPath });

    const cleanResult3 = await wsService.releaseWorktree(wt3.id, false);
    expect(cleanResult3.cleaned).toBe(true);
    expect(cleanResult3.status).toBe("released");
    expect(cleanResult3.branchPreserved).toBe(true);

    // Verify branch still exists in parent repo and points to the commit!
    const { stdout: branchSha } = await execFile("git", ["rev-parse", wt3.branch!], { cwd: parentRepo });
    expect(branchSha.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rehydrates persisted workspaces and detects missing or orphaned worktrees on restart", async () => {
    const persistenceA = createSessionPersistence({ dbPath: dbFile });
    const wsServiceA = createWorkspaceService({
      persistence: persistenceA,
      worktreeParentDir: worktreeBaseDir,
    });

    const parentWs = await wsServiceA.registerLocalWorkspace(parentRepo);
    const wt = await wsServiceA.createWorktree({
      parentWorkspaceId: parentWs.id,
      runId: "run-restart-test",
    });

    persistenceA.close();

    // Re-open with new persistence B and new workspace service B
    const persistenceB = createSessionPersistence({ dbPath: dbFile });
    const wsServiceB = createWorkspaceService({
      persistence: persistenceB,
      worktreeParentDir: worktreeBaseDir,
    });

    const recoveredParent = wsServiceB.getWorkspace(parentWs.id);
    expect(recoveredParent).toBeDefined();
    expect(recoveredParent?.kind).toBe("local");

    const recoveredWt = wsServiceB.getWorkspace(wt.id);
    expect(recoveredWt).toBeDefined();
    expect(recoveredWt?.kind).toBe("git-worktree");
    expect(recoveredWt?.status).toBe("ready");

    persistenceB.close();
  });
});
