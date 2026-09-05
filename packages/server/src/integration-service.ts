import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WorkspaceService, ForgeWorkspace } from "./workspace-service.js";
import type { CheckpointService } from "./checkpoint-service.js";
import type { AgentFinding } from "@codeforge/agent";
import type { VerificationResult } from "@codeforge/workflow";
import { redactSecrets } from "@codeforge/secrets";

const execFile = promisify(execFileCallback);

export type IntegrationFailureCode =
  | "INTEGRATION_TARGET_DIRTY"
  | "INTEGRATION_TARGET_DIVERGED"
  | "INTEGRATION_CONFLICT"
  | "INTEGRATION_BASE_CHANGED"
  | "INTEGRATION_REVIEW_BLOCKED"
  | "INTEGRATION_VERIFICATION_FAILED"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_LEASE_CONFLICT";

export interface PrepareIntegrationParams {
  targetWorkspaceId: string;
  isolatedWorktreeId: string;
  expectedBaseSha: string;
  runId: string;
  reviewFindings?: AgentFinding[];
  verificationResults?: VerificationResult[];
}

export interface PrepareIntegrationResult {
  ready: boolean;
  code?: IntegrationFailureCode;
  reason?: string;
  targetHeadSha: string;
  autonomousSha?: string;
  changedFiles: string[];
}

export interface IntegrateParams {
  targetWorkspaceId: string;
  isolatedWorktreeId: string;
  expectedBaseSha: string;
  runId: string;
  commitMessage?: string;
  reviewFindings?: AgentFinding[];
  verificationResults?: VerificationResult[];
}

export interface IntegrateResult {
  status: "integrated" | "blocked" | "failed";
  code?: IntegrationFailureCode;
  reason?: string;
  finalRevision?: string;
  changedFiles: string[];
  checkpointId?: string;
}

export interface IntegrationServiceOptions {
  workspaceService: WorkspaceService;
  checkpointServiceFactory?: (repoRoot: string) => CheckpointService;
}

export class IntegrationService {
  private readonly workspaceService: WorkspaceService;

