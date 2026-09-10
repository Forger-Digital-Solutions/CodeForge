import type {
  ProviderAdapter,
  ProviderExecutionContext,
  ProviderHealthResponse,
  ProviderModel,
  ProviderToolExecutionRequest,
  ProviderToolExecutionResult,
} from "./index.js";
import { ProviderError } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";
import { redactSecrets } from "./redact.js";

/** Small transport seam for the documented Codex app-server JSON-RPC protocol. */
export interface CodexAppServerTransport {
  readonly snapshot?: { processSessionId?: string };
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  stream?(method: string, params?: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown>;
  close?(): Promise<void> | void;
}

export interface CodexAccountSnapshot {
  accountId: string;
  email?: string;
  planType?: string;
  authMode: "chatgpt";
}

export interface CodexRateLimitSnapshot {
  usedPercent?: number;
  resetsAt?: number;
  rateLimitReachedType?: string | null;
}

export type CodexAccountRouteState =
  | "unauthenticated"
  | "authenticated"
  | "allowance_available"
  | "allowance_exhausted"
  | "stale";

export interface CodexAccountAdapterOptions {
  transport: CodexAppServerTransport;
  modelId?: string;
  displayName?: string;
  now?: () => number;
  timeoutMs?: number;
  toolExecutor?: (request: ProviderToolExecutionRequest) => Promise<ProviderToolExecutionResult>;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  processSessionId: string;
  params?: Record<string, unknown>;
}

interface ActiveCodexThread {
  context: ProviderExecutionContext;
  processSessionId?: string;
  providerTurnId?: string;
  allowedTools: Set<string>;
  controller: AbortController;
  calls: Map<string, Promise<ProviderToolExecutionResult>>;
}

export interface CodexLoginResult {
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  loginId?: string;
}

/**
 * Account-backed Codex route. It intentionally has no API-key path: every request re-reads the
 * documented account rate-limit state and stops before a depleted allowance can become billing.
 */
export class CodexAccountAdapter implements ProviderAdapter {
  readonly providerId = "codex-account";
  private readonly transport: CodexAppServerTransport;
  private readonly modelId: string;
  private readonly displayName: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly toolExecutor?: (request: ProviderToolExecutionRequest) => Promise<ProviderToolExecutionResult>;
  private readonly activeThreads = new Map<string, ActiveCodexThread>();
  private account: CodexAccountSnapshot | null = null;
  private limits: CodexRateLimitSnapshot[] = [];
  private state: CodexAccountRouteState = "unauthenticated";

  constructor(options: CodexAccountAdapterOptions) {
    this.transport = options.transport;
    this.modelId = options.modelId ?? "default";
    this.displayName = options.displayName ?? "OpenAI Codex · ChatGPT account";
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.toolExecutor = options.toolExecutor;
  }

  get routeState(): CodexAccountRouteState {
    return this.state;
  }

  get accountSnapshot(): CodexAccountSnapshot | null {
    return this.account ? { ...this.account } : null;
  }

  get rateLimits(): CodexRateLimitSnapshot[] {
    return this.limits.map((limit) => ({ ...limit }));
  }

