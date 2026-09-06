import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ISessionPersistence } from "@codeforge/sessions";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { CheckpointService } from "./checkpoint-service.js";

const execFile = promisify(execFileCallback);

export type WorkspaceKind = "local" | "git-worktree";
export type WorkspaceStatus = "ready" | "locked" | "retained_dirty" | "orphaned" | "released" | "cleaned" | "missing";
export type WorkspaceLeaseMode = "read" | "write";

export interface ForgeWorkspace {
  id: string;
  kind: WorkspaceKind;
  rootPath: string;
  repositoryRoot: string;
  gitCommonDir?: string;
  branch?: string;
  headSha?: string;
  baseKind?: "head" | "checkpoint";
  baseRef?: string;
  checkpointId?: string;
  parentWorkspaceId?: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceLease {
  leaseId: string;
  workspaceId: string;
  canonicalKey: string;
  runId: string;
  mode: WorkspaceLeaseMode;
  createdAt: Date;
}

export interface CreateWorktreeOptions {
  parentWorkspaceId: string;
  base?: "head" | "checkpoint";
  checkpointId?: string;
  runId?: string;
  label?: string;
  /** CodeForge-owned namespace only; callers cannot provide arbitrary Git refs. */
  branchNamespace?: "workstream" | "delivery";
  metadata?: Record<string, unknown>;
}

export interface WorkspaceServiceOptions {
  persistence?: ISessionPersistence;
  worktreeParentDir?: string;
  checkpointServiceFactory?: (workspaceRoot: string) => CheckpointService;
}

/**
 * Validate that a branch name is safe and contains no Git ref injection characters.
 */
export function validateSafeBranchName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.length > 200) return false;
  // Ref rules: no .., ~, ^, :, ?, *, [, \, space, control chars, cannot start/end with /
  if (/(\.\.|[~^:?*\[\]\\\s]|\/\/|^\/|\/$)/.test(name)) return false;
  // Cannot contain consecutive slashes or end with .lock
  if (name.includes("//") || name.endsWith(".lock")) return false;
  return true;
}

/**
 * Canonicalize and resolve a workspace path to a stable identifier key.
 */
