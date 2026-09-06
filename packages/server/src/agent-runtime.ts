import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import type { ProviderCatalog, ChatRequest, ChatMessage, StreamEvent, ToolDefinition } from "@codeforge/providers";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, ISessionPersistence, WorkItem } from "@codeforge/sessions";
import { WorkspaceEventAdapter, createWorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { resolveWithinWorkspace } from "./path-security.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { redactSecrets } from "@codeforge/secrets";
import { prepareShellCommand, terminateProcessTree } from "@codeforge/workflow";
import { classifyCommand } from "./command-classifier.js";
import { ApprovalService, type ApprovalRecord } from "./approval-service.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { searchWorkspace } from "./search-service.js";
import { replaceExact, sha256 } from "./edit-service.js";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { buildContextPack, ContextAssembler, createContextAssembler } from "@codeforge/context";
import { createForgeGreenAdvisor, type EfficiencyReceipt, type ForgeGreenAdvisor } from "@codeforge/forge-green";
import {
  ERROR_CODES,
  ROLE_PROMPTS,
  DEFAULT_EXECUTION_BUDGETS,
  type AgentPermissions,
  type AgentExecutionBudget,
  type AgentUsage,
  type AgentStopReason,
  type AgentFinding,
  type AgentEvidenceRef,
  type AgentRoleType,
  type AgentModelSelection,
  type StructuredOutputKind,
  type StructuredAgentResult,
  type ReviewResult,
  validateStructuredAgentResult,
  formatUntrustedData,
} from "@codeforge/agent";
import { ToolBroker, ToolRegistry, createToolBroker, type ToolExecutionRecord } from "@codeforge/tools";
import { ModelExecutionAdapter, createModelExecutionAdapter, normalizeProviderError } from "./model-execution-adapter.js";
import type { UserIntentHoldController } from "./user-intent-hold.js";

export interface AgentRuntimeRequest {
  runId: string;
  agentId: string;
  role: AgentRoleType | string;
  goal: string;
  workspaceId: string;
  workspacePath: string;
  permissions: AgentPermissions;
  modelSelection?: AgentModelSelection;
  executionBudget?: AgentExecutionBudget;
  signal?: AbortSignal;
  initialContext?: string;
  reviewFeedback?: string;
  taskPlan?: string;
  explorerEvidence?: AgentEvidenceRef[];
  findings?: AgentFinding[];
  diff?: string;
  verificationEvidence?: string;
  authorityState?: string;
  userId?: string;
  adapter?: WorkspaceEventAdapter;
  customToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string | undefined>;
  structuredOutput?: StructuredOutputKind;
  maxStructuredOutputRepairs?: number;
  userIntentHold?: UserIntentHoldController;
}

export interface AgentContextMetrics {
  candidateFileCount: number;
  candidateSymbolCount: number;
  selectedFileCount: number;
  selectedEvidenceCount: number;
  contextBytes: number;
  estimatedInputTokens: number;
  contextMaximum: number;
  reservedOutputTokens: number;
  repositoryGeneration?: number;
  contextHash?: string;
  reasonCodes?: string[];
  efficiencyReceipt?: EfficiencyReceipt;
}

export interface AgentRuntimeResult {
  status: "completed" | "blocked" | "cancelled" | "failed";
  summary: string;
  findings: AgentFinding[];
  evidence: AgentEvidenceRef[];
  toolExecutions: ToolExecutionRecord[];
  usage: AgentUsage;
  stopReason: AgentStopReason;
  filesChanged: string[];
  error?: string;
  structuredData?: StructuredAgentResult;
  contextMetrics?: AgentContextMetrics;
}

export type DurableToolExecutionState = "requested" | "started" | "completed" | "observation_recorded" | "failed" | "cancelled";
export type ToolExecutionClass = "read_only" | "write" | "command" | "network";
export type RecoveryDisposition = "safe_to_retry" | "requires_revalidation" | "already_completed" | "unknown_side_effect" | "blocked";

export interface DurableToolExecutionRecord {
  kind: "agent_tool_execution";
  id: string;
  sessionId?: string;
  runId: string;
  agentId: string;
  turnId: string;
  toolName: string;
  argumentsHash: string;
  executionClass: ToolExecutionClass;
  state: DurableToolExecutionState;
  recoveryDisposition: RecoveryDisposition;
  startedAt?: string;
  completedAt?: string;
  resultHash?: string;
  createdAt: string;
  updatedAt: string;
}

export function classifyToolRecovery(record: Pick<DurableToolExecutionRecord, "executionClass" | "state">): RecoveryDisposition {
  if (record.state === "observation_recorded") return "already_completed";
  if (record.state === "completed") return record.executionClass === "read_only" ? "already_completed" : "requires_revalidation";
  if (record.state === "requested") return "safe_to_retry";
  if (record.state === "started") {
    if (record.executionClass === "read_only") return "safe_to_retry";
    if (record.executionClass === "write") return "requires_revalidation";
    return "unknown_side_effect";
  }
  return "blocked";
}

/** Reclassifies durable records after a restart; it never executes a tool. */
export async function recoverDurableToolExecutions(persistence: ISessionPersistence, runId?: string): Promise<DurableToolExecutionRecord[]> {
  const all = await persistence.getWorkItemsByKind("agent_tool_execution");
  const records = all.filter((item) => !runId || (item as unknown as DurableToolExecutionRecord).runId === runId) as unknown as DurableToolExecutionRecord[];
  const recovered: DurableToolExecutionRecord[] = [];
  for (const record of records) {
    const recoveryDisposition = classifyToolRecovery(record);
    const next = { ...record, recoveryDisposition, updatedAt: new Date().toISOString() };
    await persistence.upsertWorkItem(next as unknown as WorkItem);
    recovered.push(next);
  }
  return recovered;
}

const MAX_FILE_READ_BYTES = 100 * 1024;
const MAX_FILE_READ_LINES = 400;
const MAX_LIST_FILES_ENTRIES = 500;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function truncateOutput(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  const sliced = buf.subarray(0, maxBytes).toString("utf-8");
  return `${sliced}\n[TRUNCATED ${label}: output exceeded ${maxBytes} bytes, shown first ${maxBytes}]`;
}

function boundedListOutput(entries: string[], maxEntries: number): string {
  if (entries.length <= maxEntries) return entries.join("\n");
  return `${entries.slice(0, maxEntries).join("\n")}\n[TRUNCATED: ${entries.length} entries total, showing first ${maxEntries}]`;
}

export type TurnStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_for_approval"
  | "waiting_for_question"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export interface TurnState {
  turnId: string;
  sessionId: string;
  status: TurnStatus;
  userMessage: string;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
  agentId?: string;
  modelId?: string;
  providerId?: string;
  /**
   * Set when the loop stopped because it ran out of iterations rather than because the agent
   * finished. Exhausting a budget is not success and must never complete the turn.
   */
  budgetExhausted?: boolean;
}

export interface ApprovalRequest {
  approvalId: string;
  tool: string;
  action: string;
  description: string;
  risk: "safe" | "moderate" | "high" | "critical";
  scope?: string;
  resolve: (decision: "allow_once" | "allow_session" | "deny") => void;
}

export interface QuestionRequest {
  questionId: string;
  turnId?: string;
  prompt: string;
  options?: string[];
  resolve: (answer: string) => void;
}

export interface AgentRuntimeOptions {
  sessionId: string;
  eventStore: EventStore;
  persistence: ISessionPersistence;
  firewall: ForgeZero;
  providerCatalog: ProviderCatalog;
  workspacePath?: string;
  userId?: string;
  demoMode?: boolean;
  repositoryIntelligenceFactory?: () => RepositoryIntelligence;
  forgeGreen?: ForgeGreenAdvisor;
  userIntentHold?: UserIntentHoldController;
  /** Test-only synchronization point at the real post-approval execution boundary. */
  afterApprovalResolvedBoundary?: () => Promise<void>;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** Sentinel returned by parseToolArgs when arguments are genuinely un-parseable. */
export const PARSE_FAILED = Symbol("parse_failed");

/**
 * Parse tool-call arguments tolerantly. Handles well-formed JSON, empty args (→ {}), and the
 * common small-model mistake of concatenating multiple JSON objects by extracting the FIRST
 * balanced object. Returns PARSE_FAILED only when nothing usable can be recovered.
 */
export function parseToolArgs(argsJson: string): unknown {
  const trimmed = (argsJson ?? "").trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Extract the first balanced {...} object, respecting strings/escapes.
    const start = trimmed.indexOf("{");
    if (start === -1) return PARSE_FAILED;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            return PARSE_FAILED;
          }
        }
      }
    }
    return PARSE_FAILED;
  }
}

export class AgentRuntime {
  private readonly sessionId: string;
  private readonly eventStore: EventStore;
  private readonly persistence: ISessionPersistence;
  private readonly firewall: ForgeZero;
  private readonly providerCatalog: ProviderCatalog;
  private readonly workspacePath?: string;
  private readonly userId: string;
  private demoMode: boolean;
  private modelSelection: ModelSelection | null = null;
  private readonly activeTurns: Map<string, TurnState> = new Map();
  private readonly pendingSteeringByTurn: Map<string, string[]> = new Map();
  private readonly pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private readonly pendingQuestions: Map<string, QuestionRequest> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();
  private readonly messageHistory: ChatMessage[] = [];
  private turnCount = 0;
  private maxIterations = 50;
  private readonly approvalService: ApprovalService;
  private readonly repositoryIntelligenceFactory: () => RepositoryIntelligence;
  private readonly forgeGreen: ForgeGreenAdvisor;
  private readonly userIntentHold?: UserIntentHoldController;
  private readonly afterApprovalResolvedBoundary?: () => Promise<void>;
  private readonly processedSteerIds = new Map<string, Set<string>>();
  private readonly recoveryGenerationByTurn = new Map<string, number>();
  private readonly recoveryRequiredTurns = new Set<string>();
  private readonly recoveryOriginalStatusByTurn = new Map<string, Exclude<TurnStatus, "idle" | "completed" | "failed" | "cancelled">>();

  constructor(options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.workspacePath = options.workspacePath;
    this.userId = options.userId ?? "anonymous";
    this.forgeGreen = options.forgeGreen ?? createForgeGreenAdvisor({ enabled: process.env.CODEFORGE_FORGREEN !== "0" });
    this.userIntentHold = options.userIntentHold;
    this.afterApprovalResolvedBoundary = options.afterApprovalResolvedBoundary;
    this.demoMode = options.demoMode ?? false;
    this.repositoryIntelligenceFactory = options.repositoryIntelligenceFactory ?? (() => createRepositoryIntelligence({
      cacheRoot: path.join(os.tmpdir(), "codeforge-repository-indexes"),
      maxFiles: 25_000,
      maxFileBytes: MAX_FILE_READ_BYTES,
    }));
    this.approvalService = new ApprovalService({ defaultTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS });
  }

  /** Must be awaited once before first use — recreates durable intent at a process boundary. */
  async init(): Promise<void> {
    await this.hydratePersistedTurns();
  }

  /**
   * Update demo/real mode after construction. Lets the server flip a session to real execution
   * once a provider is connected post-boot (the normal first-run flow), without recreating the runtime.
   */
  setDemoMode(demoMode: boolean): void {
    this.demoMode = demoMode;
    if (!demoMode) {
      for (const t of this.activeTurns.values()) {
        if (t.status === "running" && !t.agentId) {
          t.status = "completed";
          t.completedAt = new Date();
        }
      }
    }
  }