  async startLogin(): Promise<CodexLoginResult> {
    try {
      const raw = await this.requestWithTimeout("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      });
      const value = asRecord(raw) ?? {};
      return {
        ...(typeof value.authUrl === "string" ? { authUrl: value.authUrl } : {}),
        ...(typeof value.verificationUrl === "string" ? { verificationUrl: value.verificationUrl } : {}),
        ...(typeof value.userCode === "string" ? { userCode: value.userCode } : {}),
        ...(typeof value.loginId === "string" ? { loginId: value.loginId } : {}),
      };
    } catch (error) {
      throw normalizeCodexError(error, "AUTH_REQUIRED");
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    if (!loginId || loginId.length > 256) throw new ProviderError("Invalid Codex login id", "AUTH_REQUIRED");
    try {
      await this.requestWithTimeout("account/login/cancel", { loginId });
    } catch (error) {
      throw normalizeCodexError(error, "AUTH_REQUIRED");
    }
  }

  async readAccount(): Promise<CodexAccountSnapshot | null> {
    try {
      const raw = await this.requestWithTimeout("account/read", {});
      const value = asRecord(raw) ?? {};
      const account = asRecord(value.account) ?? value;
      const authMode = account.type === "chatgpt" ? "chatgpt" : undefined;
      const accountId = firstString(account.accountId, account.id, account.email) ?? "chatgpt-account";
      if (authMode !== "chatgpt") {
        this.account = null;
        this.state = "stale";
        return null;
      }
      this.account = {
        accountId,
        authMode,
        ...(typeof account.email === "string" ? { email: account.email } : {}),
        ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
      };
      this.state = "authenticated";
      return this.accountSnapshot;
    } catch (error) {
      this.account = null;
      this.state = "unauthenticated";
      // requestWithTimeout already classified the raw transport failure; re-normalizing its
      // message would lose that classification (an ENOENT came back labeled AUTH_REQUIRED live).
      throw error instanceof ProviderError ? error : normalizeCodexError(error, "AUTH_REQUIRED");
    }
  }

  async readRateLimits(): Promise<CodexRateLimitSnapshot[]> {
    try {
      const raw = await this.requestWithTimeout("account/rateLimits/read", {});
      const value = asRecord(raw) ?? {};
      this.limits = rateLimitWindows(value);
      if (!this.account) this.state = "stale";
      else this.state = hasAllowance(this.limits, this.now()) ? "allowance_available" : "allowance_exhausted";
      return this.rateLimits;
    } catch (error) {
      this.state = "stale";
      throw normalizeCodexError(error, "PROVIDER_UNAVAILABLE");
    }
  }

  async logout(): Promise<void> {
    try {
      await this.requestWithTimeout("account/logout", {});
    } catch (error) {
      throw normalizeCodexError(error, "PROVIDER_UNAVAILABLE");
    } finally {
      this.account = null;
      this.limits = [];
      this.state = "unauthenticated";
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.account || !hasAllowance(this.limits, this.now())) return [];
    return [
      {
        modelId: this.modelId,
        displayName: this.displayName,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
        isFree: false,
        freeStatus: "unknown",
      },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const events = await collect(this.streamChat(req));
    const text = events.filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.delta).join("");
    const usage = events.find((event): event is Extract<StreamEvent, { type: "usage" }> => event.type === "usage")?.usage;
    return {
      id: crypto.randomUUID(),
      model: req.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finishReason: "stop" }],
      ...(usage ? { usage } : {}),
    };
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (req.tools && req.tools.length > 0) {
      throw new ProviderError(
        "CodeForge tools cannot be delegated to the Codex app-server authority",
        "UNSUPPORTED_TOOL",
      );
    }
    yield* this.streamChatInternal(req, undefined, signal);
  }

  async *streamChatWithContext(
    req: ChatRequest,
    context: ProviderExecutionContext,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    if (req.tools?.length && !this.toolExecutor) {
      throw new ProviderError("CodeForge tool authority is unavailable", "UNSUPPORTED_TOOL");
    }
    yield* this.streamChatInternal(req, context, signal);
  }

