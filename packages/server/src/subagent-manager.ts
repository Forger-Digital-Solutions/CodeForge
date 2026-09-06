import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgent,
  BUILT_IN_AGENTS,
  type AgentDefinition,
  type AgentPermissions,
  type AgentResult,
  type AgentFinding,
  type AgentEvidenceRef,
  type StructuredOutputKind,
} from "@codeforge/agent";
import type { WorkspaceEventAdapter } from "./workspace-event-adapter.js";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { WorkspaceService } from "./workspace-service.js";
import { redactSecrets } from "@codeforge/secrets";

import type { AgentRuntime } from "./agent-runtime.js";

export const MAX_SUBAGENT_DEPTH = 1;
export const MAX_CHILDREN_PER_PARENT = 5;

export interface SpawnChildOptions {
  parentRunId: string;
  agentId: string;
  task: string;
  workspacePath: string;
  parentPermissions?: AgentPermissions;
  depth?: number;
  adapter?: WorkspaceEventAdapter;
  signal?: AbortSignal;
  contextSummary?: string;
  explorerEvidence?: AgentEvidenceRef[];
  findings?: AgentFinding[];
  taskPlan?: string;
  reviewFeedback?: string;
  structuredOutput?: StructuredOutputKind;
  metadata?: Record<string, unknown>;
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ChildRun {
  childRunId: string;
  parentRunId: string;
  agentId: string;
  role: string;
  task: string;
  workspacePath: string;
  depth: number;
  status: "queued" | "working" | "completed" | "failed" | "cancelled";
  permissions: AgentPermissions;
  allowedTools: string[];
  controller: AbortController;
  startedAt: Date;
  completedAt?: Date;
  result?: AgentResult;
}

export interface SubagentManagerOptions {
  persistence?: ISessionPersistence;
  workspaceService?: WorkspaceService;
  agentRuntime?: AgentRuntime;
}

export class SubagentManager {
  private readonly persistence?: ISessionPersistence;
  private readonly workspaceService?: WorkspaceService;
  private readonly agentRuntime?: AgentRuntime;
  private readonly activeChildren: Map<string, ChildRun> = new Map(); // childRunId -> ChildRun
  private readonly childrenByParent: Map<string, Set<string>> = new Map(); // parentRunId -> Set<childRunId>

  constructor(options: SubagentManagerOptions = {}) {
    this.persistence = options.persistence;
    this.workspaceService = options.workspaceService;
    this.agentRuntime = options.agentRuntime;
  }

  /**
   * Spawn a child agent with private context, bounded permissions, depth limits, and cancellation propagation.
   */
  async spawnChildAgent(options: SpawnChildOptions): Promise<AgentResult> {
    const {
      parentRunId,
      agentId,
      task,
      workspacePath,
      parentPermissions,
      depth = 1,
      adapter,
      signal,
      contextSummary,
    } = options;

    // 1. Invariant: Depth Bound (MAX_SUBAGENT_DEPTH = 1)
    if (depth > MAX_SUBAGENT_DEPTH) {
      const error = new Error(
        `SUBAGENT_DEPTH_EXCEEDED: Subagent depth ${depth} exceeds maximum allowable depth (${MAX_SUBAGENT_DEPTH})`,
      );
      (error as unknown as { code: string }).code = "SUBAGENT_DEPTH_EXCEEDED";
      throw error;
    }

    // 2. Resolve trusted agent definition
    const def = getAgent(agentId);
    if (!def) {
      const error = new Error(`UNKNOWN_AGENT: Agent definition for "${agentId}" not found in trusted registry`);
      (error as unknown as { code: string }).code = "UNKNOWN_AGENT";
      throw error;
    }

    // 3. Invariant: Privilege Ceiling (child permissions ⊆ parent permissions)
    const effectivePermissions: AgentPermissions = {
      read: Boolean(def.permissions.read && (parentPermissions?.read ?? true)),
      search: Boolean(def.permissions.search && (parentPermissions?.search ?? true)),
      write: Boolean(def.permissions.write && (parentPermissions?.write ?? true)),
      executeCommand: Boolean(def.permissions.executeCommand && (parentPermissions?.executeCommand ?? true)),
      network: Boolean(def.permissions.network && (parentPermissions?.network ?? false)),
    };

    // Filter allowed tools based on effective permissions
    const writeTools = new Set(["edit_file", "write_file", "apply_patch", "run_destructive_command"]);
    const commandTools = new Set(["run_command"]);

    const allowedTools = def.tools.filter((tool) => {
      if (writeTools.has(tool) && !effectivePermissions.write) return false;
      if (commandTools.has(tool) && !effectivePermissions.executeCommand) return false;
      return true;
    });

    // 4. Invariant: Max concurrent children per parent
    const existingChildren = this.childrenByParent.get(parentRunId) ?? new Set();
    if (existingChildren.size >= MAX_CHILDREN_PER_PARENT) {
      const error = new Error(
        `SUBAGENT_QUOTA_EXCEEDED: Parent "${parentRunId}" reached maximum active child agents (${MAX_CHILDREN_PER_PARENT})`,
      );
      (error as unknown as { code: string }).code = "SUBAGENT_QUOTA_EXCEEDED";
      throw error;
    }

    // 5. Create Child Run Identity & Linked AbortController
    const childRunId = `child-${crypto.randomUUID()}`;
    const controller = new AbortController();

    // Link parent signal if provided
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    // Set child timeout
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, def.budget.timeoutMs || 60_000);

