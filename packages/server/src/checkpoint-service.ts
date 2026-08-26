import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";

const exec = promisify(execCallback);

export interface CheckpointInfo {
  checkpointId: string;
  label: string;
  ref: string;
  branch?: string;
  fileCount: number;
  testStatus?: string;
  createdAt: Date;
}

export interface CheckpointOptions {
  checkpointId: string;
  label: string;
  workspaceRoot: string;
  adapter: WorkspaceEventAdapter;
}

export class CheckpointService {
  private readonly workspaceRoot: string;
  private readonly checkpoints: Map<string, CheckpointInfo> = new Map();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async createCheckpoint(options: CheckpointOptions): Promise<CheckpointInfo> {
    const { checkpointId, label, adapter } = options;
    const now = new Date();

    try {
      const branch = await this.getCurrentBranch();
      const status = await this.getGitStatus();
      const fileCount = status.modified.length + status.untracked.length;

      const ref = `checkpoint-${checkpointId.slice(0, 8)}`;

      await this.gitCommand(`stash push -m "${ref}" --include-untracked`);
      await this.gitCommand(`branch ${ref}`);

      const checkpoint: CheckpointInfo = {
        checkpointId,
        label,
        ref,
        branch,
        fileCount,
        createdAt: now,
      };

      if (status.modified.length > 0 || status.untracked.length > 0) {
        await this.gitCommand(`stash pop`);
      }

      this.checkpoints.set(checkpointId, checkpoint);

      adapter.emitCheckpointCreated(
        checkpointId,
        label,
        fileCount,
        branch,
      );

      return checkpoint;
    } catch (error) {
      const safeCheckpoint: CheckpointInfo = {
        checkpointId,
        label,
        ref: `checkpoint-${checkpointId.slice(0, 8)}`,
        fileCount: 0,
        createdAt: now,
      };

      this.checkpoints.set(checkpointId, safeCheckpoint);

      adapter.emitCheckpointCreated(checkpointId, label, 0);

      return safeCheckpoint;
    }
  }

  async restoreCheckpoint(
    checkpointId: string,
    restoreType: "code_and_conversation" | "conversation_only" | "code_only",
    adapter: WorkspaceEventAdapter,
  ): Promise<void> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    try {
      await this.gitCommand(`checkout ${checkpoint.ref}`);

      adapter.emitCheckpointRestored(checkpointId, restoreType);
    } catch (error) {
      throw new Error(
        `Failed to restore checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async compareCheckpoint(checkpointId: string): Promise<{ changes: number; additions: number; deletions: number }> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    try {
      const { stdout: diffStat } = await this.gitCommand(
        `diff --stat ${checkpoint.ref} HEAD`,
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

    this.gitCommand(`branch -D ${checkpoint.ref}`).catch(() => {});

    this.checkpoints.delete(checkpointId);
    return true;
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await exec("git rev-parse --abbrev-ref HEAD", {
        cwd: this.workspaceRoot,
      });
      return stdout.trim();
    } catch {
      return "main";
    }
  }

  private async getGitStatus(): Promise<{ branch: string; clean: boolean; modified: string[]; untracked: string[] }> {
    try {
      const { stdout: statusOut } = await exec("git status --porcelain", {
        cwd: this.workspaceRoot,
      });

      const lines = statusOut.trim().split("\n").filter(Boolean);
      const modified: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3);

        if (status === "??") {
          untracked.push(file);
        } else {
          modified.push(file);
        }
      }

      return {
        branch: await this.getCurrentBranch(),
        clean: lines.length === 0,
        modified,
        untracked,
      };
    } catch {
      return {
        branch: "main",
        clean: true,
        modified: [],
        untracked: [],
      };
    }
  }

  private async gitCommand(command: string, ignoreErrors = false): Promise<{ stdout: string; stderr: string }> {
    try {
      return await exec(command, { cwd: this.workspaceRoot });
    } catch (error) {
      if (ignoreErrors) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    }
  }
}

export function createCheckpointService(workspaceRoot: string): CheckpointService {
  return new CheckpointService(workspaceRoot);
}