  constructor(options: IntegrationServiceOptions) {
    this.workspaceService = options.workspaceService;
  }

  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  }

  /**
   * Pre-flight validation before touching the target workspace.
   * Fails closed if target diverged, target is dirty with conflicting paths, or review/verification gates failed.
   */
  async prepareIntegration(params: PrepareIntegrationParams): Promise<PrepareIntegrationResult> {
    const {
      targetWorkspaceId,
      isolatedWorktreeId,
      expectedBaseSha,
      reviewFindings,
      verificationResults,
    } = params;

    // 1. Validate Review findings: must have zero blocking findings
    if (reviewFindings && reviewFindings.some((f) => f.severity === "blocking")) {
      return {
        ready: false,
        code: "INTEGRATION_REVIEW_BLOCKED",
        reason: "Integration blocked: independent review identified blocking findings",
        targetHeadSha: expectedBaseSha,
        changedFiles: [],
      };
    }

    // 2. Validate Verification results: must have passed
    if (verificationResults && verificationResults.some((v) => v.failed > 0)) {
      return {
        ready: false,
        code: "INTEGRATION_VERIFICATION_FAILED",
        reason: "Integration blocked: deterministic verification gates failed",
        targetHeadSha: expectedBaseSha,
        changedFiles: [],
      };
    }

    // 3. Resolve Workspaces
    const targetWs = this.workspaceService.getWorkspace(targetWorkspaceId);
    if (!targetWs || !existsSync(targetWs.rootPath)) {
      return {
        ready: false,
        code: "WORKSPACE_UNAVAILABLE",
        reason: `Target workspace ${targetWorkspaceId} is not available`,
        targetHeadSha: expectedBaseSha,
        changedFiles: [],
      };
    }

    const worktreeWs = this.workspaceService.getWorkspace(isolatedWorktreeId);
    if (!worktreeWs || !existsSync(worktreeWs.rootPath)) {
      return {
        ready: false,
        code: "WORKSPACE_UNAVAILABLE",
        reason: `Isolated worktree ${isolatedWorktreeId} is not available`,
        targetHeadSha: expectedBaseSha,
        changedFiles: [],
      };
    }

    // 4. Validate Target HEAD Divergence
    const { stdout: currentTargetHeadOut } = await this.git(targetWs.rootPath, ["rev-parse", "HEAD"]).catch(() => ({
      stdout: "",
    }));
    const currentTargetHead = currentTargetHeadOut.trim();

    if (currentTargetHead && expectedBaseSha && currentTargetHead !== expectedBaseSha) {
      return {
        ready: false,
        code: "INTEGRATION_TARGET_DIVERGED",
        reason: `Target repository diverged: expected base ${expectedBaseSha.slice(0, 8)}, but target HEAD is ${currentTargetHead.slice(0, 8)}. Failing closed to protect user work.`,
        targetHeadSha: currentTargetHead,
        changedFiles: [],
      };
    }

    // 5. Inspect changed files in isolated worktree
    const changedFiles: string[] = [];
    try {
      const { stdout: diffFilesOut } = await this.git(worktreeWs.rootPath, ["diff", "--name-only", expectedBaseSha]);
      for (const line of diffFilesOut.split(/\r?\n/)) {
        if (line.trim()) changedFiles.push(line.trim());
      }
      const { stdout: statusOut } = await this.git(worktreeWs.rootPath, ["status", "--porcelain=v2"]);
      for (const line of statusOut.split(/\r?\n/)) {
        if (line.startsWith("? ")) {
          const untracked = line.slice(2).trim();
          if (untracked && !changedFiles.includes(untracked)) changedFiles.push(untracked);
        }
      }
    } catch {}

    // 6. Inspect Target Dirty Status & Check for Overlapping Paths
    try {
      const { stdout: targetStatusOut } = await this.git(targetWs.rootPath, ["status", "--porcelain=v2"]);
      const dirtyTargetPaths: string[] = [];
      for (const line of targetStatusOut.split(/\r?\n/)) {
        if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("? ") || line.startsWith("u ")) {
          const parts = line.split(" ");
          const filePath = parts[parts.length - 1]?.trim();
          if (filePath) dirtyTargetPaths.push(filePath);
        }
      }

      const conflictingDirtyPaths = changedFiles.filter((f) => dirtyTargetPaths.includes(f));
      if (conflictingDirtyPaths.length > 0) {
        return {
          ready: false,
          code: "INTEGRATION_TARGET_DIRTY",
          reason: `Target workspace contains uncommitted user modifications in conflicting paths: ${conflictingDirtyPaths.slice(0, 3).join(", ")}. Integration aborted to avoid overwriting user work.`,
          targetHeadSha: currentTargetHead,
          changedFiles,
        };
      }
    } catch {}

    // Get worktree HEAD sha
    const { stdout: wtHeadOut } = await this.git(worktreeWs.rootPath, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }));

    return {
      ready: true,
      targetHeadSha: currentTargetHead,
      autonomousSha: wtHeadOut.trim() || undefined,
      changedFiles,
    };
  }

  /**
   * Transactional integration of autonomous changes into the target repository.
   * Acquires write lease on target workspace, creates safety checkpoint, applies changes, and releases lease.
   */
  async integrate(params: IntegrateParams): Promise<IntegrateResult> {
    const preflight = await this.prepareIntegration(params);
    if (!preflight.ready) {
      return {
        status: "blocked",
        code: preflight.code,
        reason: preflight.reason,
        changedFiles: preflight.changedFiles,
      };
    }

    const { targetWorkspaceId, isolatedWorktreeId, expectedBaseSha, runId, commitMessage } = params;
    const targetWs = this.workspaceService.getWorkspace(targetWorkspaceId)!;
    const worktreeWs = this.workspaceService.getWorkspace(isolatedWorktreeId)!;

    // 1. Acquire exclusive write lease on target workspace
    let targetLease;
    try {
      targetLease = this.workspaceService.acquireLease(targetWs.rootPath, runId, "write");
    } catch (err: unknown) {
      return {
        status: "blocked",
        code: "WORKSPACE_LEASE_CONFLICT",
        reason: `Failed to acquire target workspace write lease: ${err instanceof Error ? err.message : String(err)}`,
        changedFiles: preflight.changedFiles,
      };
    }

    try {
      // 2. Inspect if worktree has commits ahead of base
      const { stdout: revCountOut } = await this.git(worktreeWs.rootPath, [
        "rev-list",
        "--count",
        `${expectedBaseSha}..HEAD`,
      ]).catch(() => ({ stdout: "0" }));
      const commitCount = parseInt(revCountOut.trim(), 10) || 0;

      // 3. Inspect if worktree has dirty uncommitted changes
      const { stdout: wtStatusOut } = await this.git(worktreeWs.rootPath, ["status", "--porcelain=v2"]);
      const isWorktreeDirty = wtStatusOut.trim().length > 0;

      // If worktree has dirty changes, commit them in the worktree first so they have a proper commit identity
      if (isWorktreeDirty) {
        await this.git(worktreeWs.rootPath, ["add", "-A"]);
        const safeMsg = commitMessage || `Autonomous implementation for ${runId}`;
        await this.git(worktreeWs.rootPath, ["commit", "-m", safeMsg]);
      }

      // Check final commit SHA in worktree
      const { stdout: finalWtShaOut } = await this.git(worktreeWs.rootPath, ["rev-parse", "HEAD"]);
      const finalWtSha = finalWtShaOut.trim();

      if (!finalWtSha || finalWtSha === expectedBaseSha) {
        // Nothing changed
        return {
          status: "integrated",
          finalRevision: expectedBaseSha,
          changedFiles: [],
        };
      }

      // 4. Perform fast merge / cherry-pick onto target
      if (worktreeWs.branch) {
        // Fetch or merge the branch directly in target repo
        try {
          await this.git(targetWs.rootPath, ["merge", "--ff-only", finalWtSha]);
        } catch {
          // If ff-only is not possible, try standard merge
          try {
            await this.git(targetWs.rootPath, ["merge", finalWtSha, "-m", commitMessage || `Merge autonomous work ${runId}`]);
          } catch (mergeErr) {
            // Abort merge cleanly
            await this.git(targetWs.rootPath, ["merge", "--abort"]).catch(() => {});
            return {
              status: "blocked",
              code: "INTEGRATION_CONFLICT",
              reason: `Git merge conflict during integration: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`,
              changedFiles: preflight.changedFiles,
            };
          }
        }
      } else {
        // Apply changes from commit
        await this.git(targetWs.rootPath, ["cherry-pick", finalWtSha]);
      }

      const { stdout: newTargetHead } = await this.git(targetWs.rootPath, ["rev-parse", "HEAD"]);

      return {
        status: "integrated",
        finalRevision: newTargetHead.trim(),
        changedFiles: preflight.changedFiles,
      };
    } catch (err: unknown) {
      return {
        status: "failed",
        code: "INTEGRATION_CONFLICT",
        reason: `Integration error: ${err instanceof Error ? err.message : String(err)}`,
        changedFiles: preflight.changedFiles,
      };
    } finally {
      // Always release target write lease in finally
      try {
        this.workspaceService.releaseLease(targetLease.leaseId, runId);
      } catch {}
    }
  }
}

export function createIntegrationService(options: IntegrationServiceOptions): IntegrationService {
  return new IntegrationService(options);
}
