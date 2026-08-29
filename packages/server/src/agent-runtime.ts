import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import type { ProviderCatalog, ChatRequest, ChatMessage, StreamEvent, ToolDefinition } from "@codeforge/providers";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, SessionPersistence } from "@codeforge/sessions";
import { WorkspaceEventAdapter, createWorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { resolveWithinWorkspace } from "./path-security.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { redactSecrets } from "@codeforge/secrets";
import { prepareShellCommand, terminateProcessTree } from "@codeforge/workflow";
import { classifyCommand } from "./command-classifier.js";
import { ApprovalService, type ApprovalRecord } from "./approval-service.js";
import { getSanitizedEnvForChild } from "./env-filter.js";
import { searchWorkspace } from "./search-service.js";
import { replaceExact, sha256 } from "./edit-service.js";

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
  prompt: string;
  options?: string[];
  resolve: (answer: string) => void;
}

export interface AgentRuntimeOptions {
  sessionId: string;
  eventStore: EventStore;
  persistence: SessionPersistence;
  firewall: ForgeZero;
  providerCatalog: ProviderCatalog;
  workspacePath?: string;
  userId?: string;
  demoMode?: boolean;
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
  private readonly persistence: SessionPersistence;
  private readonly firewall: ForgeZero;
  private readonly providerCatalog: ProviderCatalog;
  private readonly workspacePath?: string;
  private readonly userId: string;
  private demoMode: boolean;
  private modelSelection: ModelSelection | null = null;
  private readonly activeTurns: Map<string, TurnState> = new Map();
  private readonly pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private readonly pendingQuestions: Map<string, QuestionRequest> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();
  private readonly messageHistory: ChatMessage[] = [];
  private turnCount = 0;
  private maxIterations = 50;
  private readonly approvalService: ApprovalService;

  constructor(options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.workspacePath = options.workspacePath;
    this.userId = options.userId ?? "anonymous";
    this.demoMode = options.demoMode ?? false;
    this.approvalService = new ApprovalService({ defaultTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS });
  }