  async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    if (request.method !== "item/tool/call") {
      throw new ProviderError(`Unsupported Codex server request: ${request.method}`, "UNSUPPORTED_TOOL");
    }
    const params = asRecord(request.params);
    const threadId = boundedIdentifier(params?.threadId);
    const providerTurnId = boundedIdentifier(params?.turnId);
    const toolCallId = boundedIdentifier(params?.callId);
    const toolName = boundedIdentifier(params?.tool);
    const namespace = params?.namespace === null ? null : boundedIdentifier(params?.namespace);
    const args = asRecord(params?.arguments);
    if (!threadId || !providerTurnId || !toolCallId || !toolName || namespace !== "codeforge" || !args) {
      throw new ProviderError("Malformed Codex dynamic tool request", "UNSUPPORTED_TOOL");
    }
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > 1024 * 1024) {
      throw new ProviderError("Codex dynamic tool arguments exceeded the size limit", "UNSUPPORTED_TOOL");
    }
    const active = this.activeThreads.get(threadId);
    if (!active || active.controller.signal.aborted) {
      throw new ProviderError("Codex dynamic tool request has no active CodeForge turn", "UNSUPPORTED_TOOL");
    }
    if (active.processSessionId && active.processSessionId !== request.processSessionId) {
      throw new ProviderError("Codex dynamic tool request came from a stale process", "UNSUPPORTED_TOOL");
    }
    if (active.providerTurnId && active.providerTurnId !== providerTurnId) {
      throw new ProviderError("Codex dynamic tool request came from a stale turn", "UNSUPPORTED_TOOL");
    }
    if (!active.allowedTools.has(toolName) || !this.toolExecutor) {
      throw new ProviderError(`Codex requested an unsupported CodeForge tool: ${toolName}`, "UNSUPPORTED_TOOL");
    }
    active.processSessionId ??= request.processSessionId;
    active.providerTurnId ??= providerTurnId;
    const requestId = String(request.id);
    const callKey = `${request.processSessionId}\0${threadId}\0${providerTurnId}\0${toolCallId}`;
    let execution = active.calls.get(callKey);
    if (!execution) {
      const executionContext = {
        ...active.context,
        processSessionId: request.processSessionId,
        providerThreadId: threadId,
        providerTurnId,
        serverRequestId: requestId,
        toolCallId,
        namespace,
      };
      execution = this.toolExecutor({
        ...executionContext,
        toolName,
        arguments: args,
        context: executionContext,
        providerId: this.providerId,
        signal: active.controller.signal,
      });
      active.calls.set(callKey, execution);
    }
    const result = await execution;
    const output = redactSecrets(result.output).slice(0, 64 * 1024);
    return {
      contentItems: [{ type: "inputText", text: output }],
      success: result.success ?? (result.exitCode === undefined || result.exitCode === 0),
    };
  }

  private async *streamChatInternal(
    req: ChatRequest,
    context: ProviderExecutionContext | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    await this.ensureAllowance();
    if (signal?.aborted) return;
    const dynamicTools = context && req.tools?.length
      ? [{
          type: "namespace",
          name: "codeforge",
          description: "CodeForge-authorized workspace tools. All consequential actions are approved and executed by CodeForge.",
          tools: req.tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
          })),
        }]
      : undefined;
    const threadParams: Record<string, unknown> = {
      ...(req.model !== "default" ? { model: req.model } : {}),
      ...(context?.workspacePath ? { cwd: context.workspacePath } : {}),
      ...(dynamicTools ? { dynamicTools } : {}),
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      baseInstructions: "Use the codeforge namespace for workspace tools. Do not use built-in command or file-change tools; CodeForge is the sole tool and approval authority.",
      ephemeral: true,
    };
    const thread = await this.requestWithTimeout("thread/start", threadParams);
    const threadId = extractThreadId(thread);
    if (!threadId) throw new ProviderError("Codex app-server returned no thread id", "PROVIDER_UNAVAILABLE", true);
    const controller = new AbortController();
    const active = context ? {
      context,
      processSessionId: this.transport.snapshot?.processSessionId,
      allowedTools: new Set(req.tools?.map((tool) => tool.function.name) ?? []),
      controller,
      calls: new Map<string, Promise<ProviderToolExecutionResult>>(),
    } : undefined;
    if (active) {
      if (this.activeThreads.has(threadId)) {
        throw new ProviderError("Codex app-server reused an active thread id", "PROVIDER_UNAVAILABLE", true);
      }
      this.activeThreads.set(threadId, active);
    }
    const params = {
      threadId,
      ...(req.model !== "default" ? { model: req.model } : {}),
      input: req.messages.map((message) => ({
        type: "text",
        text: `${message.role}: ${message.content}`,
        text_elements: [],
      })),
    };

    if (this.transport.stream) {
      const abortHandler = (): void => {
        controller.abort();
        void interruptTurn(this.transport, threadId);
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      try {
        for await (const raw of this.transport.stream("turn/start", params, controller.signal)) {
          if (signal?.aborted) return;
          const event = toStreamEvent(raw);
          if (event) yield event;
        }
      } finally {
        signal?.removeEventListener("abort", abortHandler);
        controller.abort();
        if (this.activeThreads.get(threadId) === active) this.activeThreads.delete(threadId);
      }
      return;
    }

    try {
      const result = await this.requestWithTimeout("turn/start", params);
      const text = extractText(result);
      if (text) yield { type: "text_delta", delta: text };
      yield { type: "finish", finishReason: "stop" };
    } finally {
      controller.abort();
      if (this.activeThreads.get(threadId) === active) this.activeThreads.delete(threadId);
    }
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    const started = this.now();
    try {
      const account = await this.readAccount();
      if (!account) return { status: "auth_required", latencyMs: this.now() - started, error: "Codex account is not connected" };
      const limits = await this.readRateLimits();
      if (!hasAllowance(limits, this.now())) {
        return { status: "rate_limited", latencyMs: this.now() - started, error: "Codex account allowance exhausted" };
      }
      return { status: "available", latencyMs: this.now() - started };
    } catch (error) {
      const normalized = normalizeCodexError(error, "PROVIDER_UNAVAILABLE");
      if (normalized.code === "AUTH_REQUIRED" || normalized.code === "AUTH_EXPIRED") {
        return { status: "auth_required", latencyMs: this.now() - started, error: normalized.message };
      }
      if (normalized.code === "ALLOWANCE_EXHAUSTED" || normalized.code === "RATE_LIMITED") {
        return { status: "rate_limited", latencyMs: this.now() - started, error: normalized.message };
      }
      return { status: "offline", latencyMs: this.now() - started, error: normalized.message };
    }
  }

  private async ensureAllowance(): Promise<void> {
    if (!this.account) await this.readAccount();
    if (!this.account) throw new ProviderError("Codex account authentication is required", "AUTH_REQUIRED");
    const limits = await this.readRateLimits();
    if (!hasAllowance(limits, this.now())) {
      throw new ProviderError("Codex account allowance is exhausted; paid API fallback is disabled", "ALLOWANCE_EXHAUSTED");
    }
  }

  private async requestWithTimeout(method: string, params: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError(`Codex account request timed out: ${method}`, "TIMEOUT", true)), this.timeoutMs);
      });
      return await Promise.race([this.transport.request(method, params), timeout]);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw normalizeCodexError(error, "PROVIDER_UNAVAILABLE");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function interruptTurn(transport: CodexAppServerTransport, threadId: string): Promise<void> {
  try {
    await transport.request("turn/interrupt", { threadId });
  } catch {
    // Cancellation is already authoritative locally; a dead app-server cannot be interrupted.
  }
}