  setModelSelection(selection: ModelSelection): void {
    this.modelSelection = { providerId: selection.providerId, modelId: selection.modelId };
  }

  clearModelSelection(): void {
    this.modelSelection = null;
  }

  getModelSelection(): ModelSelection | null {
    return this.modelSelection ? { ...this.modelSelection } : null;
  }

  /**
   * Recreates only durable intent at a process boundary. No model stream, child process,
   * promise, tool continuation, or approval continuation is ever restored here.
   */
  private async hydratePersistedTurns(): Promise<void> {
    const workItems = await this.persistence.getWorkItems(this.sessionId);
    const queuedSteers = this.userIntentHold?.queuedSteers(this.sessionId) ?? [];
    for (const record of await this.persistence.getTurns(this.sessionId)) {
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "idle") continue;
      const originalStatus = record.status as Exclude<TurnStatus, "idle" | "completed" | "failed" | "cancelled">;
      const priorRecovery = workItems.find((item) => item.kind === "agent_turn_recovery" && item.turnId === record.id);
      const generation = priorRecovery?.kind === "agent_turn_recovery" ? priorRecovery.generation : 1;
      const state: TurnState = {
        turnId: record.id,
        sessionId: record.sessionId,
        status: originalStatus,
        userMessage: record.userMessage,
        startedAt: record.startedAt ? new Date(record.startedAt) : new Date(),
        ...(record.completedAt ? { completedAt: new Date(record.completedAt) } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
      };
      this.recoveryGenerationByTurn.set(record.id, generation);
      this.recoveryOriginalStatusByTurn.set(record.id, originalStatus);

      const persistedSteers = queuedSteers.filter((steer) => steer.turnId === record.id);
      if (persistedSteers.length > 0) {
        this.pendingSteeringByTurn.set(record.id, persistedSteers.map((steer) => steer.message));
        this.processedSteerIds.set(record.id, new Set(persistedSteers.map((steer) => steer.steerId)));
      }

      const pendingApproval = workItems.find((item) => item.kind === "approval" && item.turnId === record.id && !item.decision);
      const pendingQuestion = workItems.find((item) => item.kind === "question" && item.turnId === record.id && item.answer === undefined);
      const canRestoreApprovalWait = originalStatus === "waiting_for_approval" && pendingApproval?.kind === "approval";
      const canRestoreQuestionWait = originalStatus === "waiting_for_question" && pendingQuestion?.kind === "question";
      if (canRestoreApprovalWait) {
        const createdAt = Date.parse(pendingApproval.createdAt);
        this.approvalService.restorePending({
          approvalId: pendingApproval.id,
          turnId: record.id,
          tool: pendingApproval.tool,
          action: pendingApproval.action,
          description: pendingApproval.description,
          risk: pendingApproval.risk,
          scope: pendingApproval.scope,
          state: "pending",
          createdAt,
          expiresAt: createdAt + DEFAULT_APPROVAL_TIMEOUT_MS,
        });
      } else if (canRestoreQuestionWait) {
        this.pendingQuestions.set(pendingQuestion.id, {
          questionId: pendingQuestion.id,
          turnId: record.id,
          prompt: pendingQuestion.prompt,
          ...(pendingQuestion.options ? { options: pendingQuestion.options } : {}),
          resolve: () => undefined,
        });
      } else {
        state.status = "recovering";
        this.recoveryRequiredTurns.add(record.id);
      }

      this.activeTurns.set(record.id, state);
      if (state.status === "recovering") {
        const session = await this.persistence.getSession(this.sessionId);
        if (session) await this.persistence.upsertSession({ ...session, status: "recovering", updatedAt: new Date().toISOString() });
      }
      if (!priorRecovery || priorRecovery.kind !== "agent_turn_recovery" || priorRecovery.state === "hydrated") {
        const staleExecutionCount = await this.invalidateStaleExecutions(record.id, workItems);
        const recoveryState = state.status === "recovering" ? "replan_required" as const : "hydrated" as const;
        await this.persistRecovery(record.id, originalStatus, recoveryState, generation, staleExecutionCount,
          state.status === "recovering" ? "Interrupted execution requires a fresh plan from current durable facts." : "Durable wait state restored without restoring an execution continuation.");
        await this.persistTurn(state);
        const adapter = this.createAdapter();
        await adapter.emitTurnRecovery(record.id, "hydrated", generation);
        if (staleExecutionCount > 0) await adapter.emitTurnRecovery(record.id, "stale_execution_invalidated", generation, `${staleExecutionCount} stale execution record(s) classified.`);
        if (state.status === "recovering") await adapter.emitTurnRecovery(record.id, "replan_required", generation, "Interrupted execution will not be replayed.");
      }
    }
  }

  private async invalidateStaleExecutions(turnId: string, workItems: WorkItem[]): Promise<number> {
    const executions = workItems.filter((item) => item.kind === "agent_tool_execution" && item.turnId === turnId) as unknown as DurableToolExecutionRecord[];
    for (const execution of executions) {
      const recoveryDisposition = classifyToolRecovery(execution);
      await this.persistence.upsertWorkItem({ ...execution, recoveryDisposition, updatedAt: new Date().toISOString() } as unknown as WorkItem);
    }
    return executions.filter((execution) => execution.state !== "observation_recorded").length;
  }

