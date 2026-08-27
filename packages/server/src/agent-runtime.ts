import type { ForgeZero, FreeModelRecord } from "@codeforge/forge-zero";
import type { ProviderCatalog, ChatRequest, ChatMessage, StreamEvent, ToolDefinition } from "@codeforge/providers";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { EventStore, SessionPersistence } from "@codeforge/sessions";
import { WorkspaceEventAdapter, createWorkspaceEventAdapter } from "./workspace-event-adapter.js";
import { resolveWithinWorkspace } from "./path-security.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  /** CodeForge account user id used for entitlement checks on GEMS models. */
  userId?: string;
  /** Demo mode: skip real provider execution, only track turn state. */
  demoMode?: boolean;
}

/** Explicit manual model selection for a session (may be a GEMS paid model). */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export class AgentRuntime {
  private readonly sessionId: string;
  private readonly eventStore: EventStore;
  private readonly persistence: SessionPersistence;
  private readonly firewall: ForgeZero;
  private readonly providerCatalog: ProviderCatalog;
  private readonly workspacePath?: string;
  private readonly userId: string;
  private readonly demoMode: boolean;
  private modelSelection: ModelSelection | null = null;
  private readonly activeTurns: Map<string, TurnState> = new Map();
  private readonly pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private readonly pendingQuestions: Map<string, QuestionRequest> = new Map();
  private readonly abortControllers: Map<string, AbortController> = new Map();
  private readonly messageHistory: ChatMessage[] = [];
  private turnCount = 0;
  private maxIterations = 50;

  constructor(options: AgentRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.eventStore = options.eventStore;
    this.persistence = options.persistence;
    this.firewall = options.firewall;
    this.providerCatalog = options.providerCatalog;
    this.workspacePath = options.workspacePath;
    this.userId = options.userId ?? "anonymous";
    this.demoMode = options.demoMode ?? false;
  }

  /**
   * Manually select a model for subsequent turns. When a GEMS paid model is
   * selected, every turn is gated by ForgeZero.checkEntitlement and fails
   * closed if the user is not entitled.
   */
  setModelSelection(selection: ModelSelection): void {
    this.modelSelection = { providerId: selection.providerId, modelId: selection.modelId };
  }

  /**
   * Return to ForgeZero auto-routing ("Auto" in the UI). Auto-routing only
   * ever yields free-tier models, so this is the fail-safe selection state.
   */
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

    // The sessions row must exist before the turn insert (turns.sessionId has
    // a FOREIGN KEY referencing sessions.id).
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

    // Demo mode: skip real provider execution entirely.
    // Only track turn state for pause/resume/cancel operations.
    // The demo-runtime handles emitting demo events separately.
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

    // Demo mode: skip real provider execution entirely.
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

    state.status = "cancelled";
    state.completedAt = new Date();
    this.activeTurns.set(turnId, state);
    this.persistTurn(state);

    const adapter = this.createAdapter();
    adapter.emitTurnCancelled(turnId, reason);
    adapter.emitStatusChanged(state.status, "cancelled");
  }

  resolveApproval(approvalId: string, decision: "allow_once" | "allow_session" | "deny"): void {
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
    return this.pendingApprovals.size > 0;
  }

  hasPendingQuestions(): boolean {
    return this.pendingQuestions.size > 0;
  }

  getPendingApproval(approvalId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  getPendingQuestion(questionId: string): QuestionRequest | undefined {
    return this.pendingQuestions.get(questionId);
  }

  getAllPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  getAllPendingQuestions(): QuestionRequest[] {
    return Array.from(this.pendingQuestions.values());
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

        // GEMS paid models are entitlement-gated in the production turn path.
        // ForgeZero fails closed: unentitled users and entitlement-service
        // errors both deny execution before any inference happens.
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

      state.status = "completed";
      state.completedAt = new Date();
      this.activeTurns.set(turnId, state);

      // Session row (with the resolved model) is written before the turn is
      // marked completed so observers never see a completed turn against a
      // stale session row.
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

      adapter.emitTurnFailed(turnId, state.error);
      adapter.emitStatusChanged("running", "failed");
      adapter.emitAgentCompleted(agentId, turnId);
    }
  }

  private selectModel(): FreeModelRecord | null {
    const eligible = this.firewall.eligibleModels();
    if (eligible.length === 0) {
      return null;
    }
    return eligible[0] ?? null;
  }

  /**
   * Manual selection (e.g. a GEMS model chosen in the UI) wins over
   * ForgeZero auto-routing. Auto-routing only ever yields free-tier models;
   * paid models are only reachable through an explicit selection, which is
   * then gated by checkEntitlement in executeTurn.
   */
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

    let currentText = "";
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;
    let usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | null = null;
    let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error" = "stop";

    try {
      for await (const event of provider.streamChat(request, signal)) {
        if (signal.aborted) {
          return;
        }

        switch (event.type) {
          case "text_delta":
            currentText += event.delta;
            adapter.emitTextDelta(turnId, event.delta, agentId);
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
              toolCalls.push(currentToolCall);
              adapter.emitToolCallCompleted(turnId, event.toolCallId, event.toolName, event.arguments, agentId);
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
          description: "Read the contents of a file",
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
          description: "Write content to a file",
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

    adapter.emitToolExecutionStarted(turnId, toolCallId, toolName, argsJson);

    try {
      let result: string;

      switch (toolName) {
        case "read_file": {
          const args = JSON.parse(argsJson) as { path: string };
          result = await this.executeReadFile(args.path, adapter, turnId, toolCallId);
          break;
        }

        case "write_file": {
          const args = JSON.parse(argsJson) as { path: string; content: string };
          result = await this.executeWriteFile(args.path, args.content, adapter, turnId, toolCallId);
          break;
        }

        case "list_files": {
          const args = JSON.parse(argsJson) as { path: string; recursive?: boolean };
          result = await this.executeListFiles(args.path, args.recursive ?? false, adapter, turnId, toolCallId);
          break;
        }

        case "run_command": {
          const args = JSON.parse(argsJson) as { command: string; cwd?: string };
          result = await this.executeRunCommand(args.command, args.cwd, adapter, turnId, toolCallId, signal);
          break;
        }

        default:
          result = `Unknown tool: ${toolName}`;
      }

      adapter.emitToolExecutionCompleted(turnId, toolCallId, toolName, result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      adapter.emitToolExecutionFailed(turnId, toolCallId, toolName, errorMessage);
      return `Error: ${errorMessage}`;
    }
  }

  private validatePath(requestedPath: string): { valid: boolean; resolvedPath?: string; error?: string } {
    // Symlink/junction-aware containment check shared by all workspace tools.
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

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      adapter.emitFileRead(crypto.randomUUID(), filePath, lines);
      return content;
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

      fs.writeFileSync(resolvedPath, content, "utf-8");
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
      return files.map(f => {
        const rel = path.relative(resolvedPath, f);
        return fs.statSync(f).isDirectory() ? `${rel}/` : rel;
      }).join("\n");
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
      const proc = spawn(command, [], {
        cwd: workDir.resolvedPath,
        shell: true,
        timeout: 60000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        const output = stdout || stderr || "(no output)";
        adapter.emitCommandExecuted(crypto.randomUUID(), command, output, code ?? 0);
        resolve(`Exit code: ${code ?? 0}\n${output}`);
      });

      proc.on("error", (error) => {
        resolve(`Error executing command: ${error.message}`);
      });

      signal.addEventListener("abort", () => {
        proc.kill();
        resolve("[Command aborted]");
      });
    });
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

  private findTurnByQuestion(questionId: string): TurnState | undefined {
    return Array.from(this.activeTurns.values()).find((t) => t.status === "waiting_for_question");
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
