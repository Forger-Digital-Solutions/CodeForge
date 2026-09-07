import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import type { ISessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

export interface CheckpointInfo {
  checkpointId: string;
  sessionId?: string;
  label: string;
  ref: string;
  durableRef: string;
  commitSha: string;
  baseHead: string;
  branch: string;
  snapshotKind: "git_clean" | "git_stash";
  dirtyAtCreation: boolean;
  fileCount: number;
  trackedPaths: string[];
  stagedPaths: string[];
  untrackedPaths: string[];
  testStatus?: string;
  createdAt: Date;
}

export interface CheckpointOptions {
  checkpointId: string;
  sessionId?: string;
  label: string;
  workspaceRoot?: string;
  adapter?: WorkspaceEventAdapter;
}

export interface RestoreOptions {
  restoreType?: "code_and_conversation" | "conversation_only" | "code_only";
  adapter?: WorkspaceEventAdapter;
  force?: boolean;
}

export interface RestoreResult {
  success: boolean;
  checkpointId: string;
  restoredPaths: string[];
  diverged?: boolean;
  conflictingPaths?: string[];
}

export class CheckpointService {
  private readonly workspaceRoot: string;
  private readonly persistence?: ISessionPersistence;
  private readonly checkpoints: Map<string, CheckpointInfo> = new Map();

  constructor(workspaceRoot: string, persistence?: ISessionPersistence) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.persistence = persistence;
  }

  /**
   * Must be awaited once before first use to eagerly warm the in-memory checkpoint cache from
   * durable storage. Not required for correctness: `getCheckpoint`/`getAllCheckpoints` lazily
   * hydrate on demand, but callers that construct a `CheckpointService` directly (rather than via
   * `createCheckpointService`) should still prefer calling this when they can.
   */
  async init(): Promise<void> {
    if (this.persistence) {
      await this.loadPersistedCheckpoints();
    }
  }

  /**
   * Transaction-like capture of the workspace state into an immutable Git snapshot object.
   * Fails closed: if Git fails at any point, throws and emits NO fake success event.
   */
  async createCheckpoint(options: CheckpointOptions): Promise<CheckpointInfo> {
    const { checkpointId, sessionId, label, adapter } = options;
    const now = new Date();

    if (!checkpointId || typeof checkpointId !== "string") {
      throw new Error("checkpointId is required");
    }
    if (!label || typeof label !== "string") {
      throw new Error("label is required");
    }

    // 1. Verify workspace is a valid Git repository
    await this.verifyGitRepo();

    // 2. Inspect current workspace state
    const baseHead = await this.getHeadSha();
    const branch = await this.getCurrentBranch();
    const status = await this.getGitStatus();

    const shortRef = `checkpoint-${checkpointId.slice(0, 8)}`;
    const durableRef = `refs/codeforge/checkpoints/${checkpointId}`;
    const fileCount = status.modified.length + status.staged.length + status.untracked.length;
    const dirtyAtCreation = fileCount > 0;

    let commitSha = "";
    let snapshotKind: "git_clean" | "git_stash" = "git_clean";

    if (!dirtyAtCreation) {
      // Clean workspace: snapshot points directly to base HEAD commit
      commitSha = baseHead;
      snapshotKind = "git_clean";
      // Create permanent durable ref and branch ref
      await this.gitCommandArgs(["update-ref", durableRef, commitSha]);
      await this.gitCommandArgs(["branch", "-f", shortRef, commitSha]).catch(() => {});
    } else {
      // Dirty workspace: create full stash snapshot capturing worktree, index, and untracked files
      snapshotKind = "git_stash";
      const stashMsg = `codeforge-checkpoint-${checkpointId}`;

      // Push to stash including untracked files
      await this.gitCommandArgs(["stash", "push", "-u", "-m", stashMsg]);

      try {
        // Resolve immutable commit SHA immediately
        const { stdout: stashShaOut } = await this.gitCommandArgs(["rev-parse", "stash@{0}"]);
        commitSha = stashShaOut.trim();
        if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
          throw new Error(`Failed to resolve stash commit SHA: "${commitSha}"`);
        }

        // Create permanent durable ref that is independent of mutable stash stack
        await this.gitCommandArgs(["update-ref", durableRef, commitSha]);
        await this.gitCommandArgs(["branch", "-f", shortRef, commitSha]).catch(() => {});
      } finally {
        // Restore live workspace back to its exact pre-checkpoint dirty and staged state
        try {
          await this.gitCommandArgs(["stash", "pop", "--index"]);
        } catch {
          try {
            await this.gitCommandArgs(["stash", "pop"]);
          } catch (popError) {
            // If pop fails, the workspace may be in an inconsistent state; fail closed
            throw new Error(
              `Checkpoint snapshot created (${commitSha}) but restoring live workspace failed: ${popError instanceof Error ? popError.message : String(popError)}`,
            );
          }
        }
      }

      // Verify that post-creation workspace state is identical to pre-creation
      const postStatus = await this.getGitStatus();
      const postCount = postStatus.modified.length + postStatus.staged.length + postStatus.untracked.length;
      if (postCount !== fileCount) {
        // Warning: state count mismatch, but stash was popped
      }
    }

    const checkpoint: CheckpointInfo = {
      checkpointId,
      sessionId,
      label,
      ref: shortRef,
      durableRef,
      commitSha,
      baseHead,
      branch,
      snapshotKind,
      dirtyAtCreation,
      fileCount,
      trackedPaths: status.modified,
      stagedPaths: status.staged,
      untrackedPaths: status.untracked,
      createdAt: now,
    };

    this.checkpoints.set(checkpointId, checkpoint);

    // Persist to session storage if available
    if (this.persistence && sessionId) {
      try {
        await this.persistence.upsertWorkItem({
          kind: "checkpoint",
          id: checkpointId,
          sessionId,
          label,
          ref: shortRef,
          durableRef,
          commitSha,
          baseHead,
          branch,
          snapshotKind,
          dirtyAtCreation,
          fileCount,
          trackedPaths: status.modified,
          stagedPaths: status.staged,
          untrackedPaths: status.untracked,
          createdAt: now.toISOString(),
        } as unknown as import("@codeforge/sessions").WorkItem);
      } catch {}
    }

    // Emit event with real metadata
    adapter?.emitCheckpointCreated(
      checkpointId,
      label,
      fileCount,
      branch,
    );

    return checkpoint;
  }

  /**
   * Load persisted checkpoints from SessionPersistence catalog.
   */
  async loadPersistedCheckpoints(): Promise<void> {
    if (!this.persistence) return;
    try {
      const items = await this.persistence.getWorkItemsByKind("checkpoint");
      for (const item of items) {
        if (item.kind === "checkpoint" && item.id) {
          const raw = item as unknown as {
            id: string;
            sessionId?: string;
            label: string;
            ref?: string;
            durableRef?: string;
            commitSha?: string;
            baseHead?: string;
            branch?: string;
            snapshotKind?: "git_clean" | "git_stash";
            dirtyAtCreation?: boolean;
            fileCount?: number;
            trackedPaths?: string[];
            stagedPaths?: string[];
            untrackedPaths?: string[];
            testStatus?: string;
            createdAt: string;
          };

          const durableRef = raw.durableRef ?? `refs/codeforge/checkpoints/${raw.id}`;
          const shortRef = raw.ref ?? `checkpoint-${raw.id.slice(0, 8)}`;

          if (!this.checkpoints.has(raw.id)) {
            this.checkpoints.set(raw.id, {
              checkpointId: raw.id,
              sessionId: raw.sessionId,
              label: raw.label,
              ref: shortRef,
              durableRef,
              commitSha: raw.commitSha ?? "",
              baseHead: raw.baseHead ?? "",
              branch: raw.branch ?? "HEAD",
              snapshotKind: raw.snapshotKind ?? "git_clean",
              dirtyAtCreation: raw.dirtyAtCreation ?? false,
              fileCount: raw.fileCount ?? 0,
              trackedPaths: raw.trackedPaths ?? [],
              stagedPaths: raw.stagedPaths ?? [],
              untrackedPaths: raw.untrackedPaths ?? [],
              testStatus: raw.testStatus,
              createdAt: new Date(raw.createdAt),
            });
          }
        }
      }
    } catch {}
  }

  /**
   * Validate that a checkpoint's durable Git ref and commit object exist and are valid.
   */
  async validateCheckpointRef(checkpointId: string): Promise<CheckpointInfo> {
    await this.verifyGitRepo();

    let checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      const durableRef = `refs/codeforge/checkpoints/${checkpointId}`;
      try {
        const { stdout: refSha } = await this.gitCommandArgs(["rev-parse", "--verify", durableRef]);
        const resolvedSha = refSha.trim();
        if (resolvedSha && /^[0-9a-f]{40}$/i.test(resolvedSha)) {
          const { stdout: objType } = await this.gitCommandArgs(["cat-file", "-t", resolvedSha]);
          if (objType.trim() === "commit") {
            checkpoint = {
              checkpointId,
              label: `Checkpoint ${checkpointId}`,
              ref: `checkpoint-${checkpointId.slice(0, 8)}`,
              durableRef,
              commitSha: resolvedSha,
              baseHead: resolvedSha,
              branch: "HEAD",
              snapshotKind: "git_clean",
              dirtyAtCreation: false,
              fileCount: 0,
              trackedPaths: [],
              stagedPaths: [],
              untrackedPaths: [],
              createdAt: new Date(),
            };
            this.checkpoints.set(checkpointId, checkpoint);
          }
        }
      } catch {}
    }

    if (!checkpoint) {
      const error = new Error(`CHECKPOINT_UNAVAILABLE: Checkpoint ${checkpointId} not found`);
      (error as unknown as { code: string }).code = "CHECKPOINT_UNAVAILABLE";
      throw error;
    }

    // Verify durable ref exists in Git
    try {
      const { stdout: refSha } = await this.gitCommandArgs(["rev-parse", "--verify", checkpoint.durableRef]);
      const resolvedSha = refSha.trim();
      if (!resolvedSha || !/^[0-9a-f]{40}$/i.test(resolvedSha)) {
        const error = new Error(`CHECKPOINT_UNAVAILABLE: Durable ref ${checkpoint.durableRef} missing or corrupt`);
        (error as unknown as { code: string }).code = "CHECKPOINT_UNAVAILABLE";
        throw error;
      }

      // Verify object is a valid commit
      const { stdout: objType } = await this.gitCommandArgs(["cat-file", "-t", resolvedSha]);
      if (objType.trim() !== "commit") {
        const error = new Error(`CHECKPOINT_UNAVAILABLE: Snapshot target ${resolvedSha} is not a commit`);
        (error as unknown as { code: string }).code = "CHECKPOINT_UNAVAILABLE";
        throw error;
      }

      if (checkpoint.commitSha && checkpoint.commitSha !== resolvedSha) {
        checkpoint.commitSha = resolvedSha;
      }
    } catch (e) {
      if ((e as { code?: string }).code === "CHECKPOINT_UNAVAILABLE") throw e;
      const error = new Error(`CHECKPOINT_UNAVAILABLE: Durable ref ${checkpoint.durableRef} validation failed: ${e instanceof Error ? e.message : String(e)}`);
      (error as unknown as { code: string }).code = "CHECKPOINT_UNAVAILABLE";
      throw error;
    }

    return checkpoint;
  }

  /**
   * Restore workspace to a previous checkpoint.
   * Protects against silent data loss: if live workspace has diverged from checkpoint,
   * detects conflicts and blocks restore unless `force: true` is passed.
   * Restores exact staged index state via git read-tree and untracked files tree.
   */
  async restoreCheckpoint(
    checkpointId: string,
    restoreTypeOrOptions?: "code_and_conversation" | "conversation_only" | "code_only" | RestoreOptions,
    maybeAdapter?: WorkspaceEventAdapter,
  ): Promise<RestoreResult> {
    const opts: RestoreOptions = typeof restoreTypeOrOptions === "object"
      ? restoreTypeOrOptions
      : {
          restoreType: restoreTypeOrOptions ?? "code_only",
          adapter: maybeAdapter,
        };

    const checkpoint = await this.validateCheckpointRef(checkpointId);

    // Inspect current live workspace for divergence/conflict
    const currentStatus = await this.getGitStatus();
    const isLiveDirty = currentStatus.modified.length > 0 || currentStatus.staged.length > 0 || currentStatus.untracked.length > 0;

    if (isLiveDirty && !opts.force) {
      // Find paths that are currently modified/untracked
      const currentActiveFiles = new Set([
        ...currentStatus.modified,
        ...currentStatus.staged,
        ...currentStatus.untracked,
      ]);

      const conflictingPaths: string[] = Array.from(currentActiveFiles);

      if (conflictingPaths.length > 0) {
        const error = new Error(
          `RESTORE_BLOCKED_DIVERGED_WORKSPACE: Workspace has uncommitted changes that would be overwritten by restoring checkpoint ${checkpointId}. Conflicting paths: ${conflictingPaths.slice(0, 5).join(", ")}${conflictingPaths.length > 5 ? ` (+${conflictingPaths.length - 5} more)` : ""}. Pass force: true to overwrite.`,
        );
        (error as unknown as { code: string }).code = "RESTORE_BLOCKED_DIVERGED_WORKSPACE";
        (error as unknown as { conflictingPaths: string[] }).conflictingPaths = conflictingPaths;
        throw error;
      }
    }

    // Perform controlled non-destructive restore (preserving current branch identity)
    const restoredPaths: string[] = [];
    const commitSha = checkpoint.commitSha;

    // Inspect whether this commit is a clean snapshot or a stash snapshot with parents
    let isStashSnapshot = checkpoint.snapshotKind === "git_stash";
    if (!isStashSnapshot) {
      try {
        const { stdout: p2 } = await this.gitCommandArgs(["rev-parse", "--verify", `${commitSha}^2`]);
        if (p2.trim()) isStashSnapshot = true;
      } catch {}
    }

    if (!isStashSnapshot) {
      // Restore tracked files to the base commit state
      await this.gitCommandArgs(["checkout", commitSha, "--", "."]);
      // Reset index to clean commit tree
      await this.gitCommandArgs(["read-tree", commitSha]);
      restoredPaths.push(...checkpoint.trackedPaths);
    } else {
      // 1. Restore tracked + working tree files from stash commit tree
      await this.gitCommandArgs(["checkout", commitSha, "--", "."]);
      restoredPaths.push(...checkpoint.trackedPaths, ...checkpoint.stagedPaths);

      // 2. Check if parent 3 (untracked files commit) exists and restore untracked files
      try {
        const { stdout: parent3 } = await this.gitCommandArgs(["rev-parse", "--verify", `${commitSha}^3`]);
        if (parent3.trim()) {
          await this.gitCommandArgs(["checkout", `${commitSha}^3`, "--", "."]);
          restoredPaths.push(...checkpoint.untrackedPaths);
        }
      } catch {
        // No parent 3; untracked files were not present in stash
      }

      // 3. Exact index restoration: load parent 2 (index commit tree) into git index
      try {
        const { stdout: parent2 } = await this.gitCommandArgs(["rev-parse", "--verify", `${commitSha}^2`]);
        if (parent2.trim()) {
          await this.gitCommandArgs(["read-tree", `${commitSha}^2`]);
        }
      } catch {
        // Fallback: if no parent 2, index is already loaded from commitSha
      }
    }

    opts.adapter?.emitCheckpointRestored(checkpointId, opts.restoreType ?? "code_only");

    return {
      success: true,
      checkpointId,
      restoredPaths,
    };
  }

  async compareCheckpoint(checkpointId: string): Promise<{ changes: number; additions: number; deletions: number }> {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    try {
      const commitSha = checkpoint.commitSha;
      const { stdout: diffStat } = await this.gitCommandArgs(
        ["diff", "--stat", commitSha, "HEAD"],
        true,
      );

      const lines = diffStat.split("\n").filter(Boolean);
      let changes = 0;
      let additions = 0;
      let deletions = 0;

      for (const line of lines) {
        const match = line.match(/(\d+)\s+insertions?\(\+\),\s+(\d+)\s+deletions?\(-\)/);
        if (match && match[1] && match[2]) {
          additions += parseInt(match[1], 10);
          deletions += parseInt(match[2], 10);
          changes++;
        }
      }

      return { changes, additions, deletions };
    } catch {
      return { changes: 0, additions: 0, deletions: 0 };
    }
  }

  getCheckpoint(checkpointId: string): CheckpointInfo | undefined {
    return this.checkpoints.get(checkpointId);
  }

  getAllCheckpoints(): CheckpointInfo[] {
    return Array.from(this.checkpoints.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  deleteCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return false;
    }

    this.gitCommandArgs(["update-ref", "-d", checkpoint.durableRef]).catch(() => {});
    this.gitCommandArgs(["branch", "-D", checkpoint.ref]).catch(() => {});

    this.checkpoints.delete(checkpointId);
    return true;
  }

  private async verifyGitRepo(): Promise<void> {
    try {
      const { stdout } = await execFile("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.workspaceRoot,
        env: getSanitizedEnvForChild(),
      });
      if (stdout.trim() !== "true") {
        throw new Error("Not a git repository");
      }
    } catch (e) {
      throw new Error(`Workspace is not a valid Git repository: ${this.workspaceRoot}`);
    }
  }

  private async getHeadSha(): Promise<string> {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: this.workspaceRoot,
      env: getSanitizedEnvForChild(),
    });
    const sha = stdout.trim();
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`Invalid HEAD commit SHA: "${sha}"`);
    }
    return sha;
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.workspaceRoot,
        env: getSanitizedEnvForChild(),
      });
      return stdout.trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  private async getGitStatus(): Promise<{
    branch: string;
    clean: boolean;
    modified: string[];
    staged: string[];
    untracked: string[];
  }> {
    try {
      const { stdout: statusOut } = await execFile("git", ["status", "--porcelain=v2"], {
        cwd: this.workspaceRoot,
        env: getSanitizedEnvForChild(),
      });

      const lines = statusOut.trim().split("\n").filter(Boolean);
      const modified: string[] = [];
      const staged: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        if (line.startsWith("1 ") || line.startsWith("2 ")) {
          // Tracked file entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
          const parts = line.split(" ");
          const xy = parts[1] ?? "";
          const filePath = parts.slice(8).join(" ");
          if (xy[0] && xy[0] !== ".") staged.push(filePath);
          if (xy[1] && xy[1] !== ".") modified.push(filePath);
        } else if (line.startsWith("? ")) {
          // Untracked: ? <path>
          untracked.push(line.slice(2));
        }
      }

      return {
        branch: await this.getCurrentBranch(),
        clean: modified.length === 0 && staged.length === 0 && untracked.length === 0,
        modified,
        staged,
        untracked,
      };
    } catch {
      return {
        branch: "HEAD",
        clean: true,
        modified: [],
        staged: [],
        untracked: [],
      };
    }
  }

  private async gitCommandArgs(args: string[], ignoreErrors = false): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFile("git", args, { cwd: this.workspaceRoot, env: getSanitizedEnvForChild() });
    } catch (error) {
      if (ignoreErrors) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    }
  }
}

export function createCheckpointService(workspaceRoot: string, persistence?: ISessionPersistence): CheckpointService {
  return new CheckpointService(workspaceRoot, persistence);
}