  private async persistRecovery(
    turnId: string,
    originalStatus: Exclude<TurnStatus, "idle" | "completed" | "failed" | "cancelled">,
    state: "hydrated" | "replan_required" | "replan_started" | "resumed" | "blocked",
    generation: number,
    staleExecutionCount: number,
    detail?: string,
  ): Promise<void> {
    const prior = await this.persistence.getWorkItem(`agent-turn-recovery-${turnId}`);
    const createdAt = prior?.kind === "agent_turn_recovery" ? prior.createdAt : new Date().toISOString();
    await this.persistence.upsertWorkItem({
      kind: "agent_turn_recovery",
      id: `agent-turn-recovery-${turnId}`,
      sessionId: this.sessionId,
      turnId,
      originalStatus,
      state,
      generation,
      staleExecutionCount,
      createdAt,
      updatedAt: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * Execute an autonomous agent invocation independently of high-level orchestrator.
   * Runs the full role-specific context assembly, provider execution, tool brokering,
   * loop detection, budget governance, and structured result extraction.
   */
  async executeAgentRun(req: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const budget: AgentExecutionBudget =
      req.executionBudget ??
      DEFAULT_EXECUTION_BUDGETS[req.role] ??
      DEFAULT_EXECUTION_BUDGETS.default!;

    const toolBroker = createToolBroker();
    const modelAdapter = createModelExecutionAdapter(this.providerCatalog, this.firewall, this.forgeGreen);
    const contextAssembler = createContextAssembler(budget.maxContextTokens, this.forgeGreen);
    const adapter = req.adapter ?? this.createAdapter();

    const toolExecutions: ToolExecutionRecord[] = [];
    const changedFiles = new Set<string>();
    const findings: AgentFinding[] = [];
    const evidence: AgentEvidenceRef[] = [];
    const toolCallHistory: string[] = [];
    let intelligence: RepositoryIntelligence | undefined;

    const totalUsage: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      toolCount: 0,
    };

    if (!(await this.persistence.getSession(this.sessionId))) {
      await this.persistence.upsertSession({
        id: this.sessionId,
        title: redactSecrets(req.goal.slice(0, 80)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "running",
      });
    }

    adapter.emitAgentStarted(req.agentId, req.role, req.runId);

    try {
      if (req.signal?.aborted) {
        throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Agent run cancelled before start.`);
      }

      // 1. Context Assembly
      let indexStatus: ReturnType<RepositoryIntelligence["status"]> | undefined;
      try {
        intelligence = this.repositoryIntelligenceFactory();
        await intelligence.openWorkspace(req.workspacePath);
        indexStatus = intelligence.status();
        if (indexStatus.fileCount === 0 || indexStatus.state === "NOT_INDEXED" || indexStatus.state === "ERROR") {
          await intelligence.indexWorkspace(req.signal);
        } else {
          await intelligence.refresh(undefined, req.signal);
        }
        indexStatus = intelligence.status();
      } catch {
        // Fallback: If repository intelligence is unavailable, broken, or unsupported,
        // degrade gracefully to safe conventional execution without throwing
        intelligence = undefined;
      }

      const assembled = await contextAssembler.assemble({
        role: req.role,
        goal: req.goal,
        workspacePath: req.workspacePath,
        contextWindow: budget.maxContextTokens,
        intelligence,
        explorerEvidence: req.explorerEvidence,
        findings: req.findings,
        diff: req.diff,
        verificationEvidence: req.verificationEvidence,
        taskPlan: req.taskPlan,
        authorityState: req.authorityState,
      });

      if (assembled.evidence) {
        for (const ev of assembled.evidence) {
          evidence.push({
            kind: ev.source,
            ref: ev.path ?? ev.symbol ?? req.workspacePath,
            description: ev.reasons?.join(", ") ?? "Context evidence",
          });
        }
      }

      const messages: ChatMessage[] = [
        { role: "system", content: assembled.systemPrompt },
        { role: "user", content: assembled.contextPrompt },
      ];

      if (req.initialContext) {
        messages.push({
          role: "user",
          content: `Additional run context:\n${formatUntrustedData(req.initialContext, "run context")}`,
        });
      }

      if (req.reviewFeedback) {
        messages.push({
          role: "user",
          content: `Structured Review Findings to address:\n${req.reviewFeedback}`,
        });
      }

      let turnCount = 0;
      let toolCallCount = 0;
      let writeCallCount = 0;
      let commandCallCount = 0;
      let finalSummary = "";
      let stopReason: AgentStopReason = "completed";
      let structuredData: StructuredAgentResult | undefined;
      let structuredRepairs = 0;
      const expectedStructuredOutput = req.structuredOutput;
      const maxStructuredOutputRepairs = Math.max(0, req.maxStructuredOutputRepairs ?? 1);
      const contextMetrics: AgentContextMetrics = {
        candidateFileCount: indexStatus?.fileCount ?? 0,
        candidateSymbolCount: indexStatus?.symbolCount ?? 0,
        selectedFileCount: assembled.receipt?.retrievedFiles.length ?? assembled.evidence.filter((item) => item.source === "file" || item.source === "search").length,
        selectedEvidenceCount: assembled.evidence.length,
        contextBytes: Buffer.byteLength(messages.map((message) => message.content).join("\n"), "utf8"),
        estimatedInputTokens: assembled.tokenEstimate,
        contextMaximum: budget.maxContextTokens,
        reservedOutputTokens: assembled.budget.reservedOutput,
        repositoryGeneration: assembled.receipt?.repositoryGeneration ?? indexStatus?.generation ?? 1,
        contextHash: assembled.receipt?.contextHash,
        reasonCodes: assembled.receipt?.reasonCodes,
        efficiencyReceipt: assembled.efficiencyReceipt,
      };

      // 2. Multi-turn Model & Tool Loop
      while (turnCount < budget.maxModelTurns) {
        if (req.signal?.aborted) {
          throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Agent execution was cancelled.`);
        }

        turnCount++;
        totalUsage.requestCount++;
        const modelTurnId = `${req.runId}:${req.agentId}:${turnCount}`;
        await this.userIntentHold?.waitForDispatch(this.sessionId, "model");
        const modelTurnCreatedAt = new Date().toISOString();
        const persistModelTurn = async (state: "created" | "provider_request_started" | "provider_response_completed" | "tool_requests_decoded" | "agent_result_completed" | "failed" | "cancelled"): Promise<void> => {
          await this.persistence.upsertWorkItem({
            kind: "agent_model_turn",
            id: `agent-model-turn-${sha256(modelTurnId)}`,
            sessionId: this.sessionId,
            runId: req.runId,
            agentId: req.agentId,
            turnId: modelTurnId,
            state,
            createdAt: modelTurnCreatedAt,
            updatedAt: new Date().toISOString(),
          } as unknown as WorkItem);
        };
        await persistModelTurn("created");

        // Get tools available for this role
        const availableTools = toolBroker.getRegistry().getForRole(req.role, req.permissions);

        // Execute model request
        let response;
        try {
          await persistModelTurn("provider_request_started");
          response = await modelAdapter.execute({
            modelSelection: req.modelSelection ?? (this.modelSelection ? { providerId: this.modelSelection.providerId, modelId: this.modelSelection.modelId } : undefined),
            messages,
            tools: availableTools,
            signal: req.signal,
            userId: req.userId ?? this.userId,
            authorityState: req.authorityState ?? "canonical",
            dedupeScope: req.runId,
          });
          await persistModelTurn("provider_response_completed");
        } catch (err: unknown) {
          const norm = normalizeProviderError(err);
          throw new Error(`[${norm.code}] ${norm.message}`);
        }

        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;
        totalUsage.provider = response.providerId;
        totalUsage.model = response.modelId;
        contextMetrics.efficiencyReceipt = this.forgeGreen.createReceipt({
          workspaceId: req.workspaceId,
          repositoryGeneration: contextMetrics.repositoryGeneration ?? 1,
          requestedTokens: contextMetrics.estimatedInputTokens,
          deliveredTokens: contextMetrics.estimatedInputTokens,
          reasonCodes: [
            ...(response.optimization?.duplicateSuppressed ? ["duplicate_request_suppressed" as const] : []),
            ...(response.optimization?.promptPrefixCacheHit ? ["stable_prefix_reused" as const] : []),
          ],
          ...(this.userIntentHold ? { interactiveEfficiency: this.userIntentHold.metrics(this.sessionId) } : {}),
        });

        if (response.text) {
          finalSummary = response.text;
          messages.push({ role: "assistant", content: response.text });
        }

        // If no tools requested -> Assistant finished
        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (expectedStructuredOutput) {
            const validation = validateStructuredAgentResult(expectedStructuredOutput, finalSummary);
            if (!validation.success) {
              if (structuredRepairs < maxStructuredOutputRepairs && turnCount < budget.maxModelTurns) {
                structuredRepairs++;
                messages.push({
                  role: "user",
                  content: `Your prior response was rejected: ${validation.error}. Return only a valid JSON object for the required ${expectedStructuredOutput} schema.`,
                });
                continue;
              }
              const error = ERROR_CODES.AGENT_INVALID_STRUCTURED_OUTPUT;
              adapter.emitTurnFailed(req.runId, `${error}: ${validation.error}`);
              return {
                status: "blocked",
                summary: `${error}: ${validation.error}`,
                findings,
                evidence,
                toolExecutions,
                usage: totalUsage,
                stopReason: "error",
                filesChanged: Array.from(changedFiles),
                error,
                contextMetrics,
              };
            }
            structuredData = validation.data;
          }
          await persistModelTurn("agent_result_completed");
          stopReason = "completed";
          break;
        }

        await persistModelTurn("tool_requests_decoded");

        // Tool calls requested
        const assistantToolMessage: ChatMessage = {
          role: "assistant",
          content: response.text || "",
          toolCalls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
        messages.push(assistantToolMessage);

        for (const tc of response.toolCalls) {
          if (req.signal?.aborted) {
            throw new Error(`[${ERROR_CODES.AGENT_CANCELLED}] Agent execution was cancelled.`);
          }

          // Budget checks
          if (toolCallCount >= budget.maxToolCalls) {
            stopReason = "budget_exhausted";
            break;
          }

          const toolDef = toolBroker.getRegistry().get(tc.name);
          const roleIsReadOnly = req.role === "explorer" || req.role === "planner" || req.role === "reviewer";
          if (toolDef && !toolDef.readOnly && !roleIsReadOnly && req.permissions.write) {
            if (budget.maxWriteToolCalls !== undefined && writeCallCount >= budget.maxWriteToolCalls) {
              stopReason = "budget_exhausted";
              break;
            }
          }
          if (tc.name === "run_command" && !roleIsReadOnly && req.permissions.executeCommand) {
            if (budget.maxCommandExecutions !== undefined && commandCallCount >= budget.maxCommandExecutions) {
              stopReason = "budget_exhausted";
              break;
            }
          }

          // Loop Detection Check: Fingerprint
          const fingerprint = `${tc.name}:${tc.arguments.trim()}`;
          toolCallHistory.push(fingerprint);

          // Check if last 3 identical
          const historyLen = toolCallHistory.length;
          if (historyLen >= 3) {
            const last3 = toolCallHistory.slice(-3);
            if (last3[0] === last3[1] && last3[1] === last3[2]) {
              const err = `[${ERROR_CODES.AGENT_TOOL_LOOP_DETECTED}] Deterministic loop detected: tool "${tc.name}" called 3 consecutive times with identical arguments.`;
              adapter.emitToolExecutionBlocked(req.runId, tc.id, tc.name, ERROR_CODES.AGENT_TOOL_LOOP_DETECTED);
              stopReason = "tool_loop_detected";
              return {
                status: "blocked",
                summary: err,
                findings,
                evidence,
                toolExecutions,
                usage: totalUsage,
                stopReason,
                filesChanged: Array.from(changedFiles),
                error: ERROR_CODES.AGENT_TOOL_LOOP_DETECTED,
              };
            }
          }

          // Check 6-turn oscillation (A-B-A-B-A-B)
          if (historyLen >= 6) {
            const last6 = toolCallHistory.slice(-6);
            if (last6[0] === last6[2] && last6[2] === last6[4] && last6[1] === last6[3] && last6[3] === last6[5] && last6[0] !== last6[1]) {
              const err = `[${ERROR_CODES.AGENT_TOOL_LOOP_DETECTED}] Deterministic tool oscillation loop detected between "${last6[0]}" and "${last6[1]}".`;
              adapter.emitToolExecutionBlocked(req.runId, tc.id, tc.name, ERROR_CODES.AGENT_TOOL_LOOP_DETECTED);
              stopReason = "tool_loop_detected";
              return {
                status: "blocked",
                summary: err,
                findings,
                evidence,
                toolExecutions,
                usage: totalUsage,
                stopReason,
                filesChanged: Array.from(changedFiles),
                error: ERROR_CODES.AGENT_TOOL_LOOP_DETECTED,
              };
            }
          }

          adapter.emitToolCallStarted(req.runId, tc.id, tc.name, req.agentId);
          adapter.emitToolExecutionStarted(req.runId, tc.id, tc.name, tc.arguments);

          const toolDefForDurability = toolBroker.getRegistry().get(tc.name);
          const executionClass: ToolExecutionClass = tc.name === "run_command"
            ? "command"
            : toolDefForDurability?.readOnly ? "read_only"
            : "write";
          const executionId = `agent-tool-${sha256(`${req.runId}\0${req.agentId}\0${modelTurnId}\0${tc.id}\0${tc.name}\0${tc.arguments}`)}`;
          const now = new Date().toISOString();
          const durableExecution: DurableToolExecutionRecord = {
            kind: "agent_tool_execution",
            id: executionId,
            sessionId: this.sessionId,
            runId: req.runId,
            agentId: req.agentId,
            turnId: modelTurnId,
            toolName: tc.name,
            argumentsHash: sha256(tc.arguments),
            executionClass,
            state: "requested",
            recoveryDisposition: "safe_to_retry",
            createdAt: now,
            updatedAt: now,
          };
          this.persistence.upsertWorkItem(durableExecution as unknown as WorkItem);
          durableExecution.state = "started";
          durableExecution.startedAt = new Date().toISOString();
          durableExecution.recoveryDisposition = classifyToolRecovery(durableExecution);
          durableExecution.updatedAt = durableExecution.startedAt;
          this.persistence.upsertWorkItem(durableExecution as unknown as WorkItem);

          const toolExec = await toolBroker.executeTool(
            { name: tc.name, arguments: tc.arguments },
            {
              workspacePath: req.workspacePath,
              permissions: req.permissions,
              role: req.role,
              runId: req.runId,
              agentId: req.agentId,
              signal: req.signal,
              customExecutor: async (name, args) => {
                if (name.startsWith("repo_")) {
                  return this.executeRepositoryTool(name, args, req.signal ?? new AbortController().signal, req.workspacePath, intelligence);
                }
                return req.customToolExecutor?.(name, args);
              },
            },
          );

          toolExecutions.push(toolExec);
          durableExecution.state = toolExec.success ? "completed" : "failed";
          durableExecution.completedAt = new Date().toISOString();
          durableExecution.resultHash = sha256(toolExec.output);
          durableExecution.recoveryDisposition = classifyToolRecovery(durableExecution);
          durableExecution.updatedAt = durableExecution.completedAt;
          this.persistence.upsertWorkItem(durableExecution as unknown as WorkItem);
          toolCallCount++;
          totalUsage.toolCount++;
          if (toolDef && !toolDef.readOnly) writeCallCount++;
          if (tc.name === "run_command") commandCallCount++;

          if (toolExec.success && (tc.name === "write_file" || tc.name === "edit_file")) {
            const parsedArgs = parseToolArgs(tc.arguments);
            if (typeof parsedArgs === "object" && parsedArgs && "path" in parsedArgs) {
              changedFiles.add(String((parsedArgs as { path: string }).path));
            }
          }

          if (toolExec.success) {
            adapter.emitToolExecutionCompleted(req.runId, tc.id, tc.name, toolExec.output);
          } else {
            adapter.emitToolExecutionFailed(req.runId, tc.id, tc.name, toolExec.error ?? toolExec.output);
          }

          messages.push({
            role: "tool",
            content: toolExec.output,
            toolCallId: tc.id,
          });
          durableExecution.state = "observation_recorded";
          durableExecution.recoveryDisposition = classifyToolRecovery(durableExecution);
          durableExecution.updatedAt = new Date().toISOString();
          this.persistence.upsertWorkItem(durableExecution as unknown as WorkItem);

          // Permission and confinement violations are authority-boundary
          // failures, not ordinary tool errors. Stop this run rather than
          // granting an adversarial model further attempts at the boundary.
          if (!toolExec.success && (
            toolExec.error === ERROR_CODES.TOOL_PERMISSION_DENIED ||
            toolExec.error === ERROR_CODES.TOOL_PATH_ESCAPE ||
            toolExec.error === ERROR_CODES.TOOL_WORKSPACE_ESCAPE ||
            toolExec.error === ERROR_CODES.TOOL_SENSITIVE_PATH_DENIED
          )) {
            stopReason = "error";
            return {
              status: "blocked",
              summary: toolExec.output,
              findings,
              evidence,
              toolExecutions,
              usage: totalUsage,
              stopReason,
              filesChanged: Array.from(changedFiles),
              error: toolExec.error,
            };
          }
        }

        if (stopReason === "budget_exhausted") {
          break;
        }
      }

      if (turnCount >= budget.maxModelTurns && stopReason !== "completed") {
        stopReason = "budget_exhausted";
      }

      // 3. Extract role-specific data. Review authority is only accepted from a validated schema.
      if (expectedStructuredOutput === "reviewer" && structuredData) {
        const review = structuredData as ReviewResult;
        findings.push(...review.findings);
        finalSummary = review.summary;
      } else if (expectedStructuredOutput === "explorer" && structuredData) {
        const explored = structuredData as import("@codeforge/agent").ExplorerResult;
        findings.push(...explored.findings);
        evidence.push(...explored.evidence);
      } else if (req.role === "explorer") {
        findings.push({
          id: `explore-${crypto.randomUUID().slice(0, 8)}`,
          severity: "advisory",
          category: "architecture",
          message: finalSummary.slice(0, 300) || "Exploration completed",
          evidence: Array.from(changedFiles).join(", "),
        });
      }

      const status = stopReason === "completed"
        ? (expectedStructuredOutput === "reviewer" && (structuredData as ReviewResult | undefined)?.verdict === "revision_required" ? "blocked" : "completed")
        : "blocked";

      const result: AgentRuntimeResult = {
        status,
        summary: finalSummary || `Agent ${req.role} ${status}`,
        findings,
        evidence,
        toolExecutions,
        usage: totalUsage,
        stopReason,
        filesChanged: Array.from(changedFiles),
        structuredData,
        contextMetrics,
      };

      if (status === "completed") {
        adapter.emitAgentCompleted(req.agentId, req.runId);
      } else {
        adapter.emitTurnFailed(req.runId, result.summary);
      }

      return result;
    } catch (err: unknown) {
      const isCancelled = req.signal?.aborted || (err instanceof Error && err.message.includes(ERROR_CODES.AGENT_CANCELLED));
      const status = isCancelled ? "cancelled" : "failed";
      const errorMsg = err instanceof Error ? err.message : String(err);

      adapter.emitTurnFailed(req.runId, errorMsg);

      return {
        status,
        summary: `Agent ${req.role} ${status}: ${errorMsg}`,
        findings,
        evidence,
        toolExecutions,
        usage: totalUsage,
        stopReason: isCancelled ? "cancelled" : "error",
        filesChanged: Array.from(changedFiles),
        error: errorMsg,
      };
    } finally {
      await intelligence?.closeWorkspace().catch(() => undefined);
    }
  }

  async startTurn(userMessage: string, eventAdapter?: WorkspaceEventAdapter): Promise<string> {
    // Single-turn exclusivity per session for real active turns
    if (this.demoMode) {
      for (const t of this.activeTurns.values()) {
        if (t.status === "running") {
          t.status = "completed";
          t.completedAt = new Date();
        }
      }
    } else {
      const running = Array.from(this.activeTurns.values()).find(
        (t) => t.status === "running" || t.status === "paused" || t.status === "waiting_for_approval" || t.status === "waiting_for_question" || t.status === "recovering",
      );
      if (running) {
        throw new Error(`A turn (${running.turnId}) is already active in session ${this.sessionId}. Steer the active turn or wait for it to complete.`);
      }
    }

    const turnId = crypto.randomUUID();
    this.turnCount++;

    const state: TurnState = {
      turnId,
      sessionId: this.sessionId,
      status: "running",
      userMessage,
      startedAt: new Date(),
    };

    this.activeTurns.set(turnId, state);

    await this.persistence.upsertSession({
      id: this.sessionId,
      title: userMessage.slice(0, 80),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    });
    await this.persistTurn(state);

    // A workflow supplies its run-scoped adapter. Ordinary Chat keeps its existing session-scoped
    // adapter, so the UI never mistakes a chat tool call for autonomous workflow evidence.
    const adapter = eventAdapter ?? this.createAdapter();
    adapter.emitStatusChanged("idle", "running");
    adapter.emitTurnStarted(turnId, userMessage);

    const abortController = new AbortController();
    this.abortControllers.set(turnId, abortController);

    if (!this.demoMode) {
      this.executeTurn(turnId, userMessage, adapter, abortController.signal).catch(async (error) => {
        const turnState = this.activeTurns.get(turnId);
        if (turnState && turnState.status === "running") {
          turnState.status = "failed";
          turnState.error = error instanceof Error ? error.message : String(error);
          this.activeTurns.set(turnId, turnState);
          await this.persistTurn(turnState);
          await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);
          await adapter.emitTurnFailed(turnId, turnState.error);
          adapter.emitStatusChanged("running", "failed");
        }
      });
    }

    return turnId;
  }