export function getCanonicalWorkspacePath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export class WorkspaceService {
  private readonly persistence?: ISessionPersistence;
  private readonly worktreeBaseDir: string;
  private readonly checkpointServiceFactory: (workspaceRoot: string) => CheckpointService;

  private readonly workspaces: Map<string, ForgeWorkspace> = new Map();
  private readonly pathToWorkspaceId: Map<string, string> = new Map();
  private readonly activeLeases: Map<string, WorkspaceLease> = new Map(); // leaseId -> Lease
  private readonly keyToLeases: Map<string, Set<string>> = new Map(); // canonicalKey -> Set<leaseId>

  constructor(options: WorkspaceServiceOptions = {}) {
    this.persistence = options.persistence;
    this.checkpointServiceFactory =
      options.checkpointServiceFactory ?? ((root) => new CheckpointService(root, this.persistence));

    if (options.worktreeParentDir) {
      this.worktreeBaseDir = path.resolve(options.worktreeParentDir);
    } else {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData && process.platform === "win32") {
        this.worktreeBaseDir = path.join(localAppData, "CodeForge", "worktrees");
      } else {
        this.worktreeBaseDir = path.join(os.tmpdir(), "codeforge-worktrees");
      }
    }

    if (!existsSync(this.worktreeBaseDir)) {
      mkdirSync(this.worktreeBaseDir, { recursive: true });
    }

    if (this.persistence) {
      this.loadPersistedWorkspaces().catch(() => {});
    }
  }

  /** Must be awaited to guarantee persisted workspaces are visible to synchronous getters. */
  async init(): Promise<void> {
    await this.loadPersistedWorkspaces();
  }

  /**
   * Register or discover a local workspace directory.
   */
  async registerLocalWorkspace(rawPath: string, metadata?: Record<string, unknown>): Promise<ForgeWorkspace> {
    const canonicalPath = getCanonicalWorkspacePath(rawPath);
    if (!existsSync(canonicalPath)) {
      throw new Error(`Workspace path does not exist: ${rawPath}`);
    }

    const stat = await fs.stat(canonicalPath);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${rawPath}`);
    }

    // Inspect git repository details
    const gitInfo = await this.inspectGitDetails(canonicalPath);
    const repoRoot = gitInfo.repositoryRoot;
    const canonicalRepoRoot = getCanonicalWorkspacePath(repoRoot);

    // Look for existing registered workspace for this canonical root
    const existingId = this.pathToWorkspaceId.get(canonicalPath) || this.pathToWorkspaceId.get(canonicalRepoRoot);
    if (existingId && this.workspaces.has(existingId)) {
      const existing = this.workspaces.get(existingId)!;
      existing.branch = gitInfo.branch;
      existing.headSha = gitInfo.headSha;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const id = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const workspace: ForgeWorkspace = {
      id,
      kind: "local",
      rootPath: canonicalPath,
      repositoryRoot: canonicalRepoRoot,
      gitCommonDir: gitInfo.gitCommonDir,
      branch: gitInfo.branch,
      headSha: gitInfo.headSha,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.workspaces.set(id, workspace);
    this.pathToWorkspaceId.set(canonicalPath, id);
    this.pathToWorkspaceId.set(canonicalRepoRoot, id);

    this.persistWorkspace(workspace);
    return workspace;
  }

  /**
   * Synchronously and atomically acquire a reader or writer lease for a workspace.
   * Enforces conventional Read/Write ownership:
   * - READ: multiple concurrent readers allowed, NO writer.
   * - WRITE: exactly ONE writer, NO readers, NO second writer.
   */
  acquireLease(workspaceIdOrPath: string, runId: string, mode: WorkspaceLeaseMode): WorkspaceLease {
    if (!workspaceIdOrPath) {
      throw new Error("workspaceIdOrPath is required");
    }
    if (!runId) {
      throw new Error("runId is required");
    }

    // Resolve workspace and canonical identity key
    let canonicalKey: string;
    let workspaceId: string;

    if (this.workspaces.has(workspaceIdOrPath)) {
      const ws = this.workspaces.get(workspaceIdOrPath)!;
      workspaceId = ws.id;
      // A Git worktree is an independent writable checkout.  Leasing the common repository root
      // here serialized all workstreams and made a nominally parallel run physically sequential.
      canonicalKey = ws.kind === "git-worktree" ? getCanonicalWorkspacePath(ws.rootPath) : (ws.repositoryRoot || ws.rootPath);
    } else {
      canonicalKey = getCanonicalWorkspacePath(workspaceIdOrPath);
      workspaceId = this.pathToWorkspaceId.get(canonicalKey) ?? workspaceIdOrPath;
    }

    const existingLeaseIds = this.keyToLeases.get(canonicalKey) ?? new Set();
    const activeForWorkspace: WorkspaceLease[] = [];
    for (const lid of existingLeaseIds) {
      const lease = this.activeLeases.get(lid);
      if (lease) activeForWorkspace.push(lease);
    }

    if (mode === "write") {
      // Writer exclusivity: conflict if ANY lease exists
      if (activeForWorkspace.length > 0) {
        const owners = activeForWorkspace.map((l) => `${l.mode} by ${l.runId}`).join(", ");
        const error = new Error(
          `WORKSPACE_LEASE_CONFLICT: Cannot acquire exclusive write lease on "${canonicalKey}". Active leases: ${owners}`,
        );
        (error as unknown as { code: string }).code = "WORKSPACE_LEASE_CONFLICT";
        throw error;
      }
    } else {
      // Reader: conflict if ANY write lease exists
      const writerLease = activeForWorkspace.find((l) => l.mode === "write");
      if (writerLease) {
        const error = new Error(
          `WORKSPACE_LEASE_CONFLICT: Cannot acquire read lease on "${canonicalKey}". Active write lease by ${writerLease.runId}`,
        );
        (error as unknown as { code: string }).code = "WORKSPACE_LEASE_CONFLICT";
        throw error;
      }
    }

    // Atomic lease creation
    const leaseId = `lease-${crypto.randomUUID()}`;
    const lease: WorkspaceLease = {
      leaseId,
      workspaceId,
      canonicalKey,
      runId,
      mode,
      createdAt: new Date(),
    };

    this.activeLeases.set(leaseId, lease);
    if (!this.keyToLeases.has(canonicalKey)) {
      this.keyToLeases.set(canonicalKey, new Set());
    }
    this.keyToLeases.get(canonicalKey)!.add(leaseId);

    return lease;
  }

  /**
   * Release a previously acquired lease. Validates owner identity.
   */
  releaseLease(leaseId: string, runId?: string): boolean {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) {
      return false;
    }

    if (runId && lease.runId !== runId) {
      const error = new Error(
        `WORKSPACE_LEASE_PERMISSION_DENIED: Run "${runId}" cannot release lease owned by "${lease.runId}"`,
      );
      (error as unknown as { code: string }).code = "WORKSPACE_LEASE_PERMISSION_DENIED";
      throw error;
    }

    this.activeLeases.delete(leaseId);
    const keySet = this.keyToLeases.get(lease.canonicalKey);
    if (keySet) {
      keySet.delete(leaseId);
      if (keySet.size === 0) {
        this.keyToLeases.delete(lease.canonicalKey);
      }
    }

    return true;
  }

  getLeasesForWorkspace(workspaceIdOrPath: string): WorkspaceLease[] {
    let canonicalKey: string;
    if (this.workspaces.has(workspaceIdOrPath)) {
      const ws = this.workspaces.get(workspaceIdOrPath)!;
      canonicalKey = ws.kind === "git-worktree" ? getCanonicalWorkspacePath(ws.rootPath) : (ws.repositoryRoot || ws.rootPath);
    } else {
      canonicalKey = getCanonicalWorkspacePath(workspaceIdOrPath);
    }

    const leaseIds = this.keyToLeases.get(canonicalKey) ?? new Set();
    const result: WorkspaceLease[] = [];
    for (const id of leaseIds) {
      const l = this.activeLeases.get(id);
      if (l) result.push(l);
    }
    return result;
  }

  /**
   * Create an isolated Git worktree workspace.
   * Worktree is created outside the parent repository directory.
   * Parent branch, HEAD, index, and untracked files remain completely untouched.
   */
  async createWorktree(options: CreateWorktreeOptions): Promise<ForgeWorkspace> {
    const { parentWorkspaceId, base = "head", checkpointId, runId, label, metadata, branchNamespace = "workstream" } = options;

    let parentWorkspace = this.workspaces.get(parentWorkspaceId);
    if (!parentWorkspace) {
      // Try registering by path
      parentWorkspace = await this.registerLocalWorkspace(parentWorkspaceId);
    }

    const repoRoot = parentWorkspace.repositoryRoot;
    const sanitizedRunId = (runId ?? "run").replace(/[^a-zA-Z0-9_-]/g, "");
    const sanitizedLabel = label ? label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) : "";
    const worktreeId = `wt-${crypto.randomUUID().slice(0, 8)}`;
    const shortId = worktreeId.replace(/^wt-/, "");

    // Deterministic safe branch name
    const branchName = branchNamespace === "delivery"
      ? `codeforge/delivery/${sanitizedRunId}-${shortId}`
      : sanitizedLabel
        ? `codeforge/workstream/${sanitizedRunId}-${sanitizedLabel}-${shortId}`
        : `codeforge/worktree/${sanitizedRunId}-${shortId}`;
    if (!validateSafeBranchName(branchName)) {
      throw new Error(`Generated branch name is invalid: ${branchName}`);
    }

    // Dedicated deterministic path OUTSIDE repository root
    const repoFolderName = path.basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
    const worktreePath = path.join(this.worktreeBaseDir, repoFolderName, worktreeId);

    // Enforce safety invariant: Worktree MUST NOT live inside parent repository root
    const canonicalWorktreePath = path.resolve(worktreePath);
    const canonicalRepoRoot = getCanonicalWorkspacePath(repoRoot);
    if (canonicalWorktreePath.startsWith(canonicalRepoRoot)) {
      throw new Error(`Invariant violation: Worktree path "${canonicalWorktreePath}" is inside parent repository root`);
    }

    if (!existsSync(path.dirname(canonicalWorktreePath))) {
      mkdirSync(path.dirname(canonicalWorktreePath), { recursive: true });
    }

    let baseCommitSha = "";
    let baseRef = "";

    if (base === "checkpoint" && checkpointId) {
      // Validate checkpoint snapshot
      const checkpointSvc = this.checkpointServiceFactory(repoRoot);
      const checkpoint = await checkpointSvc.validateCheckpointRef(checkpointId);
      baseCommitSha = checkpoint.baseHead || checkpoint.commitSha;
      baseRef = checkpoint.durableRef;

      // 1. Create worktree from base commit
      await this.gitCommand(repoRoot, ["worktree", "add", "-b", branchName, canonicalWorktreePath, baseCommitSha]);

      // 2. Materialize exact checkpoint state inside the isolated child worktree
      const childCheckpointSvc = this.checkpointServiceFactory(canonicalWorktreePath);
      // Restore the checkpoint snapshot directly into the child worktree
      await childCheckpointSvc.restoreCheckpoint(checkpointId, { force: true });
    } else {
      // Base HEAD of the *parent workspace*. When the parent is itself a worktree (a mission
      // integration branch, for example) its HEAD — not the main checkout's — is the base.
      const baseCwd = parentWorkspace.rootPath;
      const { stdout: headOut } = await this.gitCommand(baseCwd, ["rev-parse", "HEAD"]);
      baseCommitSha = headOut.trim();
      baseRef = "HEAD";

      // Create isolated worktree from that HEAD
      await this.gitCommand(baseCwd, ["worktree", "add", "-b", branchName, canonicalWorktreePath, baseCommitSha]);
    }

    const { stdout: childHead } = await this.gitCommand(canonicalWorktreePath, ["rev-parse", "HEAD"]);

    const now = new Date().toISOString();
    const worktreeWorkspace: ForgeWorkspace = {
      id: worktreeId,
      kind: "git-worktree",
      rootPath: canonicalWorktreePath,
      repositoryRoot: canonicalRepoRoot,
      gitCommonDir: parentWorkspace.gitCommonDir ?? path.join(canonicalRepoRoot, ".git"),
      branch: branchName,
      headSha: childHead.trim(),
      baseKind: base,
      baseRef,
      checkpointId,
      parentWorkspaceId: parentWorkspace.id,
      status: "ready",
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    this.workspaces.set(worktreeId, worktreeWorkspace);
    this.pathToWorkspaceId.set(canonicalWorktreePath, worktreeId);

    this.persistWorkspace(worktreeWorkspace);
    return worktreeWorkspace;
  }

  /**
   * Release and clean up a Git worktree workspace.
   * Respects result preservation:
   * - If dirty and not force -> fails closed, retains worktree (retained_dirty).
   * - If worktree contains commits ahead of base -> removes filesystem worktree but PRESERVES Git branch/ref.
   * - If completely clean with no new commits -> removes filesystem worktree and deletes temporary branch.
   */
  async releaseWorktree(
    workspaceId: string,
    force = false,
  ): Promise<{ cleaned: boolean; status: WorkspaceStatus; branchPreserved?: boolean }> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (workspace.kind !== "git-worktree") {
      throw new Error(`Cannot release local workspace ${workspaceId}`);
    }

    const worktreePath = workspace.rootPath;
    const parentRepoRoot = workspace.repositoryRoot;

    // Check if worktree directory exists
    if (!existsSync(worktreePath)) {
      workspace.status = "missing";
      this.persistWorkspace(workspace);
      return { cleaned: true, status: "missing" };
    }

    // 1. Inspect dirty status inside worktree
    const { stdout: statusOut } = await this.gitCommand(worktreePath, ["status", "--porcelain=v2"]).catch(() => ({
      stdout: "",
    }));
    const isDirty = statusOut.trim().length > 0;

    if (isDirty && !force) {
      // Fail closed: preserve unsaved uncommitted work
      workspace.status = "retained_dirty";
      workspace.updatedAt = new Date().toISOString();
      this.persistWorkspace(workspace);
      return { cleaned: false, status: "retained_dirty" };
    }

    // 2. Check if new commits were made ahead of base HEAD
    let newCommitsAhead = 0;
    if (workspace.branch) {
      try {
        const baseRef = workspace.baseRef === "HEAD" ? workspace.headSha ?? "HEAD" : workspace.baseRef ?? "HEAD";
        const { stdout: countOut } = await this.gitCommand(parentRepoRoot, [
          "rev-list",
          "--count",
          `${baseRef}..${workspace.branch}`,
        ]);
        newCommitsAhead = parseInt(countOut.trim(), 10) || 0;
      } catch {}
    }

    // 3. Remove filesystem worktree
    try {
      await this.gitCommand(parentRepoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      // Try fallback filesystem removal if git worktree remove fails
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        await this.gitCommand(parentRepoRoot, ["worktree", "prune"]);
      } catch (rmError) {
        workspace.status = "retained_dirty";
        this.persistWorkspace(workspace);
        return { cleaned: false, status: "retained_dirty" };
      }
    }

    // 4. Branch handling: Preserve branch if new autonomous commits exist!
    let branchPreserved = false;
    if (newCommitsAhead > 0 && !force) {
      branchPreserved = true;
      workspace.status = "released";
    } else if (workspace.branch) {
      // Delete temporary branch if clean / no new commits or force
      await this.gitCommand(parentRepoRoot, ["branch", "-D", workspace.branch]).catch(() => {});
      workspace.status = "cleaned";
    } else {
      workspace.status = "cleaned";
    }

    workspace.updatedAt = new Date().toISOString();
    this.persistWorkspace(workspace);

    return {
      cleaned: true,
      status: workspace.status,
      branchPreserved,
    };
  }

  getWorkspace(workspaceId: string): ForgeWorkspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  getWorkspaceByPath(rawPath: string): ForgeWorkspace | undefined {
    const canonical = getCanonicalWorkspacePath(rawPath);
    const id = this.pathToWorkspaceId.get(canonical);
    return id ? this.workspaces.get(id) : undefined;
  }

  getAllWorkspaces(): ForgeWorkspace[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * Rehydrate persisted workspaces and detect orphaned or missing worktrees across restarts.
   */
  async loadPersistedWorkspaces(): Promise<void> {
    if (!this.persistence) return;
    try {
      const items = await this.persistence.getWorkItemsByKind("workspace");
      for (const item of items) {
        if (item.kind === "workspace" && item.id) {
          const raw = item as unknown as {
            id: string;
            sessionId?: string;
            workspaceKind: WorkspaceKind;
            rootPath: string;
            repositoryRoot: string;
            gitCommonDir?: string;
            branch?: string;
            headSha?: string;
            baseKind?: "head" | "checkpoint";
            baseRef?: string;
            checkpointId?: string;
            parentWorkspaceId?: string;
            status: WorkspaceStatus;
            createdAt: string;
            updatedAt: string;
          };

          const ws: ForgeWorkspace = {
            id: raw.id,
            kind: raw.workspaceKind,
            rootPath: raw.rootPath,
            repositoryRoot: raw.repositoryRoot,
            gitCommonDir: raw.gitCommonDir,
            branch: raw.branch,
            headSha: raw.headSha,
            baseKind: raw.baseKind,
            baseRef: raw.baseRef,
            checkpointId: raw.checkpointId,
            parentWorkspaceId: raw.parentWorkspaceId,
            status: raw.status,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
          };

          // Revalidate worktree state if missing from disk
          if (ws.kind === "git-worktree") {
            if (!existsSync(ws.rootPath)) {
              ws.status = "missing";
            }
          }

          this.workspaces.set(ws.id, ws);
          this.pathToWorkspaceId.set(ws.rootPath, ws.id);
          this.pathToWorkspaceId.set(ws.repositoryRoot, ws.id);
        }
      }
    } catch {}
  }

  private persistWorkspace(workspace: ForgeWorkspace): void {
    if (!this.persistence) return;
    try {
      this.persistence.upsertWorkItem({
        kind: "workspace",
        id: workspace.id,
        workspaceKind: workspace.kind,
        rootPath: workspace.rootPath,
        repositoryRoot: workspace.repositoryRoot,
        gitCommonDir: workspace.gitCommonDir,
        branch: workspace.branch,
        headSha: workspace.headSha,
        baseKind: workspace.baseKind,
        baseRef: workspace.baseRef,
        checkpointId: workspace.checkpointId,
        parentWorkspaceId: workspace.parentWorkspaceId,
        status: workspace.status,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      } as unknown as import("@codeforge/sessions").WorkItem).catch(() => {});
    } catch {}
  }

  private async inspectGitDetails(canonicalPath: string): Promise<{
    repositoryRoot: string;
    gitCommonDir: string;
    branch: string;
    headSha: string;
  }> {
    const { stdout: repoRootOut } = await this.gitCommand(canonicalPath, ["rev-parse", "--show-toplevel"]);
    const repoRoot = getCanonicalWorkspacePath(repoRootOut.trim());

    let gitCommonDir = "";
    try {
      const { stdout: commonOut } = await this.gitCommand(canonicalPath, ["rev-parse", "--git-common-dir"]);
      gitCommonDir = path.resolve(repoRoot, commonOut.trim());
    } catch {
      gitCommonDir = path.join(repoRoot, ".git");
    }

    let branch = "HEAD";
    try {
      const { stdout: branchOut } = await this.gitCommand(canonicalPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = branchOut.trim() || "HEAD";
    } catch {}

    let headSha = "";
    try {
      const { stdout: shaOut } = await this.gitCommand(canonicalPath, ["rev-parse", "HEAD"]);
      headSha = shaOut.trim();
    } catch {}

    return {
      repositoryRoot: repoRoot,
      gitCommonDir,
      branch,
      headSha,
    };
  }

  private async gitCommand(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return await execFile("git", args, { cwd, env: getSanitizedEnvForChild() });
  }
}

export function createWorkspaceService(options: WorkspaceServiceOptions = {}): WorkspaceService {
  return new WorkspaceService(options);
}