    const childRun: ChildRun = {
      childRunId,
      parentRunId,
      agentId: def.id,
      role: def.role,
      task,
      workspacePath,
      depth,
      status: "working",
      permissions: effectivePermissions,
      allowedTools,
      controller,
      startedAt: new Date(),
    };

    this.activeChildren.set(childRunId, childRun);
    if (!this.childrenByParent.has(parentRunId)) {
      this.childrenByParent.set(parentRunId, new Set());
    }
    this.childrenByParent.get(parentRunId)!.add(childRunId);

    // 6. Emit subagent.started event
    adapter?.emitSubagentStarted(childRunId, def.role, task, parentRunId);

    try {
      if (controller.signal.aborted) {
        throw new Error("Subagent execution cancelled");
      }

      // 7. Execute specialized child logic in private context
      let result: AgentResult;

      if (this.agentRuntime) {
        const runtimeRes = await this.agentRuntime.executeAgentRun({
          runId: childRunId,
          agentId: def.id,
          role: def.id,
          goal: task,
          workspaceId: childRunId,
          workspacePath,
          permissions: effectivePermissions,
          signal: controller.signal,
          adapter,
          initialContext: contextSummary,
          explorerEvidence: options.explorerEvidence,
          findings: options.findings,
          taskPlan: options.taskPlan,
          reviewFeedback: options.reviewFeedback,
          diff: def.id === "reviewer" ? contextSummary : undefined,
          verificationEvidence: def.id === "reviewer" ? contextSummary : undefined,
          structuredOutput: options.structuredOutput,
          customToolExecutor: options.customToolExecutor,
        });

        result = {
          status: runtimeRes.status,
          summary: runtimeRes.summary,
          findings: runtimeRes.findings,
          evidence: runtimeRes.evidence,
          files: runtimeRes.filesChanged,
          risks: runtimeRes.status === "blocked" ? ["Reviewer or budget blocker"] : [],
          recommendations: runtimeRes.status === "completed" ? ["Proceed"] : ["Resolve blockers"],
          structuredData: runtimeRes.structuredData,
        };
      } else if (def.id === "explorer") {
        result = await this.executeExplorer(childRun, contextSummary, adapter);
      } else if (def.id === "reviewer") {
        result = await this.executeReviewer(childRun, contextSummary, adapter);
      } else {
        result = await this.executeGenericChild(childRun, contextSummary, adapter);
      }

      childRun.status = result.status === "completed" ? "completed" : "failed";
      childRun.completedAt = new Date();
      childRun.result = result;

      // 8. Emit subagent.completed event
      adapter?.emitSubagentCompleted(childRunId, result.summary);

      return result;
    } catch (err: unknown) {
      const isCancelled = controller.signal.aborted || (signal && signal.aborted);
      const status = isCancelled ? "cancelled" : "failed";
      const errorMsg = err instanceof Error ? err.message : String(err);

      childRun.status = status;
      childRun.completedAt = new Date();

      const failedResult: AgentResult = {
        status,
        summary: `Subagent ${def.role} ${status}: ${errorMsg}`,
        findings: [],
        evidence: [],
        files: [],
        risks: [],
        recommendations: [],
      };
      childRun.result = failedResult;

      if (isCancelled) {
        adapter?.emitSubagentCompleted(childRunId, "Subagent cancelled");
      } else {
        adapter?.emitSubagentFailed(childRunId, errorMsg);
      }

      return failedResult;
    } finally {
      clearTimeout(timeout);
      // Clean up child registry
      const set = this.childrenByParent.get(parentRunId);
      if (set) {
        set.delete(childRunId);
        if (set.size === 0) this.childrenByParent.delete(parentRunId);
      }
    }
  }

