import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { resolveWithinWorkspace } from "./path-security.js";

export interface FileChange {
  changeId: string;
  path: string;
  changeType: "created" | "modified" | "deleted";
  content?: string;
  previousContent?: string;
  diff?: string;
}

export interface FileSystemServiceOptions {
  workspaceRoot: string;
  adapter: WorkspaceEventAdapter;
}

export class FileSystemService {
  private readonly workspaceRoot: string;
  private readonly adapter: WorkspaceEventAdapter;
  private readonly pendingChanges: Map<string, FileChange> = new Map();

  constructor(options: FileSystemServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.adapter = options.adapter;
  }

  async readFile(relativePath: string): Promise<string> {
    const absolutePath = this.resolvePath(relativePath);
    const fileCallId = crypto.randomUUID();

    this.adapter.emitFileRead(fileCallId, relativePath);

    try {
      const content = await fs.readFile(absolutePath, "utf-8");
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${relativePath}`);
      }
      throw error;
    }
  }

  async proposeChange(
    relativePath: string,
    changeType: "created" | "modified" | "deleted",
    content?: string,
  ): Promise<string> {
    const absolutePath = this.resolvePath(relativePath);
    const changeId = crypto.randomUUID();

    let previousContent: string | undefined;
    let additions = 0;
    let deletions = 0;
    let diff: string | undefined;

    try {
      if (changeType === "modified" || changeType === "deleted") {
        previousContent = await fs.readFile(absolutePath, "utf-8");
      }
    } catch {
      // File doesn't exist - that's fine for creation
    }

    if (changeType === "modified" && previousContent !== undefined && content !== undefined) {
      const diffResult = this.computeDiff(relativePath, previousContent, content);
      additions = diffResult.additions;
      deletions = diffResult.deletions;
      diff = diffResult.diff;
    } else if (changeType === "created" && content) {
      additions = content.split("\n").length;
    } else if (changeType === "deleted" && previousContent) {
      deletions = previousContent.split("\n").length;
    }

    const change: FileChange = {
      changeId,
      path: relativePath,
      changeType,
      content,
      previousContent,
      diff,
    };

    this.pendingChanges.set(changeId, change);

    this.adapter.emitFileChangeProposed(
      changeId,
      relativePath,
      changeType,
      additions,
      deletions,
      changeType === "created" ? "Create new file" : changeType === "deleted" ? "Delete file" : "Modify file",
      diff,
    );

    return changeId;
  }

  async applyChange(changeId: string): Promise<void> {
    const change = this.pendingChanges.get(changeId);
    if (!change) {
      throw new Error(`Change ${changeId} not found`);
    }

    const absolutePath = this.resolvePath(change.path);

    try {
      // Ensure directory exists
      const dir = path.dirname(absolutePath);
      await fs.mkdir(dir, { recursive: true });

      if (change.changeType === "deleted") {
        await fs.unlink(absolutePath);
      } else if (change.content !== undefined) {
        await fs.writeFile(absolutePath, change.content, "utf-8");
      }

      this.adapter.emitFileChangeApplied(changeId, change.path);
      this.pendingChanges.delete(changeId);
    } catch (error) {
      throw new Error(
        `Failed to apply change to ${change.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async revertChange(changeId: string): Promise<void> {
    const change = this.pendingChanges.get(changeId);
    if (!change) {
      throw new Error(`Change ${changeId} not found`);
    }

    const absolutePath = this.resolvePath(change.path);

    try {
      if (change.previousContent !== undefined) {
        await fs.writeFile(absolutePath, change.previousContent, "utf-8");
      } else if (change.changeType === "created") {
        await fs.unlink(absolutePath);
      }

      this.adapter.emitFileChangeReverted(changeId, change.path);
      this.pendingChanges.delete(changeId);
    } catch (error) {
      throw new Error(
        `Failed to revert change to ${change.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async writeFile(relativePath: string, content: string): Promise<string> {
    const changeId = await this.proposeChange(
      relativePath,
      "modified",
      content,
    );
    await this.applyChange(changeId);
    return changeId;
  }

  async createFile(relativePath: string, content: string): Promise<string> {
    const changeId = await this.proposeChange(relativePath, "created", content);
    await this.applyChange(changeId);
    return changeId;
  }

  async deleteFile(relativePath: string): Promise<string> {
    const changeId = await this.proposeChange(relativePath, "deleted");
    await this.applyChange(changeId);
    return changeId;
  }

  getPendingChange(changeId: string): FileChange | undefined {
    return this.pendingChanges.get(changeId);
  }

  getPendingChanges(): FileChange[] {
    return Array.from(this.pendingChanges.values());
  }

  private resolvePath(relativePath: string): string {
    // Symlink/junction-aware containment; throws on any escape attempt.
    const result = resolveWithinWorkspace(this.workspaceRoot, relativePath);
    if (!result.valid || !result.resolvedPath) {
      throw new Error(`Path traversal attempt: ${relativePath}`);
    }
    return result.resolvedPath;
  }

  private computeDiff(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): { additions: number; deletions: number; diff: string } {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const additions = Math.max(0, newLines.length - oldLines.length);
    const deletions = Math.max(0, oldLines.length - newLines.length);

    const diffLines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

    const maxLines = Math.max(oldLines.length, newLines.length);
    let inHunk = false;
    let hunkStart = 0;

    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine !== newLine) {
        if (!inHunk) {
          hunkStart = i + 1;
          inHunk = true;
        }
        if (oldLine !== undefined) {
          diffLines.push(`-${oldLine}`);
        }
        if (newLine !== undefined) {
          diffLines.push(`+${newLine}`);
        }
      } else if (inHunk && oldLine !== undefined) {
        diffLines.push(` ${oldLine}`);
      }
    }

    return {
      additions,
      deletions,
      diff: diffLines.join("\n"),
    };
  }
}

export function createFileSystemService(options: FileSystemServiceOptions): FileSystemService {
  return new FileSystemService(options);
}