function hasAllowance(limits: CodexRateLimitSnapshot[], now: number): boolean {
  if (limits.length === 0) return false;
  return limits.every((limit) => {
    if (limit.rateLimitReachedType) return false;
    if (limit.resetsAt !== undefined && limit.resetsAt <= now && limit.usedPercent !== undefined) return limit.usedPercent < 100;
    return limit.usedPercent !== undefined && limit.usedPercent < 100;
  });
}

function parseRateLimit(raw: unknown): CodexRateLimitSnapshot | null {
  const value = asRecord(raw);
  if (!value) return null;
  const usedPercent = typeof value.usedPercent === "number" ? value.usedPercent : undefined;
  const rawResetsAt = typeof value.resetsAt === "number" ? value.resetsAt : undefined;
  const resetsAt = rawResetsAt !== undefined && rawResetsAt < 1_000_000_000_000 ? rawResetsAt * 1000 : rawResetsAt;
  const rateLimitReachedType = typeof value.rateLimitReachedType === "string" ? value.rateLimitReachedType : null;
  if (usedPercent === undefined && resetsAt === undefined && rateLimitReachedType === null) return null;
  return { ...(usedPercent !== undefined ? { usedPercent } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), rateLimitReachedType };
}

function rateLimitWindows(value: Record<string, unknown>): CodexRateLimitSnapshot[] {
  if (Array.isArray(value.windows)) {
    return value.windows.map(parseRateLimit).filter((limit): limit is CodexRateLimitSnapshot => limit !== null);
  }
  const byLimitId = asRecord(value.rateLimitsByLimitId);
  const single = asRecord(value.rateLimits);
  const buckets = byLimitId ? Object.values(byLimitId) : single ? [single] : [];
  const windows: CodexRateLimitSnapshot[] = [];
  for (const bucket of buckets) {
    const record = asRecord(bucket);
    if (!record) continue;
    const reached = typeof record.rateLimitReachedType === "string" ? record.rateLimitReachedType : null;
    for (const window of [record.primary, record.secondary]) {
      const parsed = parseRateLimit({ ...asRecord(window), rateLimitReachedType: reached });
      if (parsed) windows.push(parsed);
    }
  }
  return windows;
}

function extractThreadId(raw: unknown): string | undefined {
  const value = asRecord(raw) ?? {};
  const thread = asRecord(value.thread);
  return firstString(thread?.id, value.threadId, value.id);
}

function extractText(raw: unknown): string {
  const value = asRecord(raw) ?? {};
  return firstString(value.text, value.output, value.message, asRecord(value.result)?.text) ?? "";
}

function toStreamEvent(raw: unknown): StreamEvent | null {
  const value = asRecord(raw);
  if (!value) return null;
  const params = asRecord(value.params) ?? value;
  const method = typeof value.method === "string" ? value.method : "";
  const delta = firstString(params.delta, params.text);
  if (delta && method.includes("delta")) return { type: "text_delta", delta };
  if (method === "turn/failed" || method === "error") return { type: "error", code: "CODEX_TURN_FAILED", message: "Codex turn failed" };
  if (method.includes("completed") || method.includes("complete") || method.includes("turn/finished")) return { type: "finish", finishReason: "stop" };
  return null;
}

function normalizeCodexError(error: unknown, fallback: string): ProviderError {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  // A missing codex binary is an environment/offline failure, not an auth failure — mislabeling it
  // AUTH_REQUIRED sends certification down the wrong path (proved live during R6).
  const code = lower.includes("enoent")
    ? "PROVIDER_UNAVAILABLE"
    : lower.includes("auth") || lower.includes("login") || lower.includes("unauthorized") ? "AUTH_REQUIRED"
    : lower.includes("expired") || lower.includes("stale") ? "AUTH_EXPIRED"
      : lower.includes("rate") || lower.includes("limit") ? "RATE_LIMITED"
        : lower.includes("allowance") || lower.includes("quota") || lower.includes("credit") ? "ALLOWANCE_EXHAUSTED"
          : lower.includes("timeout") || lower.includes("timed out") ? "TIMEOUT" : fallback;
  return new ProviderError(`Codex account route: ${code}`, code, code === "TIMEOUT" || code === "RATE_LIMITED");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export function createCodexAccountAdapter(options: CodexAccountAdapterOptions): CodexAccountAdapter {
  return new CodexAccountAdapter(options);
}