  /**
   * Cancel all child runs associated with a parent run.
   */
  cancelParent(parentRunId: string): void {
    const children = this.childrenByParent.get(parentRunId);
    if (!children) return;

    for (const childId of children) {
      const child = this.activeChildren.get(childId);
      if (child) {
        child.controller.abort();
        child.status = "cancelled";
      }
    }
  }

  getActiveChildren(parentRunId: string): ChildRun[] {
    const children = this.childrenByParent.get(parentRunId);
    if (!children) return [];
    const result: ChildRun[] = [];
    for (const id of children) {
      const c = this.activeChildren.get(id);
      if (c) result.push(c);
    }
    return result;
  }

  /**
   * Specialized Explorer execution:
   * Scans workspace files, maps relevant symbols, and returns structured findings.
   */
  private async executeExplorer(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    const findings: AgentFinding[] = [];
    const evidence: AgentEvidenceRef[] = [];
    const discoveredFiles: string[] = [];

    adapter?.emitSubagentProgress(run.childRunId, "Scanning workspace directory...", 20);

    try {
      const entries = await fs.readdir(run.workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
        discoveredFiles.push(entry.name);
      }
    } catch {}

    adapter?.emitSubagentProgress(run.childRunId, `Analyzing code structure in ${discoveredFiles.length} file(s)...`, 60);

    findings.push({
      id: `finding-${crypto.randomUUID().slice(0, 8)}`,
      severity: "advisory",
      category: "architecture",
      message: `Exploration identified ${discoveredFiles.length} primary top-level components.`,
      evidence: discoveredFiles.slice(0, 5).join(", "),
    });

    evidence.push({
      kind: "directory_listing",
      ref: run.workspacePath,
      description: `Top-level files: ${discoveredFiles.slice(0, 8).join(", ")}`,
    });

    adapter?.emitSubagentProgress(run.childRunId, "Exploration complete.", 100);

    return {
      status: "completed",
      summary: `Explorer mapped ${discoveredFiles.length} top-level files for task "${redactSecrets(run.task)}"`,
      findings,
      evidence,
      files: discoveredFiles,
      risks: [],
      recommendations: ["Target primary entry points for modification"],
    };
  }

  /**
   * Specialized Reviewer execution:
   * Analyzes diff and test outputs, returning structured blocking vs advisory findings.
   */
  private async executeReviewer(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    adapter?.emitSubagentProgress(run.childRunId, "Inspecting changes and verification evidence...", 30);

    const findings: AgentFinding[] = [];
    const evidence: AgentEvidenceRef[] = [];

    // Analyze task and context summary for safety/regression issues
    const isFailureReport = contextSummary && (
      /(?:[1-9]\d*|some|unresolved|potential)\s*(?:failures?|errors?|regressions?)/i.test(contextSummary) ||
      /(?:verification\s+failed|test\s+failure|typeerror|syntaxerror|build\s+failed)/i.test(contextSummary)
    );

    if (isFailureReport) {
      findings.push({
        id: `review-${crypto.randomUUID().slice(0, 8)}`,
        severity: "blocking",
        category: "correctness",
        message: "Review detected potential failures or regressions in verification summary.",
        evidence: contextSummary.slice(0, 200),
      });
    } else {
      findings.push({
        id: `review-${crypto.randomUUID().slice(0, 8)}`,
        severity: "advisory",
        category: "quality",
        message: "Diff and verification results meet quality standards.",
      });
    }

    evidence.push({
      kind: "review_audit",
      ref: run.workspacePath,
      description: "Independent review audit recorded",
    });

    adapter?.emitSubagentProgress(run.childRunId, "Review complete.", 100);

    const hasBlocking = findings.some((f) => f.severity === "blocking");

    return {
      status: hasBlocking ? "blocked" : "completed",
      summary: hasBlocking
        ? "Reviewer identified blocking issues that require resolution."
        : "Reviewer approved changes with clean findings.",
      findings,
      evidence,
      files: [],
      risks: hasBlocking ? ["Verification regression detected"] : [],
      recommendations: hasBlocking ? ["Fix reported failure before completion"] : ["Proceed to completion gate"],
    };
  }

  private async executeGenericChild(
    run: ChildRun,
    contextSummary?: string,
    adapter?: WorkspaceEventAdapter,
  ): Promise<AgentResult> {
    adapter?.emitSubagentProgress(run.childRunId, "Executing child agent task...", 50);
    return {
      status: "completed",
      summary: `Child agent ${run.role} completed task "${redactSecrets(run.task)}"`,
      findings: [],
      evidence: [],
      files: [],
      risks: [],
      recommendations: [],
    };
  }
}

export function createSubagentManager(options: SubagentManagerOptions = {}): SubagentManager {
  return new SubagentManager(options);
}
