import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
import { platform, arch } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact.js";
import type { CodexAppServerTransport } from "./codex-account.js";

export type CodexRpcId = string | number;

export interface CodexRpcRequest {
  id: CodexRpcId;
  method: string;
  processSessionId: string;
  params?: Record<string, unknown>;
}

export interface CodexRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexTransportSnapshot {
  state: "idle" | "starting" | "ready" | "stopping" | "closed" | "failed";
  pid?: number;
  executable: string;
  pendingRequests: number;
  restartCount: number;
  processSessionId?: string;
  lastError?: string;
}

export interface CodexAppServerProcessOptions {
  /** Host-selected executable. Renderer input is never accepted here. */
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxLineBytes?: number;
  spawnFn?: CodexSpawnFunction;
  onNotification?: (notification: CodexRpcNotification) => void;
  onServerRequest?: (request: CodexRpcRequest) => Promise<unknown> | unknown;
  onStderr?: (line: string) => void;
  /** Skip executable existence check (for testing with mock spawn functions) */
  skipExecutableCheck?: boolean;
}

export type CodexSpawnFunction = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class CodexTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(redactSecrets(message));
    this.name = "CodexTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

const DEFAULT_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Methods exposed through the CodeForge account adapter. This is deliberately not a generic
 * JSON-RPC bridge: a renderer or provider cannot turn this process into an arbitrary protocol
 * executor. New protocol methods must be reviewed here before they become reachable.
 */