  async steerTurn(turnId: string, steering: string, steerId?: string): Promise<void> {
    return this.queueSteer(turnId, steering, steerId);
  }

  async queueSteer(turnId: string, steering: string, steerId?: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn ${turnId} not found`);
    }
    const isTerminal = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
    if (isTerminal) {
      throw new Error(`Cannot steer turn ${turnId} in terminal state ${state.status}`);
    }
    const id = steerId ?? crypto.randomUUID();
    const processed = this.processedSteerIds.get(turnId) ?? new Set<string>();
    if (processed.has(id)) return;
    processed.add(id);
    this.processedSteerIds.set(turnId, processed);
    const pending = this.pendingSteeringByTurn.get(turnId) ?? [];
    pending.push(steering);
    this.pendingSteeringByTurn.set(turnId, pending);

    // Durable exactly-once steer acceptance must complete before this call resolves, so a client
    // that saw an HTTP 2xx can kill the process and a fresh one still observes the queued steer.
    await this.userIntentHold?.queueSteer(this.sessionId, turnId, turnId, steering, id);

    const adapter = this.createAdapter();
    await adapter.emitTurnSteered(turnId, steering);
  }

  async pauseTurn(turnId: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn ${turnId} not found`);
    }
    if (state.status !== "running") {
      throw new Error(`Turn ${turnId} is not running`);
    }
    const abortController = this.abortControllers.get(turnId);
    if (abortController) {
      abortController.abort();
    }
    state.status = "paused";
    this.activeTurns.set(turnId, state);
    await this.persistTurn(state);
    const adapter = this.createAdapter();
    await adapter.emitTurnPaused(turnId);
    adapter.emitStatusChanged("running", "paused");
  }

  async resumeTurn(turnId: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn  not found`);
    }
    if (state.status !== "paused" && state.status !== "recovering") {
      throw new Error(`Turn ${turnId} is not paused or recovering`);
    }
    const adapter = this.createAdapter();
    const recovering = state.status === "recovering";
    const generation = this.recoveryGenerationByTurn.get(turnId);
    const originalStatus = this.recoveryOriginalStatusByTurn.get(turnId);
    if (recovering && generation && originalStatus) {
      const recovery = await this.persistence.getWorkItem(`agent-turn-recovery-`);
      await this.persistRecovery(turnId, originalStatus, "replan_started", generation,
        recovery?.kind === "agent_turn_recovery" ? recovery.staleExecutionCount : 0,
        "A new attempt is planning from current workspace and durable evidence.");
      await adapter.emitTurnRecovery(turnId, "replan_started", generation);
      this.recoveryRequiredTurns.add(turnId);
    }
    await adapter.emitTurnResumed(turnId);
    adapter.emitStatusChanged(recovering ? "recovering" : "paused", "running");
    state.status = "running";
    this.activeTurns.set(turnId, state);
    await this.persistTurn(state);
    const session = await this.persistence.getSession(this.sessionId);
    if (session) await this.persistence.upsertSession({ ...session, status: "running", updatedAt: new Date().toISOString() });
    const abortController = new AbortController();
    this.abortControllers.set(turnId, abortController);
    if (!this.demoMode) {
      this.executeTurn(turnId, state.userMessage, adapter, abortController.signal).catch(async (error) => {
        const turnState = this.activeTurns.get(turnId);
        if (turnState && turnState.status === "running") {
          turnState.status = "failed";
          turnState.error = error instanceof Error ? error.message : String(error);
          this.activeTurns.set(turnId, turnState);
          await this.persistTurn(turnState);
          await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);
          await adapter.emitTurnFailed(turnId, turnState.error);
        }
      });
    }
  }

  async cancelTurn(turnId: string, reason?: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn ${turnId} not found`);
    }
    const abortController = this.abortControllers.get(turnId);
    if (abortController) {
      abortController.abort();
    }
    this.approvalService.cancelForTurn(turnId, reason ?? "Turn cancelled");
    this.pendingSteeringByTurn.delete(turnId);
    await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);
    // Also cancel via legacy map
    for (const [id, req] of Array.from(this.pendingApprovals.entries())) {
      // legacy entries don't store turnId, but we clear all waiting approvals for this turn's status
      const turnState = this.activeTurns.get(turnId);
      if (turnState?.status === "waiting_for_approval") {
        try { req.resolve("deny"); } catch {}
        this.pendingApprovals.delete(id);
      }
    }
    state.status = "cancelled";
    state.completedAt = new Date();
    this.activeTurns.set(turnId, state);
    await this.persistTurn(state);
    const adapter = this.createAdapter();
    await adapter.emitTurnCancelled(turnId, reason);
    adapter.emitStatusChanged(state.status, "cancelled");
  }

  async resolveApproval(approvalId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    // First try new service
    const rec = this.approvalService.getRecord(approvalId);
    if (rec) {
      const adapter = this.createAdapter();
      await adapter.emitApprovalResolved(approvalId, decision);
      const stored = await this.persistence.getWorkItem(approvalId);
      if (stored?.kind === "approval") {
        await this.persistence.upsertWorkItem({ ...stored, decision, resolvedAt: new Date().toISOString() });
      }
      // Resolve the service promise only after the decision is durable, so the tool continuation
      // this unblocks can never observe an approval state that a crash would lose.
      const result = this.approvalService.resolve(approvalId, decision);
      // If this approval belongs to a waiting turn, transition back to running or handle rejection
      const turnState = this.findTurnByApprovalRecord(rec);
      if (turnState && turnState.status === "waiting_for_approval") {
        if (this.recoveryOriginalStatusByTurn.has(turnState.turnId)) {
          await this.enterRecoveryReplan(turnState, "Approval resolved after restart; the guarded operation will not be replayed.", adapter);
          return;
        }
        if (result.approved) {
          turnState.status = "running";
          this.activeTurns.set(turnState.turnId, turnState);
          adapter.emitStatusChanged("waiting_for_approval", "running");
        } else if (result.state === "rejected") {
          // keep waiting -> running so tool can return rejection message; loop continues
          turnState.status = "running";
          this.activeTurns.set(turnState.turnId, turnState);
          adapter.emitStatusChanged("waiting_for_approval", "running");
        } else if (result.state === "cancelled" || result.state === "expired") {
          // turn already cancelled; do not resurrect
        }
      }
      return;
    }
    // Fallback legacy
    const request = this.pendingApprovals.get(approvalId);
    if (!request) {
      throw new Error(`Approval ${approvalId} not found`);
    }
    const adapter = this.createAdapter();
    await adapter.emitApprovalResolved(approvalId, decision);
    request.resolve(decision);
    this.pendingApprovals.delete(approvalId);
    const turnState = this.findTurnByApproval(approvalId);
    if (turnState && turnState.status === "waiting_for_approval") {
      turnState.status = "running";
      this.activeTurns.set(turnState.turnId, turnState);
      adapter.emitStatusChanged("waiting_for_approval", "running");
    }
  }

  async resolveQuestion(questionId: string, answer: string): Promise<void> {
    const request = this.pendingQuestions.get(questionId);
    if (!request) {
      throw new Error(`Question ${questionId} not found`);
    }
    const turnState = this.findTurnByQuestion(questionId);
    const adapter = this.createAdapter();
    await adapter.emitQuestionResolved(questionId, answer);
    const stored = await this.persistence.getWorkItem(questionId);
    if (stored?.kind === "question") {
      await this.persistence.upsertWorkItem({ ...stored, answer, resolvedAt: new Date().toISOString() });
    }
    request.resolve(answer);
    this.pendingQuestions.delete(questionId);
    if (turnState && turnState.status === "waiting_for_question") {
      if (this.recoveryOriginalStatusByTurn.has(turnState.turnId)) {
        await this.enterRecoveryReplan(turnState, "Question resolved after restart; execution will continue only from a fresh plan.", adapter);
        return;
      }
      turnState.status = "running";
      this.activeTurns.set(turnState.turnId, turnState);
      adapter.emitStatusChanged("waiting_for_question", "running");
    }
  }

  getTurn(turnId: string): TurnState | undefined {
    return this.activeTurns.get(turnId);
  }

  getActiveTurns(): TurnState[] {
    return Array.from(this.activeTurns.values()).filter(
      (t) => t.status === "running" || t.status === "paused" || t.status === "waiting_for_approval" || t.status === "waiting_for_question" || t.status === "recovering",
    );
  }

  hasPendingApprovals(): boolean {
    return this.approvalService.hasPending() || this.pendingApprovals.size > 0;
  }

  hasPendingQuestions(): boolean {
    return this.pendingQuestions.size > 0;
  }

  getPendingApproval(approvalId: string): ApprovalRequest | undefined {
    const rec = this.approvalService.getPending(approvalId);
    if (rec) {
      return {
        approvalId: rec.approvalId,
        tool: rec.tool,
        action: rec.action,
        description: rec.description,
        risk: rec.risk,
        scope: rec.scope,
        resolve: () => {},
      };
    }
    return this.pendingApprovals.get(approvalId);
  }

  getPendingQuestion(questionId: string): QuestionRequest | undefined {
    return this.pendingQuestions.get(questionId);
  }

  getAllPendingApprovals(): ApprovalRequest[] {
    const fromService: ApprovalRequest[] = this.approvalService.getAllPending().map((r) => ({
      approvalId: r.approvalId,
      tool: r.tool,
      action: r.action,
      description: r.description,
      risk: r.risk,
      scope: r.scope,
      resolve: () => {},
    }));
    const legacy = Array.from(this.pendingApprovals.values());
    return [...fromService, ...legacy];
  }

  getAllPendingQuestions(): QuestionRequest[] {
    return Array.from(this.pendingQuestions.values());
  }

  // Exposed for tests and direct tool invocation hardening
  getApprovalService(): ApprovalService {
    return this.approvalService;
  }

  private createAdapter(): WorkspaceEventAdapter {
    return createWorkspaceEventAdapter({
      sessionId: this.sessionId,
      eventStore: this.eventStore,
      persistence: this.persistence,
    });
  }

  private async enterRecoveryReplan(turnState: TurnState, detail: string, adapter: WorkspaceEventAdapter): Promise<void> {
    const originalStatus = this.recoveryOriginalStatusByTurn.get(turnState.turnId);
    const generation = this.recoveryGenerationByTurn.get(turnState.turnId);
    if (!originalStatus || !generation) return;
    turnState.status = "recovering";
    this.activeTurns.set(turnState.turnId, turnState);
    await this.persistTurn(turnState);
    this.recoveryRequiredTurns.add(turnState.turnId);
    const recovery = await this.persistence.getWorkItem(`agent-turn-recovery-${turnState.turnId}`);
    await this.persistRecovery(turnState.turnId, originalStatus, "replan_required", generation,
      recovery?.kind === "agent_turn_recovery" ? recovery.staleExecutionCount : 0, detail);
    adapter.emitStatusChanged(originalStatus, "recovering");
    await adapter.emitTurnRecovery(turnState.turnId, "replan_required", generation, detail);
  }

  private async executeTurn(
    turnId: string,
    userMessage: string,
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const agentId = `agent-${turnId.slice(0, 8)}`;
    let state = this.activeTurns.get(turnId);
    if (state) {
      state.agentId = agentId;
      this.activeTurns.set(turnId, state);
    } else {
      return;
    }

    adapter.emitAgentStarted(agentId, "Lead Agent", turnId);

    try {
      const model = this.resolveTurnModel();
      if (model && state) {
        adapter.emitRouterSelection(turnId, model.modelId, model.providerId, 75, [
          "forgezero_adaptive",
          "coding_capable",
        ]);
        state.modelId = model.modelId;
        state.providerId = model.providerId;
        this.activeTurns.set(turnId, state);

        if (model.tier === "gems_paid") {
          const entitlement = await this.firewall.checkEntitlement(this.userId, model.providerId, model.modelId);
          if (!entitlement.ok) {
            throw new Error(`[${entitlement.error.code}] ${entitlement.error.message}`);
          }
        }
      }

      if (this.recoveryRequiredTurns.has(turnId)) {
        const generation = this.recoveryGenerationByTurn.get(turnId);
        const originalStatus = this.recoveryOriginalStatusByTurn.get(turnId);
        if (generation && originalStatus) {
          const recovery = await this.persistence.getWorkItem(`agent-turn-recovery-${turnId}`);
          await this.persistRecovery(turnId, originalStatus, "resumed", generation,
            recovery?.kind === "agent_turn_recovery" ? recovery.staleExecutionCount : 0,
            "Recovery resumed as a new planning attempt; no interrupted operation is replayed.");
          await adapter.emitTurnRecovery(turnId, "resumed", generation);
        }
      }

      await this.simulateAgentWork(turnId, agentId, adapter, signal);

      if (signal.aborted) {
        return;
      }

      state = this.activeTurns.get(turnId);
      if (!state) return;

      // If turn was cancelled while waiting for approval, do not mark completed
      if (state.status === "cancelled") return;

      // Running out of iterations is not finishing. Reporting it as success is the exact
      // fake-completion this runtime must never produce.
      if (state.budgetExhausted) {
        const reason = `Stopped after ${this.maxIterations} iterations without finishing. The task is incomplete and unverified.`;
        state.status = "failed";
        state.completedAt = new Date();
        state.error = reason;
        this.activeTurns.set(turnId, state);
        await this.persistTurn(state);
        await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);
        adapter.emitTurnFailed(turnId, reason);
        adapter.emitStatusChanged("running", "failed");
        return;
      }

      state.status = "completed";
      state.completedAt = new Date();
      this.activeTurns.set(turnId, state);

      const completedSession = await this.persistence.getSession(this.sessionId);
      await this.persistence.upsertSession({
        ...(completedSession ?? {
          id: this.sessionId,
          title: userMessage.slice(0, 80),
          createdAt: new Date().toISOString(),
        }),
        updatedAt: new Date().toISOString(),
        status: "completed",
        currentAgentId: agentId,
        currentModelId: state.modelId,
        currentProviderId: state.providerId,
      });
      await this.persistTurn(state);
      await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);

      await adapter.emitTurnCompleted(turnId, "Task completed successfully");
      adapter.emitStatusChanged("running", "completed");
      adapter.emitAgentCompleted(agentId, turnId);
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      state = this.activeTurns.get(turnId);
      if (!state) return;

      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.completedAt = new Date();
      this.activeTurns.set(turnId, state);
      await this.persistTurn(state);
      await this.userIntentHold?.resolveForTerminal(this.sessionId, turnId);
      const existingSession = await this.persistence.getSession(this.sessionId);
      await this.persistence.upsertSession({
        ...(existingSession ?? {
          id: this.sessionId,
          title: userMessage.slice(0, 80),
          createdAt: state.startedAt.toISOString(),
        }),
        updatedAt: state.completedAt.toISOString(),
        status: "failed",
        currentAgentId: agentId,
        currentModelId: state.modelId,
        currentProviderId: state.providerId,
      });

      // Invalid-auth / rate-limit exclusion: a 401 (or 429) during real inference marks the
      // provider's models auth_required/rate_limited in ForgeZero, so Auto immediately stops
      // selecting them and the same bad credential is never hammered on the next task. The user
      // is prompted to reconnect; reconnecting (re-discovery) restores eligibility.
      const providerId = state.providerId;
      if (providerId) {
        const msg = state.error.toLowerCase();
        if (/\b401\b|invalid api key|unauthor|auth ?error|missing_api_key/.test(msg)) {
          this.firewall.markProviderHealth(providerId, "auth_required", { lastError: "Authentication failed" });
        } else if (/\b429\b|rate.?limit/.test(msg)) {
          this.firewall.markProviderHealth(providerId, "rate_limited", { retryAfter: Date.now() + 60000, lastError: "Rate limited" });
        }
      }

      adapter.emitTurnFailed(turnId, state.error);
      adapter.emitStatusChanged("running", "failed");
      adapter.emitAgentCompleted(agentId, turnId);
    }
  }

  private selectModel(): FreeModelRecord | null {
    // Auto uses the SAME deterministic ForgeRouter ranking as the "Top Verified Free" list, so
    // Auto and the UI agree, and Auto prefers capable coding models over tiny/generic free ones.
    const router = new ForgeRouter({ firewall: this.firewall });
    const ranked = router.rank({
      taskType: "coding",
      estimatedContextTokens: 16000,
      requiredCapabilities: ["coding", "toolCalling"],
    });
    // Highest-ranked verified-free model whose provider adapter is actually registered, so the
    // turn can execute (never pick an eligible model with no backend — the orphan guard).
    const best = ranked.find((r) => this.providerCatalog.get(r.model.providerId));
    if (best) return best.model;
    // Fallback: any eligible model with a registered provider.
    const eligible = this.firewall.eligibleModels();
    return eligible.find((m) => this.providerCatalog.get(m.providerId)) ?? null;
  }

  private resolveTurnModel(): FreeModelRecord | null {
    if (this.modelSelection) {
      const { providerId, modelId } = this.modelSelection;
      if (providerId && modelId) {
        const requested = this.firewall.getModel(providerId, modelId);
        if (requested) {
          if (requested.tier === "gems_paid") return requested;
          const v = this.firewall.verify(providerId, modelId);
          if (v.ok) return requested;
        }
      }
    }
    return this.selectModel();
  }

  private async simulateAgentWork(
    turnId: string,
    agentId: string,
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state || !state.modelId || !state.providerId) {
      return;
    }

    const provider = this.providerCatalog.get(state.providerId);
    if (!provider) {
      throw new Error(`Provider ${state.providerId} not found in catalog`);
    }

    const systemPrompt = this.buildSystemPrompt();
    const recoveryDirective = this.recoveryRequiredTurns.has(turnId)
      ? "[Recovery directive] A prior process stopped during this turn. Treat all unfinished pre-restart execution as stale. Inspect the current workspace and durable evidence, then create a new plan. Do not replay a prior command, tool call, or model continuation."
      : undefined;
    const userMessage: ChatMessage = { role: "user", content: state.userMessage };
    if (recoveryDirective) this.messageHistory.push({ role: "system", content: recoveryDirective });
    this.messageHistory.push(userMessage);
    this.recoveryRequiredTurns.delete(turnId);

    const tools = this.getAvailableTools();

    const request: ChatRequest = {
      model: state.modelId,
      messages: [
        systemPrompt ? { role: "system", content: systemPrompt } : undefined,
        recoveryDirective ? { role: "system", content: recoveryDirective } : undefined,
        userMessage,
      ].filter(Boolean) as ChatMessage[],
      tools,
      toolChoice: "auto",
      temperature: 0.7,
      maxTokens: 4096,
    };

    await this.runAgentLoop(turnId, agentId, provider, request, adapter, signal, 0);
  }

  private async runAgentLoop(
    turnId: string,
    agentId: string,
    provider: { streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> },
    request: ChatRequest,
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
    iteration: number,
  ): Promise<void> {
    await this.userIntentHold?.waitForDispatch(this.sessionId, "model");
    // Safe steering boundary: drain queued steering instructions for this turn before model inference
    const pendingSteering = this.pendingSteeringByTurn.get(turnId) ?? [];
    if (pendingSteering.length > 0) {
      const queued = this.userIntentHold?.queuedSteers(this.sessionId).filter((steer) => steer.turnId === turnId) ?? [];
      await this.userIntentHold?.beginReconciliation(this.sessionId, turnId, queued.map((steer) => steer.steerId));
      this.pendingSteeringByTurn.set(turnId, []);
      for (const steeringText of pendingSteering) {
        const steeringMessage: ChatMessage = {
          role: "user",
          content: `[User Steering Instruction]: ${steeringText}`,
        };
        this.messageHistory.push(steeringMessage);
      }
      request = {
        ...request,
        messages: [...this.messageHistory],
      };
      await this.userIntentHold?.completeReconciliation(this.sessionId, turnId, queued.map((steer) => steer.steerId));
      const state = this.activeTurns.get(turnId);
      if (state) await this.persistTurn(state);
    }

    if (iteration >= this.maxIterations) {
      adapter.emitTextDelta(turnId, "\n[Maximum iterations reached. Stopping.]");
      const budgetState = this.activeTurns.get(turnId);
      if (budgetState) {
        budgetState.budgetExhausted = true;
        this.activeTurns.set(turnId, budgetState);
      }
      return;
    }

    if (signal.aborted) {
      return;
    }

    const turnState = this.activeTurns.get(turnId);
    if (turnState?.providerId && turnState?.modelId) {
      const rec = this.firewall.getModel(turnState.providerId, turnState.modelId);
      if (rec && rec.tier !== "gems_paid") {
        const v = this.firewall.verify(turnState.providerId, turnState.modelId);
        if (!v.ok) {
          throw new Error(`Model ${turnState.providerId}::${turnState.modelId} no longer eligible: ${v.error.message}`);
        }
      }
    }

    let currentText = "";
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;
    let usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | null = null;
    let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" = "stop";
    // Assistant message segment boundary for this stream iteration. A turn may produce several
    // assistant messages interleaved with tool activity; each gets a stable messageId so the
    // renderer can segment prose and persist the final user-facing text for reload.
    const messageId = crypto.randomUUID();
    let assistantMessageStarted = false;

    try {
      for await (const event of provider.streamChat(request, signal)) {
        if (signal.aborted) {
          return;
        }

        switch (event.type) {
          case "text_delta":
            if (!assistantMessageStarted) {
              assistantMessageStarted = true;
              adapter.emitAssistantMessageStarted(turnId, messageId, agentId);
            }
            currentText += event.delta;
            adapter.emitTextDelta(turnId, event.delta, agentId, messageId);
            break;

          case "tool_call_started":
            currentToolCall = { id: event.toolCallId, name: event.toolName, arguments: "" };
            adapter.emitToolCallStarted(turnId, event.toolCallId, event.toolName, agentId);
            break;

          case "tool_call_delta":
            if (currentToolCall) {
              currentToolCall.arguments += event.delta;
            }
            break;

          case "tool_call_completed":
            if (currentToolCall) {
              // Normalize possibly-malformed arguments (e.g. two JSON objects concatenated by a
              // small model) BEFORE they enter the message history, so the follow-up provider
              // request carries valid JSON and the provider does not 400 on the next turn.
              const parsedTc = parseToolArgs(currentToolCall.arguments);
              if (parsedTc !== PARSE_FAILED) currentToolCall.arguments = JSON.stringify(parsedTc);
              toolCalls.push(currentToolCall);
              adapter.emitToolCallCompleted(turnId, event.toolCallId, event.toolName, currentToolCall.arguments, agentId);
            }
            currentToolCall = null;
            break;

          case "usage":
            usage = event.usage;
            adapter.emitTokenUsage(turnId, event.usage.inputTokens, event.usage.outputTokens, event.usage.totalTokens);
            break;

          case "finish":
            finishReason = event.finishReason;
            break;

          case "error":
            throw new Error(`Provider error: ${event.code} - ${event.message}`);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      throw error;
    }

    // Close the assistant message segment: persist the final user-facing text so the
    // conversation reconstructs the prose on reload (not just live streaming deltas).
    if (assistantMessageStarted) {
      adapter.emitAssistantMessageCompleted(turnId, messageId, currentText, agentId);
    }

    if (currentText) {
      this.messageHistory.push({ role: "assistant", content: currentText });
    }

    if (toolCalls.length === 0 && this.userIntentHold?.hasQueuedSteer(this.sessionId)) {
      await this.runAgentLoop(turnId, agentId, provider, request, adapter, signal, iteration + 1);
      return;
    }

    if (toolCalls.length > 0) {
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: currentText || "",
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      this.messageHistory.push(assistantMessage);

      for (const tc of toolCalls) {
        if (this.userIntentHold?.hasQueuedSteer(this.sessionId)) {
          await this.runAgentLoop(turnId, agentId, provider, request, adapter, signal, iteration + 1);
          return;
        }
        await this.userIntentHold?.waitForDispatch(this.sessionId, "tool");
        const toolResult = await this.executeTool(turnId, tc.id, tc.name, tc.arguments, adapter, signal);
        if (signal.aborted) return;

        // Pipeline: raw -> size limit -> secret redaction -> history
        // executeTool already returns sanitized bounded result
        this.messageHistory.push({
          role: "tool",
          content: toolResult,
          toolCallId: tc.id,
        });
      }

      const nextRequest: ChatRequest = {
        ...request,
        messages: [...this.messageHistory],
      };

      await this.runAgentLoop(turnId, agentId, provider, nextRequest, adapter, signal, iteration + 1);
    } else {
      await this.userIntentHold?.waitForDispatch(this.sessionId, "other");
    }
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [
      "You are CodeForge, an autonomous software engineering agent.",
      "You help users with coding tasks by reading files, writing code, and executing commands.",
      "Before finalizing a plan, use the repository intelligence tools to locate relevant symbols, dependencies, dependents, and tests. Use targeted retrieval again when implementation or verification reveals new relationships.",
      "Always think step by step and explain your reasoning.",
    ];

    if (this.workspacePath) {
      parts.push(`The workspace is located at: ${this.workspacePath}`);
    }

    return parts.join("\n\n");
  }

  private getAvailableTools(): ToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read the contents of a file. Returns content hash for edit protection.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The path to the file" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Write content to a file (legacy whole-file). Prefer edit_file for safe patches.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The path to the file" },
              content: { type: "string", description: "The content to write" },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in a directory",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "The directory path" },
              recursive: { type: "boolean", description: "Whether to list recursively" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Execute a shell command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to run" },
              cwd: { type: "string", description: "Working directory" },
            },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search_files",
          description: "Search workspace for text/regex. Returns structured matches with file, line, preview.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query or regex" },
              regex: { type: "boolean", description: "Treat query as regex" },
              caseSensitive: { type: "boolean", description: "Case sensitive" },
              maxMatches: { type: "number", description: "Max matches to return" },
            },
            required: ["query"],
          },
        },
      },
      ...this.getRepositoryTools(),
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "Safe exact replacement edit with hash protection. Fails if oldText not found exactly or hash stale.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
              oldText: { type: "string", description: "Exact text to replace" },
              newText: { type: "string", description: "Replacement text" },
              expectedOccurrences: { type: "number", description: "Expected occurrence count (default 1)" },
              expectedHash: { type: "string", description: "SHA-256 hash from prior read for stale-edit protection" },
            },
            required: ["path", "oldText", "newText"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_checkpoint",
          description: "Create a git checkpoint for recovery before significant edits.",
          parameters: {
            type: "object",
            properties: {
              label: { type: "string", description: "Checkpoint label" },
            },
            required: ["label"],
          },
        },
      },
    ];
  }

  private getRepositoryTools(): ToolDefinition[] {
    const queryParameters = {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Identifier, symbol, path, or task query" },
        limit: { type: "number", description: "Maximum results, capped at 200" },
      },
      required: ["query"],
    };
    const pathParameters = {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Workspace-relative indexed path" },
        limit: { type: "number", description: "Maximum results, capped at 200" },
      },
      required: ["path"],
    };
    return [
      { type: "function", function: { name: "repo_search", description: "Rank relevant repository files using symbols, paths, lexical matches, Git state, and related tests.", parameters: queryParameters } },
      { type: "function", function: { name: "repo_symbol", description: "Search structurally indexed symbols and definitions.", parameters: queryParameters } },
      { type: "function", function: { name: "repo_references", description: "Find high-confidence definitions and explicitly classified approximate references.", parameters: queryParameters } },
      { type: "function", function: { name: "repo_dependencies", description: "Find imports and package dependencies of a file.", parameters: pathParameters } },
      { type: "function", function: { name: "repo_dependents", description: "Find indexed files that depend on a file.", parameters: pathParameters } },
      { type: "function", function: { name: "repo_tests", description: "Find tests related to an implementation file with confidence reasons.", parameters: pathParameters } },
      { type: "function", function: { name: "repo_impact", description: "Advisory blast-radius and impact candidate analysis for changed paths (does not grant execution or verification authority).", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Workspace-relative paths of modified files" }, path: { type: "string", description: "Single modified file path" }, maxDepth: { type: "number", description: "Graph traversal depth, default 3, max 10" }, limit: { type: "number", description: "Maximum candidates, capped at 200" } } } } },
      { type: "function", function: { name: "repo_file_summary", description: "Get structured summary of an indexed file (symbols, exports, imports, language, size).", parameters: pathParameters } },
      { type: "function", function: { name: "repo_context", description: "Build a fresh, deduplicated, provenance-rich context pack within a hard model context budget.", parameters: { type: "object", properties: { query: { type: "string" }, contextWindow: { type: "number", description: "Model context window; 16000 to 1000000" }, limit: { type: "number" } }, required: ["query"] } } },
      { type: "function", function: { name: "repo_index_status", description: "Return local repository index health, counts, schema, and cache size.", parameters: { type: "object", properties: {} } } },
    ];
  }

  private async executeRepositoryTool(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    workspacePath: string = this.workspacePath ?? "",
    existingIntelligence?: RepositoryIntelligence,
  ): Promise<string> {
    if (!workspacePath) throw new Error("No workspace path configured");
    const intelligence = existingIntelligence ?? createRepositoryIntelligence();
    const ownsIntelligence = existingIntelligence === undefined;
    try {
      if (ownsIntelligence) await intelligence.openWorkspace(workspacePath);
      const initial = intelligence.status();
      if (toolName !== "repo_index_status") {
        if (initial.fileCount === 0 || initial.state === "NOT_INDEXED" || initial.state === "ERROR") await intelligence.indexWorkspace(signal);
        else await intelligence.refresh(undefined, signal);
      }
      const limit = Math.min(200, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 50));
      const query = typeof args.query === "string" ? args.query : "";
      const requestedPath = typeof args.path === "string" ? args.path : "";
      let output: unknown;
      switch (toolName) {
        case "repo_search":
          if (!query) throw new Error("query required");
          output = await intelligence.findRelevantContext(query, { limit });
          break;
        case "repo_symbol":
          if (!query) throw new Error("query required");
          output = await intelligence.searchSymbols(query, { limit });
          break;
        case "repo_references":
          if (!query) throw new Error("query required");
          output = await intelligence.findReferences(query, { limit });
          break;
        case "repo_dependencies":
          if (!requestedPath) throw new Error("path required");
          output = await intelligence.findDependencies(requestedPath, { limit });
          break;
        case "repo_dependents":
          if (!requestedPath) throw new Error("path required");
          output = await intelligence.findDependents(requestedPath, { limit });
          break;
        case "repo_tests":
          if (!requestedPath) throw new Error("path required");
          output = await intelligence.findRelatedTests(requestedPath, { limit });
          break;
        case "repo_impact": {
          const rawPaths = Array.isArray(args.paths) ? (args.paths as string[]) : requestedPath ? [requestedPath] : [];
          const maxDepth = typeof args.maxDepth === "number" ? Math.min(10, Math.max(1, Math.floor(args.maxDepth))) : 3;
          output = await intelligence.getImpactCandidates(rawPaths, { limit, maxDepth });
          break;
        }
        case "repo_file_summary":
          if (!requestedPath) throw new Error("path required");
          output = await intelligence.getFileSummary(requestedPath);
          break;
        case "repo_context": {
          if (!query) throw new Error("query required");
          const contextWindow = Math.min(1_000_000, Math.max(16_000, typeof args.contextWindow === "number" ? Math.floor(args.contextWindow) : 32_000));
          output = await buildContextPack(query, intelligence, { contextWindow, maxCandidates: limit });
          break;
        }
        default:
          output = intelligence.status();
      }
      return JSON.stringify(output);
    } finally {
      if (ownsIntelligence) await intelligence.closeWorkspace();
    }
  }

  private async executeTool(
    turnId: string,
    toolCallId: string,
    toolName: string,
    argsJson: string,
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      return "[Aborted]";
    }

    const verification = this.firewall.verify(this.activeTurns.get(turnId)?.providerId || "unknown", this.activeTurns.get(turnId)?.modelId || "unknown");
    if (!verification.ok) {
      adapter.emitToolExecutionBlocked(turnId, toolCallId, toolName, verification.error.code);
      return `[Blocked by ForgeZero: ${verification.error.message}]`;
    }

    // Validate arguments parse. Small models sometimes emit slightly malformed tool arguments
    // (e.g. two JSON objects concatenated); tolerate that by extracting the first valid object
    // rather than failing the whole turn. Genuinely un-parseable args still error cleanly.
    const parsedArgs = parseToolArgs(argsJson);
    if (parsedArgs === PARSE_FAILED) {
      const msg = `Invalid tool arguments: not JSON`;
      const safe = redactSecrets(msg);
      adapter.emitToolExecutionFailed(turnId, toolCallId, toolName, safe);
      return `Error: ${safe}`;
    }

    // Risk classification & approval gate (authoritative)
    const approvalNeeded = this.requiresApproval(toolName, parsedArgs);
    if (approvalNeeded.requires) {
      const gateResult = await this.gateWithApproval(
        turnId,
        toolName,
        toolCallId,
        approvalNeeded,
        adapter,
        signal,
      );
      if (!gateResult.approved) {
        const reason = gateResult.reason ?? gateResult.state;
        if (gateResult.state === "cancelled") {
          return `[Cancelled: approval ${gateResult.state} - ${reason}]`;
        }
        if (gateResult.state === "expired") {
          return `[Expired: approval timed out]`;
        }
        // rejected
        adapter.emitToolExecutionBlocked(turnId, toolCallId, toolName, `approval_${gateResult.state}`);
        return `[Blocked: tool requires approval but was ${gateResult.state} (${reason})]`;
      }
      // approved -> fall through to execution (exactly once)
    }

    adapter.emitToolExecutionStarted(turnId, toolCallId, toolName, argsJson);

    try {
      let result: string;

      switch (toolName) {
        case "read_file": {
          const args = parsedArgs as { path: string };
          if (!args.path || typeof args.path !== "string") throw new Error("path required");
          result = await this.executeReadFile(args.path, adapter, turnId, toolCallId);
          break;
        }

        case "write_file": {
          const args = parsedArgs as { path: string; content: string };
          if (!args.path || typeof args.path !== "string") throw new Error("path required");
          if (typeof args.content !== "string") throw new Error("content required");
          result = await this.executeWriteFile(args.path, args.content, adapter, turnId, toolCallId);
          break;
        }

        case "list_files": {
          const args = parsedArgs as { path: string; recursive?: boolean };
          if (!args.path || typeof args.path !== "string") throw new Error("path required");
          result = await this.executeListFiles(args.path, args.recursive ?? false, adapter, turnId, toolCallId);
          break;
        }

        case "run_command": {
          const args = parsedArgs as { command: string; cwd?: string };
          if (!args.command || typeof args.command !== "string") throw new Error("command required");
          if (args.command.length > 8192) throw new Error("command too long");
          result = await this.executeRunCommand(args.command, args.cwd, adapter, turnId, toolCallId, signal);
          break;
        }

        case "search_files": {
          const args = parsedArgs as { query: string; regex?: boolean; caseSensitive?: boolean; maxMatches?: number };
          if (!args.query || typeof args.query !== "string") throw new Error("query required");
          result = await this.executeSearch(args.query, args.regex, args.caseSensitive, args.maxMatches, adapter, signal);
          break;
        }

        case "repo_search":
        case "repo_symbol":
        case "repo_references":
        case "repo_dependencies":
        case "repo_dependents":
        case "repo_tests":
        case "repo_context":
        case "repo_index_status": {
          result = await this.executeRepositoryTool(toolName, parsedArgs as Record<string, unknown>, signal);
          break;
        }

        case "edit_file": {
          const args = parsedArgs as { path: string; oldText: string; newText: string; expectedOccurrences?: number; expectedHash?: string };
          if (!args.path || typeof args.path !== "string") throw new Error("path required");
          if (typeof args.oldText !== "string") throw new Error("oldText required");
          if (typeof args.newText !== "string") throw new Error("newText required");
          result = await this.executeEditFile(args.path, args.oldText, args.newText, args.expectedOccurrences, args.expectedHash, adapter);
          break;
        }

        case "create_checkpoint": {
          const args = parsedArgs as { label: string };
          if (!args.label || typeof args.label !== "string") throw new Error("label required");
          result = await this.executeCreateCheckpoint(args.label, adapter);
          break;
        }

        default:
          result = `Unknown tool: ${toolName}`;
      }

      const safeResult = redactSecrets(result);
      const boundedResult = safeResult.length > MAX_COMMAND_OUTPUT_BYTES
        ? truncateOutput(safeResult, MAX_COMMAND_OUTPUT_BYTES, toolName)
        : safeResult;
      adapter.emitToolExecutionCompleted(turnId, toolCallId, toolName, boundedResult);
      return boundedResult;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const errorMessage = redactSecrets(raw);
      const boundedError = errorMessage.length > MAX_COMMAND_OUTPUT_BYTES
        ? truncateOutput(errorMessage, MAX_COMMAND_OUTPUT_BYTES, toolName)
        : errorMessage;
      adapter.emitToolExecutionFailed(turnId, toolCallId, toolName, boundedError);
      return `Error: ${boundedError}`;
    }
  }

  private requiresApproval(toolName: string, args: unknown): { requires: boolean; risk: "safe" | "moderate" | "high" | "critical"; reason: string; action: string } {
    switch (toolName) {
      case "read_file":
      case "list_files":
      case "search_files":
      case "repo_search":
      case "repo_symbol":
      case "repo_references":
      case "repo_dependencies":
      case "repo_dependents":
      case "repo_tests":
      case "repo_context":
      case "repo_index_status":
        return { requires: false, risk: "safe", reason: "read-only", action: "read" };
      case "write_file":
      case "edit_file":
        return { requires: true, risk: "moderate", reason: "file modification", action: "write" };
      case "create_checkpoint":
        return { requires: false, risk: "safe", reason: "checkpoint is safe", action: "checkpoint" };
      case "run_command": {
        const cmd = (args as { command?: string })?.command ?? "";
        const cls = classifyCommand(cmd);
        const requires = cls.requiresApproval;
        const risk = cls.risk as "safe" | "moderate" | "high" | "critical";
        return { requires, risk, reason: cls.reasons.join("; ") || cls.category, action: "exec" };
      }
      default:
        return { requires: true, risk: "moderate", reason: "unknown tool requires approval", action: toolName };
    }
  }

  private async gateWithApproval(
    turnId: string,
    toolName: string,
    toolCallId: string,
    approvalNeeded: { risk: "safe" | "moderate" | "high" | "critical"; reason: string; action: string },
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; state: string; reason?: string }> {
    const turnState = this.activeTurns.get(turnId);
    if (!turnState) return { approved: false, state: "cancelled", reason: "turn not found" };
    if (signal.aborted) return { approved: false, state: "cancelled", reason: "turn aborted before approval" };

    const previousStatus = turnState.status;
    turnState.status = "waiting_for_approval";
    this.activeTurns.set(turnId, turnState);
    await this.persistTurn(turnState);
    adapter.emitStatusChanged(previousStatus, "waiting_for_approval");

    const { approvalId, promise } = this.approvalService.requestApproval({
      turnId,
      tool: toolName,
      action: approvalNeeded.action,
      description: `${toolName}: ${approvalNeeded.reason}`,
      risk: approvalNeeded.risk,
      scope: this.workspacePath,
      signal,
    });
    // The pending approval must be durable before the request event is announced, so a restart
    // right after a client observes the request can still restore the wait state exactly.
    await this.persistence.upsertWorkItem({
      kind: "approval",
      id: approvalId,
      sessionId: this.sessionId,
      turnId,
      tool: toolName,
      action: approvalNeeded.action,
      description: `${toolName}: ${approvalNeeded.reason}`,
      risk: approvalNeeded.risk,
      scope: this.workspacePath,
      createdAt: new Date().toISOString(),
    });

    // Emit approval requested for UI
    await adapter.emitApprovalRequested(approvalId, toolName, approvalNeeded.action, `${toolName}: ${approvalNeeded.reason}`, approvalNeeded.risk, this.workspacePath);

    // Legacy map for HTTP handler compatibility
    const legacyResolveHolder: { decision?: string } = {};
    const legacyPromise = new Promise<string>((resolve) => {
      this.pendingApprovals.set(approvalId, {
        approvalId,
        tool: toolName,
        action: approvalNeeded.action,
        description: `${toolName}: ${approvalNeeded.reason}`,
        risk: approvalNeeded.risk,
        scope: this.workspacePath,
        resolve: (decision) => {
          legacyResolveHolder.decision = decision;
          resolve(decision);
        },
      });
    });

    // Race the service promise vs legacy resolution via HTTP
    // The service promise resolves via ApprovalService.resolve(); legacy also needs bridging
    // We bridge by having resolveApproval call service.resolve which fulfills promise.
    // So just await service promise; but also need to handle signal cancellation already wired inside service.
    const result = await promise;
    // The approval decision is authoritative, but the guarded action is a new execution
    // boundary. Yield once so a steer already accepted at the public HTTP boundary can become
    // durable before a synchronous tool continuation could terminalize the turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.afterApprovalResolvedBoundary?.();

    // Cleanup legacy entry if still present
    this.pendingApprovals.delete(approvalId);

    // Transition turn back to running if not cancelled
    const currentTurn = this.activeTurns.get(turnId);
    if (currentTurn && currentTurn.status === "waiting_for_approval") {
      if (result.approved) {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
        await this.persistTurn(currentTurn);
        adapter.emitStatusChanged("waiting_for_approval", "running");
      } else if (result.state === "rejected") {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
        await this.persistTurn(currentTurn);
        adapter.emitStatusChanged("waiting_for_approval", "running");
      } else if (result.state === "expired") {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
        await this.persistTurn(currentTurn);
        adapter.emitStatusChanged("waiting_for_approval", "running");
      } else if (result.state === "cancelled") {
        // Turn cancelled elsewhere; leave status as cancelled if already set
        const latest = this.activeTurns.get(turnId);
        if (latest && latest.status === "waiting_for_approval") {
          // No active cancellation recorded, revert to running so caller sees cancel message
          // but do not resurrect a truly cancelled turn
        }
      }
    }

    return result as { approved: boolean; state: string; reason?: string };
  }

  private validatePath(requestedPath: string): { valid: boolean; resolvedPath?: string; error?: string } {
    return resolveWithinWorkspace(this.workspacePath ?? "", requestedPath);
  }

  private async executeReadFile(
    filePath: string,
    adapter: WorkspaceEventAdapter,
    turnId: string,
    toolCallId: string,
  ): Promise<string> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      return `Error: ${validation.error}`;
    }

    const resolvedPath = validation.resolvedPath!;

    try {
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        return `Error: Not a file: ${filePath}`;
      }
      const raw = fs.readFileSync(resolvedPath, "utf-8");
      if (raw.includes("\0")) {
        adapter.emitFileRead(crypto.randomUUID(), filePath, 0);
        return `Error: Binary file not displayed: ${filePath}`;
      }
      const hash = sha256(raw);
      const lines = raw.split("\n").length;
      adapter.emitFileRead(crypto.randomUUID(), filePath, lines);
      let content = raw;
      let truncatedNotice = "";
      if (raw.split("\n").length > MAX_FILE_READ_LINES || Buffer.byteLength(raw, "utf-8") > MAX_FILE_READ_BYTES) {
        const truncated = raw.split("\n").slice(0, MAX_FILE_READ_LINES).join("\n");
        const bounded = Buffer.byteLength(truncated, "utf-8") > MAX_FILE_READ_BYTES
          ? Buffer.from(truncated, "utf-8").subarray(0, MAX_FILE_READ_BYTES).toString("utf-8")
          : truncated;
        content = bounded;
        truncatedNotice = `\n[TRUNCATED: file exceeded ${MAX_FILE_READ_LINES} lines / ${MAX_FILE_READ_BYTES} bytes; showing first ${MAX_FILE_READ_LINES} lines]`;
      }
      const safeContent = redactSecrets(content);
      return `${safeContent}${truncatedNotice}\n[hash:${hash}]`;
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async executeWriteFile(
    filePath: string,
    content: string,
    adapter: WorkspaceEventAdapter,
    turnId: string,
    toolCallId: string,
  ): Promise<string> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      return `Error: ${validation.error}`;
    }

    const resolvedPath = validation.resolvedPath!;

    try {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Atomic write
      const tmpName = `.cf-tmp-${crypto.randomUUID()}-${path.basename(resolvedPath)}`;
      const tmpPath = path.join(dir, tmpName);
      try {
        fs.writeFileSync(tmpPath, content, "utf-8");
        fs.renameSync(tmpPath, resolvedPath);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      adapter.emitFileWritten(crypto.randomUUID(), filePath, content.length);
      return `Successfully wrote ${content.length} characters to ${filePath}`;
    } catch (error) {
      return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async executeListFiles(
    dirPath: string,
    recursive: boolean,
    adapter: WorkspaceEventAdapter,
    turnId: string,
    toolCallId: string,
  ): Promise<string> {
    const validation = this.validatePath(dirPath);
    if (!validation.valid) {
      return `Error: ${validation.error}`;
    }

    const resolvedPath = validation.resolvedPath!;

    try {
      if (!fs.existsSync(resolvedPath)) {
        return `Error: Directory does not exist: ${dirPath}`;
      }

      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return `Error: Not a directory: ${dirPath}`;
      }

      const files = this.collectFiles(resolvedPath, recursive);
      const rels = files.map(f => {
        const rel = path.relative(resolvedPath, f);
        return fs.statSync(f).isDirectory() ? `${rel}/` : rel;
      });
      const out = boundedListOutput(rels, MAX_LIST_FILES_ENTRIES);
      return redactSecrets(out);
    } catch (error) {
      return `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private collectFiles(dir: string, recursive: boolean): string[] {
    const results: string[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      if (item.name.startsWith(".") && item.name !== ".git") continue;

      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        results.push(fullPath);
        if (recursive) {
          results.push(...this.collectFiles(fullPath, recursive));
        }
      } else if (item.isFile()) {
        results.push(fullPath);
      }
    }

    return results.sort();
  }

  private async executeRunCommand(
    command: string,
    cwd: string | undefined,
    adapter: WorkspaceEventAdapter,
    turnId: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.workspacePath) {
      return "Error: No workspace path configured";
    }

    const workDir = cwd
      ? this.validatePath(cwd)
      : { valid: true, resolvedPath: this.workspacePath };

    if (!workDir.valid) {
      return `Error: ${workDir.error}`;
    }

    return new Promise((resolve) => {
      let settled = false;
      let stopReason: "timeout" | "aborted" | null = null;
      let terminationStarted = false;
      let prepared: ReturnType<typeof prepareShellCommand>;
      try {
        prepared = prepareShellCommand(command, getSanitizedEnvForChild(), workDir.resolvedPath);
      } catch (error) {
        resolve(`Error executing command: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        return;
      }
      const spawnOptions = {
        cwd: workDir.resolvedPath,
        env: prepared.env,
        windowsHide: true,
        detached: process.platform !== "win32",
      };
      const proc = prepared.shell
        ? spawn(prepared.command, { ...spawnOptions, shell: true })
        : spawn(prepared.command, prepared.args, { ...spawnOptions, shell: false });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => stop("timeout"), 60_000);

      const cleanup = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortHandler);
      };

      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error && !stopReason) {
          resolve(`Error executing command: ${redactSecrets(error.message)}`);
          return;
        }
        if (stopReason === "aborted") {
          resolve("[Command aborted]");
          return;
        }
        if (stopReason === "timeout") {
          adapter.emitCommandExecuted(crypto.randomUUID(), command, "[Command timed out after 60000 ms]", 124);
          resolve("Exit code: 124\n[Command timed out after 60000 ms]");
          return;
        }
        const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
        const sanitized = redactSecrets(output);
        const truncated = Buffer.byteLength(sanitized, "utf-8") > MAX_COMMAND_OUTPUT_BYTES
          ? truncateOutput(sanitized, MAX_COMMAND_OUTPUT_BYTES, "command")
          : sanitized;
        const exitCode = code ?? 1;
        adapter.emitCommandExecuted(crypto.randomUUID(), command, truncated, exitCode);
        resolve(`Exit code: ${exitCode}\n${truncated}`);
      };

      const stop = (reason: "timeout" | "aborted"): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        stopReason = reason;
        void terminateProcessTree(proc).finally(() => {
          setTimeout(() => finish(null), 250);
        });
      };

      const abortHandler = (): void => stop("aborted");

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.once("close", (code) => finish(code));
      proc.once("error", (error) => finish(null, error));
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  private async executeSearch(
    query: string,
    regex: boolean | undefined,
    caseSensitive: boolean | undefined,
    maxMatches: number | undefined,
    adapter: WorkspaceEventAdapter,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.workspacePath) return "Error: No workspace path configured";
    try {
      const result = await searchWorkspace({
        query,
        regex: regex ?? false,
        caseSensitive: caseSensitive ?? false,
        maxMatches: Math.min(maxMatches ?? 500, 500),
        workspacePath: this.workspacePath,
        signal,
        timeoutMs: 8000,
      });
      const header = `Found ${result.matches.length} matches (${result.filesScanned} files scanned${result.truncated ? `, truncated: ${result.reason}` : ""})`;
      const lines = result.matches.map((m) => `${m.file}:${m.line}:${m.column}: ${m.preview}`);
      const out = [header, ...lines].join("\n");
      const bounded = Buffer.byteLength(out, "utf-8") > MAX_COMMAND_OUTPUT_BYTES
        ? truncateOutput(out, MAX_COMMAND_OUTPUT_BYTES, "search")
        : out;
      return redactSecrets(bounded);
    } catch (e) {
      return `Error searching: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async executeEditFile(
    filePath: string,
    oldText: string,
    newText: string,
    expectedOccurrences: number | undefined,
    expectedHash: string | undefined,
    adapter: WorkspaceEventAdapter,
  ): Promise<string> {
    if (!this.workspacePath) return "Error: No workspace path configured";
    const result = replaceExact({
      workspacePath: this.workspacePath,
      relativePath: filePath,
      oldText,
      newText,
      expectedOccurrences: expectedOccurrences ?? 1,
      expectedHash,
    });
    if (!result.success) {
      return `Error: ${redactSecrets(result.error ?? "edit failed")}\n[beforeHash:${result.beforeHash}]`;
    }
    adapter.emitFileWritten(crypto.randomUUID(), filePath, result.bytesWritten ?? 0);
    const diff = result.diff ? `\nDiff:\n${result.diff}` : "";
    return `Edited ${filePath} (before ${result.beforeHash.slice(0, 12)} -> after ${result.afterHash?.slice(0, 12)})${diff}`;
  }

  private async executeCreateCheckpoint(
    label: string,
    adapter: WorkspaceEventAdapter,
  ): Promise<string> {
    if (!this.workspacePath) return "Error: No workspace path configured";
    if (label.length > 200) return "Error: label too long";
    if (/[;&|`$]/.test(label)) return "Error: invalid characters in label";
    const { CheckpointService } = await import("./checkpoint-service.js");
    const svc = new CheckpointService(this.workspacePath);
    try {
      const cp = await svc.createCheckpoint({
        checkpointId: crypto.randomUUID(),
        label,
        workspaceRoot: this.workspacePath,
        adapter,
      });
      return `Checkpoint created: ${cp.checkpointId} (${cp.ref}) label="${label}"`;
    } catch (e) {
      return `Error creating checkpoint: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async persistTurn(state: TurnState): Promise<void> {
    await this.persistence.upsertTurn({
      id: state.turnId,
      sessionId: state.sessionId,
      seq: this.eventStore.getLastSeq(),
      userMessage: state.userMessage,
      status: state.status,
      agentId: state.agentId,
      startedAt: state.startedAt.toISOString(),
      completedAt: state.completedAt?.toISOString(),
      error: state.error,
    });
  }

  private findTurnByApproval(approvalId: string): TurnState | undefined {
    const record = this.approvalService.getRecord(approvalId);
    if (record) return this.activeTurns.get(record.turnId);
    // Legacy approvals have no service record; fall back to the single waiting turn.
    return Array.from(this.activeTurns.values()).find((t) => t.status === "waiting_for_approval");
  }

  private findTurnByApprovalRecord(rec: ApprovalRecord): TurnState | undefined {
    return this.activeTurns.get(rec.turnId);
  }

  private findTurnByQuestion(questionId: string): TurnState | undefined {
    const question = this.pendingQuestions.get(questionId);
    return question?.turnId ? this.activeTurns.get(question.turnId) : undefined;
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