  /**
   * Update demo/real mode after construction. Lets the server flip a session to real execution
   * once a provider is connected post-boot (the normal first-run flow), without recreating the runtime.
   */
  setDemoMode(demoMode: boolean): void {
    this.demoMode = demoMode;
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

  async startTurn(userMessage: string): Promise<string> {
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

    this.persistence.upsertSession({
      id: this.sessionId,
      title: userMessage.slice(0, 80),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    });
    this.persistTurn(state);

    const adapter = this.createAdapter();
    adapter.emitStatusChanged("idle", "running");
    adapter.emitTurnStarted(turnId, userMessage);

    const abortController = new AbortController();
    this.abortControllers.set(turnId, abortController);

    if (!this.demoMode) {
      this.executeTurn(turnId, userMessage, adapter, abortController.signal).catch((error) => {
        const turnState = this.activeTurns.get(turnId);
        if (turnState && turnState.status === "running") {
          turnState.status = "failed";
          turnState.error = error instanceof Error ? error.message : String(error);
          this.activeTurns.set(turnId, turnState);
          adapter.emitTurnFailed(turnId, turnState.error);
          adapter.emitStatusChanged("running", "failed");
        }
      });
    }

    return turnId;
  }

  async steerTurn(turnId: string, steering: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn ${turnId} not found`);
    }
    if (state.status !== "running") {
      throw new Error(`Turn ${turnId} is not running (status: ${state.status})`);
    }
    const adapter = this.createAdapter();
    adapter.emitTurnSteered(turnId, steering);
    state.userMessage = steering;
    this.activeTurns.set(turnId, state);
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
    this.persistTurn(state);
    const adapter = this.createAdapter();
    adapter.emitTurnPaused(turnId);
    adapter.emitStatusChanged("running", "paused");
  }

  async resumeTurn(turnId: string): Promise<void> {
    const state = this.activeTurns.get(turnId);
    if (!state) {
      throw new Error(`Turn ${turnId} not found`);
    }
    if (state.status !== "paused") {
      throw new Error(`Turn ${turnId} is not paused`);
    }
    const adapter = this.createAdapter();
    adapter.emitTurnResumed(turnId);
    adapter.emitStatusChanged("paused", "running");
    state.status = "running";
    this.activeTurns.set(turnId, state);
    const abortController = new AbortController();
    this.abortControllers.set(turnId, abortController);
    if (!this.demoMode) {
      this.executeTurn(turnId, state.userMessage, adapter, abortController.signal).catch((error) => {
        const turnState = this.activeTurns.get(turnId);
        if (turnState && turnState.status === "running") {
          turnState.status = "failed";
          turnState.error = error instanceof Error ? error.message : String(error);
          this.activeTurns.set(turnId, turnState);
          adapter.emitTurnFailed(turnId, turnState.error);
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
    this.persistTurn(state);
    const adapter = this.createAdapter();
    adapter.emitTurnCancelled(turnId, reason);
    adapter.emitStatusChanged(state.status, "cancelled");
  }

  resolveApproval(approvalId: string, decision: "allow_once" | "allow_session" | "deny"): void {
    // First try new service
    const rec = this.approvalService.getRecord(approvalId);
    if (rec) {
      const result = this.approvalService.resolve(approvalId, decision);
      const adapter = this.createAdapter();
      adapter.emitApprovalResolved(approvalId, decision);
      // If this approval belongs to a waiting turn, transition back to running or handle rejection
      const turnState = this.findTurnByApprovalRecord(rec);
      if (turnState && turnState.status === "waiting_for_approval") {
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
    adapter.emitApprovalResolved(approvalId, decision);
    request.resolve(decision);
    this.pendingApprovals.delete(approvalId);
    const turnState = this.findTurnByApproval(approvalId);
    if (turnState && turnState.status === "waiting_for_approval") {
      turnState.status = "running";
      this.activeTurns.set(turnState.turnId, turnState);
      adapter.emitStatusChanged("waiting_for_approval", "running");
    }
  }

  resolveQuestion(questionId: string, answer: string): void {
    const request = this.pendingQuestions.get(questionId);
    if (!request) {
      throw new Error(`Question ${questionId} not found`);
    }
    const adapter = this.createAdapter();
    adapter.emitQuestionResolved(questionId, answer);
    request.resolve(answer);
    this.pendingQuestions.delete(questionId);
    const turnState = this.findTurnByQuestion(questionId);
    if (turnState && turnState.status === "waiting_for_question") {
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
      (t) => t.status === "running" || t.status === "paused",
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

      await this.simulateAgentWork(turnId, agentId, adapter, signal);

      if (signal.aborted) {
        return;
      }

      state = this.activeTurns.get(turnId);
      if (!state) return;

      // If turn was cancelled while waiting for approval, do not mark completed
      if (state.status === "cancelled") return;

      state.status = "completed";
      state.completedAt = new Date();
      this.activeTurns.set(turnId, state);

      this.persistence.upsertSession({
        id: this.sessionId,
        title: userMessage.slice(0, 80),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "completed",
        currentAgentId: agentId,
        currentModelId: state.modelId,
        currentProviderId: state.providerId,
      });
      this.persistTurn(state);

      adapter.emitTurnCompleted(turnId, "Task completed successfully");
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
      this.persistTurn(state);
      const existingSession = this.persistence.getSession(this.sessionId);
      this.persistence.upsertSession({
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
    const userMessage: ChatMessage = { role: "user", content: state.userMessage };
    this.messageHistory.push(userMessage);

    const tools = this.getAvailableTools();

    const request: ChatRequest = {
      model: state.modelId,
      messages: [systemPrompt ? { role: "system", content: systemPrompt } : undefined, userMessage].filter(Boolean) as ChatMessage[],
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
    if (iteration >= this.maxIterations) {
      adapter.emitTextDelta(turnId, "\n[Maximum iterations reached. Stopping.]");
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
    }
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [
      "You are CodeForge, an autonomous software engineering agent.",
      "You help users with coding tasks by reading files, writing code, and executing commands.",
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

    // Emit approval requested for UI
    adapter.emitApprovalRequested(approvalId, toolName, approvalNeeded.action, `${toolName}: ${approvalNeeded.reason}`, approvalNeeded.risk, this.workspacePath);

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

    // Cleanup legacy entry if still present
    this.pendingApprovals.delete(approvalId);

    // Transition turn back to running if not cancelled
    const currentTurn = this.activeTurns.get(turnId);
    if (currentTurn && currentTurn.status === "waiting_for_approval") {
      if (result.approved) {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
        adapter.emitStatusChanged("waiting_for_approval", "running");
      } else if (result.state === "rejected") {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
        adapter.emitStatusChanged("waiting_for_approval", "running");
      } else if (result.state === "expired") {
        currentTurn.status = "running";
        this.activeTurns.set(turnId, currentTurn);
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

  private persistTurn(state: TurnState): void {
    this.persistence.upsertTurn({
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
    return Array.from(this.activeTurns.values()).find((t) => t.status === "waiting_for_approval");
  }

  private findTurnByApprovalRecord(_rec: ApprovalRecord): TurnState | undefined {
    return Array.from(this.activeTurns.values()).find((t) => t.status === "waiting_for_approval");
  }

  private findTurnByQuestion(questionId: string): TurnState | undefined {
    return Array.from(this.activeTurns.values()).find((t) => t.status === "waiting_for_question");
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