const ALLOWED_CLIENT_METHODS = new Set([
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "account/rateLimits/read",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const TERMINAL_STREAM_METHODS = new Set([
  "turn/completed",
  "turn/failed",
  "turn/cancelled",
  "error",
]);

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamQueue<T> {
  values: T[];
  waiters: Array<(result: IteratorResult<T>) => void>;
  closed: boolean;
  push(value: T): void;
  close(): void;
  next(): Promise<IteratorResult<T>>;
}

interface ActiveNotificationStream {
  queue: StreamQueue<CodexRpcNotification>;
  threadId?: string;
}

function createStreamQueue<T>(): StreamQueue<T> {
  const queue: StreamQueue<T> = {
    values: [],
    waiters: [],
    closed: false,
    push(value) {
      if (queue.closed) return;
      const waiter = queue.waiters.shift();
      if (waiter) waiter({ done: false, value });
      else queue.values.push(value);
    },
    close() {
      if (queue.closed) return;
      queue.closed = true;
      for (const waiter of queue.waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    next() {
      if (queue.values.length > 0) return Promise.resolve({ done: false, value: queue.values.shift()! });
      if (queue.closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => queue.waiters.push(resolve));
    },
  };
  return queue;
}

function rpcKey(id: CodexRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function validRpcId(value: unknown): value is CodexRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageId(value: Record<string, unknown>): CodexRpcId | undefined {
  return validRpcId(value.id) ? value.id : undefined;
}

function isResponse(value: Record<string, unknown>): boolean {
  return messageId(value) !== undefined && ("result" in value || "error" in value) && typeof value.method !== "string";
}

function resolveExecutable(executable?: string): string {
  const configured = executable ?? process.env.CODEFORGE_CODEX_EXECUTABLE;
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }

  const platformName = platform();
  const archName = arch();
  const baseName = platformName === "win32" ? "codex.exe" : "codex";

  if (platformName === "win32" && archName === "x64") {
    const npmPackagePaths = [
      join(process.env.LOCALAPPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.exe"),
      join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.exe"),
      join(process.env.ProgramFiles || "", "nodejs", "node_modules", "@openai", "codex", "bin", "codex.exe"),
      join(process.env["ProgramFiles(x86)"] || "", "nodejs", "node_modules", "@openai", "codex", "bin", "codex.exe"),
      join(process.env.LOCALAPPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
      join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
      join(process.env.ProgramFiles || "", "nodejs", "node_modules", "@openai", "codex", "bin", "codex.js"),
      join(process.env["ProgramFiles(x86)"] || "", "nodejs", "node_modules", "@openai", "codex", "bin", "codex.js"),
    ];

    for (const path of npmPackagePaths) {
      if (existsSync(path)) return path;
    }
  }

  return baseName;
}

function isNodeScript(executable: string): boolean {
  return executable.endsWith(".js") || executable.endsWith(".mjs") || executable.endsWith(".cjs");
}

function safeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...process.env, ...env };
  for (const key of ["OPENAI_API_KEY", "CODEFORGE_OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_OPENAI_API_KEY"]) {
    delete result[key];
  }
  return result;
}

/** Host-owned Codex app-server stdio process. Never import this module from renderer code. */
export class CodexAppServerProcess implements CodexAppServerTransport {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly cwd?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly spawnFn: CodexSpawnFunction;
  private readonly skipExecutableCheck: boolean;
  private readonly notificationListeners = new Set<(notification: CodexRpcNotification) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streamQueues = new Set<ActiveNotificationStream>();
  private readonly handledServerRequestIds = new Set<string>();
  private readonly onServerRequest?: (request: CodexRpcRequest) => Promise<unknown> | unknown;
  private readonly onStderr?: (line: string) => void;
  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private state: CodexTransportSnapshot["state"] = "idle";
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private stopping = false;
  private sequence = 0;
  private restartCount = 0;
  private lastError: string | undefined;
  private processSessionId: string | undefined;

  constructor(options: CodexAppServerProcessOptions = {}) {
    this.executable = resolveExecutable(options.executable);
    this.args = options.args ?? DEFAULT_ARGS;
    this.cwd = options.cwd;
    this.env = safeEnv(options.env);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.spawnFn = options.spawnFn ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions));
    this.skipExecutableCheck = options.skipExecutableCheck ?? false;
    if (options.onNotification) this.notificationListeners.add(options.onNotification);
    this.onServerRequest = options.onServerRequest;
    this.onStderr = options.onStderr;
  }

  get snapshot(): CodexTransportSnapshot {
    return {
      state: this.state,
      executable: this.executable,
      pendingRequests: this.pending.size,
      restartCount: this.restartCount,
      ...(this.processSessionId ? { processSessionId: this.processSessionId } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  onNotification(listener: (notification: CodexRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!ALLOWED_CLIENT_METHODS.has(method)) {
      throw new CodexTransportError(`Codex method is not enabled: ${method}`, "UNSUPPORTED_METHOD");
    }
    await this.ensureStarted();
    return this.dispatchRequest(method, params);
  }

  async *stream(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): AsyncIterable<unknown> {
    if (!ALLOWED_CLIENT_METHODS.has(method)) {
      throw new CodexTransportError(`Codex method is not enabled: ${method}`, "UNSUPPORTED_METHOD");
    }
    const queue = createStreamQueue<CodexRpcNotification>();
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const activeStream: ActiveNotificationStream = { queue, ...(threadId ? { threadId } : {}) };
    this.streamQueues.add(activeStream);
    let requestId: CodexRpcId | undefined;
    const abortHandler = (): void => {
      queue.close();
      if (requestId !== undefined) this.cancelPendingRequest(requestId);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      await this.ensureStarted();
      if (queue.closed) return;
      const response = this.dispatchRequest(method, params, false, (id) => { requestId = id; });
      void response.catch(() => undefined);
      let terminalSeen = false;
      while (!terminalSeen) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
        terminalSeen = TERMINAL_STREAM_METHODS.has(next.value.method);
      }
      if (terminalSeen) await response;
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      this.streamQueues.delete(activeStream);
      queue.close();
    }
  }

  async respond(id: CodexRpcId, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.write({ id, result });
  }

  async respondError(id: CodexRpcId, code: string, message: string): Promise<void> {
    await this.ensureStarted();
    this.write({ id, error: { code, message: redactSecrets(message) } });
  }

  async restart(): Promise<void> {
    await this.closeInternal(false);
    this.restartCount += 1;
    this.state = "idle";
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal(true).finally(() => {
        this.closePromise = null;
      });
    }
    await this.closePromise;
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === "ready" && this.child && !this.child.killed) return;
    if (this.state === "stopping") throw new CodexTransportError("Codex app-server is stopping", "PROCESS_STOPPING", true);
    if (this.state === "failed" || this.state === "closed") {
      this.state = "idle";
    }
    if (!this.startPromise) this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    this.state = "starting";
    this.stopping = false;
    this.lastError = undefined;

    if (!this.skipExecutableCheck && !existsSync(this.executable)) {
      this.state = "failed";
      this.lastError = `Codex executable not found: ${this.executable}`;
      throw new CodexTransportError(this.lastError, "EXECUTABLE_NOT_FOUND", false);
    }

    let child: ChildProcess;
    try {
      const actualExecutable = isNodeScript(this.executable) ? process.execPath : this.executable;
      const actualArgs = isNodeScript(this.executable) ? [this.executable, ...this.args] : this.args;
      child = this.spawnFn(actualExecutable, actualArgs, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      this.state = "failed";
      this.lastError = redactSecrets(raw);
      throw new CodexTransportError(this.lastError, /ENOENT|not found/i.test(raw) ? "EXECUTABLE_NOT_FOUND" : "SPAWN_FAILED", /ENOENT|not found/i.test(raw));
    }
    this.child = child;
    this.processSessionId = randomUUID();
    this.readline = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.readline.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = redactSecrets(String(chunk));
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) this.onStderr?.(line);
      }
    });
    child.once("error", (error) => this.handleProcessFailure(error));
    child.once("close", (code, signal) => this.handleProcessClose(code, signal));

    try {
      await this.withTimeout(
        this.dispatchRequest("initialize", {
          clientInfo: { name: "codeforge-desktop", title: "CodeForge Desktop", version: "0.2.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }, true),
        this.startupTimeoutMs,
        "Codex app-server initialization timed out",
      );
      this.write({ method: "initialized" });
      this.state = "ready";
    } catch (error) {
      await this.closeInternal(false);
      this.state = "failed";
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lastError = redactSecrets(normalized.message);
      throw normalized instanceof CodexTransportError
        ? normalized
        : new CodexTransportError(this.lastError, "STARTUP_FAILED", true);
    }
  }

  private dispatchRequest(
    method: string,
    params: Record<string, unknown>,
    internal = false,
    onId?: (id: CodexRpcId) => void,
  ): Promise<unknown> {
    if (!internal && this.state !== "ready" && method !== "initialize") {
      throw new CodexTransportError("Codex app-server is not ready", "PROCESS_NOT_READY", true);
    }
    const id: CodexRpcId = `codeforge-${++this.sequence}`;
    onId?.(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcKey(id));
        reject(new CodexTransportError(`Codex request timed out: ${method}`, "REQUEST_TIMEOUT", true));
      }, this.requestTimeoutMs);
      this.pending.set(rpcKey(id), { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rpcKey(id));
        reject(error instanceof Error ? error : new CodexTransportError(String(error), "WRITE_FAILED", true));
      }
    });
  }

  private cancelPendingRequest(id: CodexRpcId): void {
    const pending = this.pending.get(rpcKey(id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(rpcKey(id));
    pending.resolve(undefined);
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin || this.child.stdin.destroyed || this.stopping) {
      throw new CodexTransportError("Codex app-server stdin is unavailable", "PROCESS_NOT_READY", true);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      this.handleProcessFailure(new CodexTransportError("Codex app-server JSONL message exceeded the size limit", "FRAME_TOO_LARGE"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handleProcessFailure(new CodexTransportError("Codex app-server emitted malformed JSONL", "MALFORMED_FRAME"));
      return;
    }
    const value = asRecord(parsed);
    if (!value) {
      this.handleProcessFailure(new CodexTransportError("Codex app-server emitted a non-object JSONL message", "MALFORMED_FRAME"));
      return;
    }
    const id = messageId(value);
    if (isResponse(value) && id !== undefined) {
      const pending = this.pending.get(rpcKey(id));
      if (!pending) return;
      this.pending.delete(rpcKey(id));
      clearTimeout(pending.timer);
      if ("error" in value) {
        const error = asRecord(value.error);
        pending.reject(new CodexTransportError(
          typeof error?.message === "string" ? error.message : `Codex request failed: ${pending.method}`,
          typeof error?.code === "string" ? error.code : "CODEX_RPC_ERROR",
        ));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (typeof value.method === "string" && id !== undefined) {
      const key = rpcKey(id);
      if (this.handledServerRequestIds.has(key)) return;
      this.handledServerRequestIds.add(key);
      void this.handleServerRequest({
        id,
        method: value.method,
        processSessionId: this.processSessionId ?? "unavailable",
        ...(asRecord(value.params) ? { params: asRecord(value.params)! } : {}),
      });
      return;
    }
    if (typeof value.method === "string") {
      const notification: CodexRpcNotification = {
        method: value.method,
        ...(asRecord(value.params) ? { params: asRecord(value.params)! } : {}),
      };
      const notificationThreadId = typeof notification.params?.threadId === "string"
        ? notification.params.threadId
        : undefined;
      for (const stream of this.streamQueues) {
        if (stream.threadId && notificationThreadId && stream.threadId !== notificationThreadId) continue;
        stream.queue.push(notification);
      }
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          this.lastError = redactSecrets(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private async handleServerRequest(request: CodexRpcRequest): Promise<void> {
    try {
      if (!this.onServerRequest) {
        this.respondToServerRequest(request, undefined, {
          code: "UNSUPPORTED_SERVER_REQUEST",
          message: `Unsupported Codex server request: ${request.method}`,
        });
        return;
      }
      const result = await this.onServerRequest(request);
      this.respondToServerRequest(request, result);
    } catch (error) {
      this.respondToServerRequest(request, undefined, {
        code: "SERVER_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Codex server request rejected",
      });
    }
  }

  private respondToServerRequest(
    request: CodexRpcRequest,
    result: unknown,
    error?: { code: string; message: string },
  ): void {
    if (this.processSessionId !== request.processSessionId || this.state !== "ready") return;
    try {
      if (error) this.write({ id: request.id, error: { code: error.code, message: redactSecrets(error.message) } });
      else this.write({ id: request.id, result });
    } catch {
      // The originating process may have exited while CodeForge was resolving an approval.
    }
  }

  private handleProcessFailure(error: Error): void {
    if (this.stopping) return;
    this.state = "failed";
    this.lastError = redactSecrets(error.message);
    const transportError = error instanceof CodexTransportError
      ? error
      : new CodexTransportError(this.lastError, "PROCESS_EXITED", true);
    this.rejectPending(transportError);
    for (const stream of this.streamQueues) stream.queue.close();
  }

  private handleProcessClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) return;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    this.handleProcessFailure(new CodexTransportError(`Codex app-server exited unexpectedly (${detail})`, "PROCESS_EXITED", true));
    this.detachProcess();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async closeInternal(markClosed: boolean): Promise<void> {
    if (!this.child) {
      if (markClosed) this.state = "closed";
      return;
    }
    this.stopping = true;
    this.state = "stopping";
    this.rejectPending(new CodexTransportError("Codex app-server closed", "PROCESS_CLOSED", true));
    for (const stream of this.streamQueues) stream.queue.close();
    const child = this.child;
    try { child.stdin?.end(); } catch { /* process is already gone */ }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* process is already gone */ }
        finish();
      }, this.shutdownTimeoutMs);
      child.once("close", finish);
      if (child.exitCode !== null || child.killed) finish();
    });
    this.detachProcess();
    this.state = markClosed ? "closed" : "idle";
    this.stopping = false;
  }

  private detachProcess(): void {
    this.readline?.close();
    this.readline = null;
    this.child = null;
    this.processSessionId = undefined;
    this.handledServerRequestIds.clear();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodexTransportError(message, "STARTUP_TIMEOUT", true)), timeoutMs);
      });
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createCodexAppServerProcess(options: CodexAppServerProcessOptions = {}): CodexAppServerProcess {
  return new CodexAppServerProcess(options);
}

export function getCodexExecutableFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return resolveExecutable(env.CODEFORGE_CODEX_EXECUTABLE);
}
