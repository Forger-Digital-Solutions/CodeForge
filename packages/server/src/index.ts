import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceEvent, type WorkspaceEvent } from "@codeforge/protocol";
import { EventStore, createSessionPersistence, type SessionRecord, type TurnRecord, type WorkItem } from "@codeforge/sessions";
import {
  ForgeZero,
  createDevelopmentEntitlementProvider,
  createGenericFreeRecord,
  PAID_CATALOG,
} from "@codeforge/forge-zero";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import type { ProviderCatalog } from "@codeforge/providers";
import { InMemoryProviderCatalog, EnvironmentCredentialStore } from "@codeforge/providers";
import { runDemoRuntime } from "./demo-runtime.js";
import { AgentRuntime, createAgentRuntime } from "./agent-runtime.js";
import { resolveWithinWorkspace } from "./path-security.js";
import { createWorkflowService, type WorkflowService } from "./workflow-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  port?: number;
  webDist?: string;
  dbPath?: string;
  /** Catalog injection point for tests; production uses InMemoryProviderCatalog. */
  providerCatalog?: ProviderCatalog;
  firewall?: ForgeZero;
  useRealRuntime?: boolean;
}

export class CodeForgeServer {
  private port: number;
  private webDist: string;
  private eventStore: EventStore;
  private server: http.Server | null = null;
  private clients: Set<http.ServerResponse> = new Set();
  private persistence: ReturnType<typeof createSessionPersistence>;
  private firewall: ForgeZero;
  private providerCatalog: ProviderCatalog;
  private runtimes: Map<string, AgentRuntime> = new Map();
  private useRealRuntime: boolean;
  private activeWorkspacePath: string | null = null;
  private workflowService: WorkflowService;

  constructor(options: ServerOptions = {}) {
    this.port = options.port ?? 3210;
    this.webDist = options.webDist ?? path.join(__dirname, "..", "web", "dist");
    this.persistence = createSessionPersistence(
      options.dbPath ? { dbPath: options.dbPath } : undefined,
    );
    this.eventStore = new EventStore();
    const persistedEvents = this.persistence
      .listSessions()
      .flatMap((session) => this.persistence.getEvents(session.id))
      .filter(isWorkspaceEvent);
    this.eventStore.hydrate(persistedEvents);
    // Development scaffold: deterministic entitlement scenarios until the real
    // entitlement service exists. GEMS access still fails closed.
    this.firewall = options.firewall ?? new ForgeZero({
      entitlementProvider: createDevelopmentEntitlementProvider(),
    });
    this.providerCatalog = options.providerCatalog ?? new InMemoryProviderCatalog();
    this.useRealRuntime = options.useRealRuntime ?? process.env.CODEFORGE_REAL_RUNTIME === "true";

    // Validate that API keys are available if real runtime is requested
    if (this.useRealRuntime) {
      this.validateRealRuntimeConfiguration();
    }

    this.registerFreeModels();
    this.registerPaidModels();
    this.registerGemsModels();
    this.workflowService = createWorkflowService({
      eventStore: this.eventStore,
      persistence: this.persistence,
      workspacePath: this.activeWorkspacePath ?? undefined,
      getOrCreateRuntime: (sessionId: string, userId?: string) => this.getOrCreateRuntime(sessionId, userId),
      useRealRuntime: this.useRealRuntime,
    });
  }

  private validateRealRuntimeConfiguration(): void {
    // Check for configured provider API keys
    const credentialStore = new EnvironmentCredentialStore();
    
    // Check for common provider API keys
    const providerKeys = [
      "openrouter", // OpenRouter API key
      "opencode", // OpenCode Zen API key
    ];
    
    const hasAtLeastOneApiKey = providerKeys.some(
      (providerId) => credentialStore.has(providerId)
    );
    
    if (!hasAtLeastOneApiKey) {
      console.warn(
        "⚠️  CODEFORGE_REAL_RUNTIME=true but no provider API keys configured.\n" +
        "Real runtime mode requires at least one provider API key (e.g., OPENROUTER_API_KEY).\n" +
        "The server will start but real inference will fail at runtime.\n" +
        "Set API keys in environment variables or configure credentials in the app."
      );
    }
  }

  private registerFreeModels(): void {
    // Only the generic baseline free record ships by default. Muse Spark is a promotional
    // model and is intentionally NOT registered into normal routing (free-first policy);
    // real free models are discovered from connected providers and verified by ForgeZero.
    const generic = createGenericFreeRecord();
    this.firewall.register(generic);
  }

  private registerPaidModels(): void {
    for (const model of PAID_CATALOG) {
      this.firewall.register(model);
    }
  }

  /**
   * First-party GEMS paid models. Registered so they are visible to the model
   * selector, but they are never free-eligible (auto-routing cannot pick them)
   * and every turn using them passes through ForgeZero.checkEntitlement.
   */
  private registerGemsModels(): void {
    const gemsModels: Array<{ modelId: string; displayName: string }> = [
      { modelId: "topaz", displayName: "Topaz" },
      { modelId: "sapphire", displayName: "Sapphire" },
      { modelId: "peridot", displayName: "Peridot" },
      { modelId: "garnet", displayName: "Garnet" },
    ];

    for (const gem of gemsModels) {
      const model: FreeModelRecord = {
        providerId: "codeforge",
        modelId: gem.modelId,
        displayName: gem.displayName,
        freeStatus: "paid",
        tier: "gems_paid",
        contextWindow: 128000,
        capabilities: {
          text: true,
          coding: true,
          toolCalling: true,
          vision: false,
          structuredOutput: true,
          longContext: true,
        },
        costProfile: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          isFree: false,
          paidFallbackPossible: false,
          paidFallbackDisabled: true,
          source: "official",
        },
        isRemote: true,
        isCloudHosted: true,
      };
      this.firewall.register(model);
    }
  }

  /** Bound port after start() (resolves the ephemeral port when started with 0). */
  get httpPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    const server = this.server;
    await new Promise<void>((resolveListen) => {
      server.listen(this.port, () => resolveListen());
    });
    const address = server.address();
    if (typeof address === "object" && address !== null) {
      this.port = address.port;
    }
    console.log(`CodeForge server running at http://localhost:${this.port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = null;
      server.close();
      // Keep-alive sockets from HTTP clients must not hold the process open.
      server.closeAllConnections();
    }
    this.clients.clear();
    this.persistence.close();
  }

  private persistSession(sessionId: string, userMessage: string): void {
    const now = new Date().toISOString();
    const existing = this.persistence.getSession(sessionId);
    this.persistence.upsertSession({
      id: sessionId,
      title: userMessage.slice(0, 80),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "running",
    });
  }

  private persistTurn(sessionId: string, turnId: string, userMessage: string): void {
    const turn: TurnRecord = {
      id: turnId,
      sessionId,
      seq: this.eventStore.getLastSeq(),
      userMessage,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.persistence.upsertTurn(turn);
  }

  private appendDemoEvent(event: WorkspaceEvent): void {
    this.eventStore.append(event);
    this.persistence.appendEvent({ ...event, seq: this.eventStore.getLastSeq() });

    const completedAt = new Date().toISOString();
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      const payload = event.payload as { turnId: string; error?: string };
      const turn = this.persistence.getTurns(event.sessionId).find((candidate) => candidate.id === payload.turnId);
      if (turn) {
        this.persistence.upsertTurn({
          ...turn,
          status: event.type === "turn.completed" ? "completed" : event.type === "turn.cancelled" ? "cancelled" : "failed",
          completedAt,
          error: event.type === "turn.failed" ? payload.error : undefined,
        });
      }
    }

    if (event.type === "status.changed") {
      const payload = event.payload as { to: string };
      const status = payload.to === "completed" || payload.to === "failed" || payload.to === "cancelled"
        ? payload.to
        : undefined;
      const session = status ? this.persistence.getSession(event.sessionId) : undefined;
      if (session && status) {
        this.persistence.upsertSession({ ...session, status, updatedAt: completedAt });
      }
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/api/events") {
      this.handleSSE(req, res);
      return;
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      this.handleSend(req, res);
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/turns\/[^/]+\/pause$/) && req.method === "POST") {
      this.handlePauseTurn(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/turns\/[^/]+\/resume$/) && req.method === "POST") {
      this.handleResumeTurn(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/) && req.method === "POST") {
      this.handleCancelTurn(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/turns\/[^/]+\/steer$/) && req.method === "POST") {
      this.handleSteerTurn(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/approvals\/[^/]+\/resolve$/) && req.method === "POST") {
      this.handleResolveApproval(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/questions\/[^/]+\/resolve$/) && req.method === "POST") {
      this.handleResolveQuestion(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/api/workspace/set" && req.method === "POST") {
      this.handleSetWorkspace(req, res);
      return;
    }

    if (url.pathname === "/api/workspace/tree" && req.method === "GET") {
      this.handleWorkspaceTree(req, res, url);
      return;
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      this.handleModels(res);
      return;
    }

    if (url.pathname === "/api/free/top" && req.method === "GET") {
      this.handleTopFree(res);
      return;
    }

    if (url.pathname === "/api/privacy-mode" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ mode: this.firewall.getPrivacyMode() ?? "STANDARD" }));
      return;
    }

    if (url.pathname === "/api/privacy-mode" && req.method === "POST") {
      this.handleSetPrivacyMode(req, res);
      return;
    }

    if (url.pathname === "/api/model-selection" && req.method === "POST") {
      this.handleModelSelection(req, res);
      return;
    }

    if (url.pathname.match(/^\/api\/providers\/[^/]+\/health$/) && req.method === "GET") {
      this.handleProviderHealth(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const sessions = this.persistence.listSessions();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/events") && req.method === "GET") {
      const sessionId = url.pathname.replace("/api/sessions/", "").replace("/events", "");
      const events = this.persistence.getEvents(sessionId);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(events));
      return;
    }

    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const sessionId = url.pathname.replace("/api/sessions/", "");
      const session = this.persistence.getSession(sessionId);
      const turns = this.persistence.getTurns(sessionId);
      const workItems = this.persistence.getWorkItems(sessionId);
      const events = this.persistence.getEvents(sessionId);
      const runtime = this.runtimes.get(sessionId);
      const runtimeApprovals = runtime?.getAllPendingApprovals().map((a) => ({
        approvalId: a.approvalId,
        tool: a.tool,
        action: a.action,
        description: a.description,
        risk: a.risk,
        scope: a.scope,
      })) ?? [];
      const workflowApprovals = this.workflowService.getApprovalService().getAllPending().map((a) => ({
        approvalId: a.approvalId,
        tool: a.tool,
        action: a.action,
        description: a.description,
        risk: a.risk,
        scope: a.scope,
      }));
      const pendingApprovals = [...runtimeApprovals, ...workflowApprovals];
      const pendingQuestions = runtime?.getAllPendingQuestions().map((q) => ({
        questionId: q.questionId,
        prompt: q.prompt,
        options: q.options,
      })) ?? [];
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ session, turns, workItems, events, pendingApprovals, pendingQuestions }));
      return;
    }

    if (url.pathname === "/api/workflow/run" && req.method === "POST") {
      this.handleWorkflowRun(req, res);
      return;
    }

    if (url.pathname === "/api/workflow" && req.method === "GET") {
      this.handleWorkflowList(req, res);
      return;
    }

    if (url.pathname.match(/^\/api\/workflow\/[^/]+$/) && req.method === "GET") {
      this.handleWorkflowGet(req, res, url.pathname);
      return;
    }

    if (url.pathname.match(/^\/api\/workflow\/[^/]+\/cancel$/) && req.method === "POST") {
      this.handleWorkflowCancel(req, res, url.pathname);
      return;
    }

    this.serveStatic(req, res, url.pathname);
  }

  private shouldUseWorkflow(message: string): boolean {
    if (!this.activeWorkspacePath) return false;
    if (!message || typeof message !== "string" || !message.trim()) return false;
    // Heuristic: coding tasks contain verbs like fix, implement, add, create, refactor, etc.
    // For real autonomous execution, any non-trivial message with workspace should go via workflow
    // when useRealRuntime or when explicitly requested via data.useWorkflow
    const lower = message.toLowerCase();
    return /(fix|implement|add|create|build|refactor|update|change|modify|feature|bug|test|repair|implement|create)/.test(lower) && message.trim().length > 10;
  }

  private handleSend(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const sessionId = data.sessionId ?? "default";
        const message: string = data.message ?? "";
        const wantsWorkflow = data.useWorkflow === true || (this.activeWorkspacePath && this.shouldUseWorkflow(message));

        if (wantsWorkflow && this.activeWorkspacePath) {
          // Real autonomous workflow path: Understand → Inspect → Plan → Approval → Implement (via AgentRuntime) → Verify → Repair → Review
          try {
            const wf = await this.workflowService.startWorkflow({
              sessionId,
              message,
              workspacePath: this.activeWorkspacePath,
              userId: typeof data.userId === "string" ? data.userId : undefined,
              verificationCommands: Array.isArray(data.verificationCommands) ? data.verificationCommands : undefined,
              forceHeuristic: data.forceHeuristic === true ? true : undefined,
            });
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, turnId: wf.turnId, taskId: wf.taskId, mode: this.realRuntimeEnabled() ? "real-workflow" : "workflow" }));
            return;
          } catch (e) {
            // Fall through to normal turn on workflow start failure
            console.warn("Workflow start failed, falling back to turn:", e instanceof Error ? e.message : String(e));
          }
        }

        const runtime = this.getOrCreateRuntime(
          sessionId,
          typeof data.userId === "string" && data.userId ? data.userId : undefined,
        );

        // Start the turn in the runtime (tracks state for pause/resume/cancel)
        // In demo mode, AgentRuntime skips real provider execution entirely.
        const turnId = await runtime.startTurn(message);

        if (this.realRuntimeEnabled()) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, turnId, mode: "real" }));
        } else {
          runDemoRuntime({
            sessionId,
            turnId,
            emit: (event) => this.appendDemoEvent(event),
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true, turnId, mode: "demo" }));
        }
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({
          error: "SEND_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  }

  private handlePauseTurn(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/pause$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, sessionId, turnId] = match;
    const runtime = this.runtimes.get(sessionId ?? "");
    if (!runtime) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    
    runtime.pauseTurn(turnId ?? "")
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  }

  private handleResumeTurn(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/resume$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, sessionId, turnId] = match;
    const runtime = this.runtimes.get(sessionId ?? "");
    if (!runtime) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    
    runtime.resumeTurn(turnId ?? "")
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  }

  private handleCancelTurn(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/cancel$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, sessionId, turnId] = match;
    const runtime = this.runtimes.get(sessionId ?? "");
    if (!runtime) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    runtime.cancelTurn(turnId ?? "", "User cancelled")
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  }

  private handleSteerTurn(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/steer$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, sessionId, turnId] = match;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const runtime = this.runtimes.get(sessionId ?? "");
        if (!runtime) {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        await runtime.steerTurn(turnId ?? "", data.steering ?? "");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  private handleResolveApproval(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/approvals\/([^/]+)\/resolve$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, approvalId] = match;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        for (const runtime of this.runtimes.values()) {
          const approval = runtime.getPendingApproval(approvalId ?? "");
          if (approval) {
            runtime.resolveApproval(approvalId ?? "", data.decision ?? "deny");
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }
        // Also check workflow service approvals
        const wfApproval = this.workflowService.getApprovalService().getPending(approvalId ?? "");
        if (wfApproval) {
          this.workflowService.getApprovalService().resolve(approvalId ?? "", data.decision === "allow_session" ? "allow_session" : data.decision === "allow_once" ? "allow_once" : "deny");
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const wfRecord = this.workflowService.getApprovalService().getRecord(approvalId ?? "");
        if (wfRecord) {
          // Allow resolving already handled but still pending in legacy sense
          try {
            this.workflowService.getApprovalService().resolve(approvalId ?? "", data.decision === "allow_session" ? "allow_session" : data.decision === "allow_once" ? "allow_once" : "deny");
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
          } catch {}
        }
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Approval not found" }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  private handleResolveQuestion(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/questions\/([^/]+)\/resolve$/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const [, questionId] = match;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        for (const runtime of this.runtimes.values()) {
          const question = runtime.getPendingQuestion(questionId ?? "");
          if (question) {
            runtime.resolveQuestion(questionId ?? "", data.answer ?? "");
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Question not found" }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  public setWorkspace(workspacePath: string): void {
    if (!fs.existsSync(workspacePath)) {
      throw new Error("Workspace path does not exist");
    }
    const stats = fs.statSync(workspacePath);
    if (!stats.isDirectory()) {
      throw new Error("Workspace path is not a directory");
    }
    this.activeWorkspacePath = workspacePath;
    this.workflowService.setWorkspacePath(workspacePath);
    this.runtimes.clear();
  }

  private handleSetWorkspace(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const workspacePath = typeof data.path === "string" ? data.path : "";
        if (!workspacePath) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "path required" }));
          return;
        }

        this.setWorkspace(workspacePath);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, path: workspacePath }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  private handleWorkflowRun(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const sessionId = typeof data.sessionId === "string" && data.sessionId ? data.sessionId : "default";
        const message = typeof data.message === "string" ? data.message : "";
        if (!message.trim()) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "message required" }));
          return;
        }
        const workspacePath = typeof data.workspacePath === "string" && data.workspacePath ? data.workspacePath : this.activeWorkspacePath ?? undefined;
        if (!workspacePath) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "No workspace set" }));
          return;
        }
        const result = await this.workflowService.startWorkflow({
          sessionId,
          message,
          workspacePath,
          verificationCommands: Array.isArray(data.verificationCommands) ? data.verificationCommands : undefined,
          forceHeuristic: data.forceHeuristic === true ? true : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, taskId: result.taskId, turnId: result.turnId }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }

  private handleWorkflowList(req: http.IncomingMessage, res: http.ServerResponse): void {
    const tasks = this.workflowService.listWorkflows();
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(tasks));
  }

  private handleWorkflowGet(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/^\/api\/workflow\/([^/]+)$/);
    const taskId = match?.[1];
    if (!taskId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid task id" }));
      return;
    }
    const entry = this.workflowService.getWorkflow(taskId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Workflow not found" }));
      return;
    }
    // Also include persisted session data if available
    const session = this.persistence.getSession(entry.task.sessionId);
    const workItems = this.persistence.getWorkItems(entry.task.sessionId);
    const events = this.persistence.getEvents(entry.task.sessionId);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ task: entry.task, session, workItems, events }));
  }

  private handleWorkflowCancel(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/^\/api\/workflow\/([^/]+)\/cancel$/);
    const taskId = match?.[1];
    if (!taskId) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid task id" }));
      return;
    }
    this.workflowService.cancelWorkflow(taskId).then(() => {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  }

  private handleWorkspaceTree(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const requestedPath = url.searchParams.get("path");

    if (!this.activeWorkspacePath && !requestedPath) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "No workspace set" }));
      return;
    }

    const workspaceRoot = this.activeWorkspacePath || requestedPath;
    if (!workspaceRoot) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "No workspace path provided" }));
      return;
    }

    try {
      let resolvedRoot: string;

      // Security: if a path parameter is provided alongside an active workspace,
      // enforce symlink/junction-aware containment within the active workspace.
      if (requestedPath && this.activeWorkspacePath) {
        const containment = resolveWithinWorkspace(this.activeWorkspacePath, requestedPath);
        if (!containment.valid || !containment.resolvedPath) {
          res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "Path traversal denied: workspace boundary violated" }));
          return;
        }
        resolvedRoot = containment.resolvedPath;
      } else {
        if (!this.activeWorkspacePath && requestedPath) {
          res.writeHead(403, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "Workspace must be set before browsing filesystem" }));
          return;
        }
        resolvedRoot = path.resolve(workspaceRoot);
      }

      if (!fs.existsSync(resolvedRoot)) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Workspace not found" }));
        return;
      }

      const tree = this.buildFileTree(resolvedRoot, resolvedRoot);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(tree));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Real runtime is enabled when it was explicitly forced (constructor/env) OR at least one real
   * (non-test) provider adapter is registered. This is evaluated DYNAMICALLY so connecting a
   * provider AFTER boot — the normal first-run flow (fresh profile → OAuth → send) — flips the
   * server from demo to real without a restart. Test/mock providers never flip it.
   */
  private realRuntimeEnabled(): boolean {
    return this.useRealRuntime || this.providerCatalog.all().some((a) => a.isTestProvider !== true);
  }

  private getOrCreateRuntime(sessionId: string, userId?: string): AgentRuntime {
    const demoMode = !this.realRuntimeEnabled();
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      runtime = createAgentRuntime({
        sessionId,
        eventStore: this.eventStore,
        persistence: this.persistence,
        firewall: this.firewall,
        providerCatalog: this.providerCatalog,
        workspacePath: this.activeWorkspacePath ?? undefined,
        userId,
        demoMode,
      });
      this.runtimes.set(sessionId, runtime);
    } else {
      // A provider may have connected since this runtime was created — re-sync demo/real.
      runtime.setDemoMode(demoMode);
    }
    return runtime;
  }

  /**
   * HTTP boundary for UI model selection. The server stays authoritative:
   * only models registered with ForgeZero can be selected (unknown ids fail
   * closed), and gems_paid entitlement is still enforced later in
   * AgentRuntime.executeTurn via ForgeZero.checkEntitlement immediately
   * before any provider execution. A client sending a locked model id can
   * never bypass that gate.
   */
  private handleModelSelection(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const sessionId =
          typeof data.sessionId === "string" && data.sessionId ? data.sessionId : "default";
        const runtime = this.getOrCreateRuntime(
          sessionId,
          typeof data.userId === "string" && data.userId ? data.userId : undefined,
        );

        const respond = (status: number, payload: Record<string, unknown>): void => {
          res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(payload));
        };

        const modelId = data.modelId;
        if (modelId === undefined || modelId === null || modelId === "auto") {
          runtime.clearModelSelection();
          respond(200, { ok: true, selection: { modelId: "auto" } });
          return;
        }

        if (typeof modelId !== "string" || typeof data.providerId !== "string") {
          respond(400, {
            error: "MODEL_SELECTION_INVALID",
            message: "providerId and modelId must be strings when selecting a model",
          });
          return;
        }

        // Fail closed: reject selections for unregistered models instead of
        // storing them and letting the turn path discover the miss.
        const model = this.firewall.getModel(data.providerId, modelId);
        if (!model) {
          respond(400, {
            error: "MODEL_NOT_FOUND",
            message: `Unknown model ${data.providerId}/${modelId}`,
          });
          return;
        }

        runtime.setModelSelection({ providerId: data.providerId, modelId });
        respond(200, {
          ok: true,
          selection: { providerId: data.providerId, modelId, tier: model.tier ?? "free" },
        });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  private handleModels(res: http.ServerResponse): void {
    const models = this.firewall.allModels().map((m) => ({
      id: m.modelId,
      providerId: m.providerId,
      displayName: m.displayName,
      tier: m.tier ?? "free",
      freeStatus: m.freeStatus,
      // Free-first taxonomy for the model selector + honest cost UI.
      accessClass: m.accessClass,
      authMode: m.authMode,
      privacyClass: m.privacyClass,
      family: m.family,
      deprecated: m.deprecated ?? false,
      // Verified-free + routable (passes ForgeZero incl. orphan/auth/privacy) → Auto-eligible.
      verifiedFree: m.freeStatus === "verified_free",
      eligible: this.firewall.canRouteTo(m.providerId, m.modelId),
      contextWindow: m.contextWindow,
      capabilities: m.capabilities,
      codingScore: m.codingScore,
      agentScore: m.agentScore,
      costProfile: m.costProfile ? {
        inputCostPerMillion: m.costProfile.inputCostPerMillion,
        outputCostPerMillion: m.costProfile.outputCostPerMillion,
        isFree: m.costProfile.isFree,
        paidFallbackPossible: m.costProfile.paidFallbackPossible,
      } : undefined,
      isPromotional: m.costProfile?.source === "opencode:free",
    }));
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(models));
  }

  /**
   * Live "Top Verified Free" — deterministic ForgeZero/router ranking over the currently
   * eligible verified-free models. Never hardcoded; reflects connected + verified providers now.
   */
  private handleTopFree(res: http.ServerResponse): void {
    const router = new ForgeRouter({ firewall: this.firewall });
    const ranked = router.topVerifiedFree(
      { taskType: "coding", estimatedContextTokens: 16000, requiredCapabilities: ["coding", "toolCalling"] },
      5,
    );
    const out = ranked.map((r, i) => ({
      rank: i + 1,
      id: r.model.modelId,
      providerId: r.model.providerId,
      displayName: r.model.displayName,
      accessClass: r.model.accessClass,
      privacyClass: r.model.privacyClass,
      contextWindow: r.model.contextWindow,
      toolCalling: r.model.capabilities.toolCalling,
      score: r.score,
      reasons: r.reasons,
    }));
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(out));
  }

  private handleSetPrivacyMode(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as { mode?: string };
        const valid = new Set(["STRICT", "STANDARD", "MAXIMUM_FREE"]);
        if (!data.mode || !valid.has(data.mode)) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ error: "Invalid privacy mode" }));
          return;
        }
        this.firewall.setPrivacyMode(data.mode as "STRICT" | "STANDARD" | "MAXIMUM_FREE");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true, mode: data.mode }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  private handleProviderHealth(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const match = pathname.match(/\/api\/providers\/([^/]+)\/health$/);
    if (!match || !match[1]) {
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid path" }));
      return;
    }
    const providerId = match[1];
    const adapter = this.providerCatalog.get(providerId);
    if (!adapter) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Provider not found" }));
      return;
    }

    adapter.healthCheck()
      .then((health) => {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(health));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      });
  }

  private buildFileTree(dirPath: string, rootPath: string, depth: number = 0): Array<{ name: string; path: string; type: "file" | "directory"; children?: unknown[] }> {
    if (depth > 20) return [];
    
    const entries: Array<{ name: string; path: string; type: "file" | "directory"; children?: unknown[] }> = [];
    
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const item of items) {
        if (item.name.startsWith(".") && item.name !== ".git") continue;
        
        const itemPath = path.join(dirPath, item.name);
        const relativePath = path.relative(rootPath, itemPath);
        
        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: relativePath,
            type: "directory",
            children: this.buildFileTree(itemPath, rootPath, depth + 1),
          });
        } else if (item.isFile()) {
          entries.push({
            name: item.name,
            path: relativePath,
            type: "file",
          });
        }
      }
    } catch {
      // Skip directories we can't read
    }

    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const lastSeq = parseInt(url.searchParams.get("lastSeq") ?? "0", 10) || 0;
    // Session isolation: when a sessionId is supplied, this stream carries ONLY that
    // session's events. Events for other sessions never reach this client, so switching
    // between sessions cannot bleed one conversation's stream into another.
    const sessionFilter = url.searchParams.get("sessionId");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    this.clients.add(res);

    const send = (event: WorkspaceEvent) => {
      if (sessionFilter && event.sessionId !== sessionFilter) return;
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // The close handler owns subscription cleanup.
      }
    };

    const missed = this.eventStore.getAll({ afterSeq: lastSeq });
    missed.forEach(send);

    const unsub = this.eventStore.subscribe(send);
    res.on("close", () => {
      this.clients.delete(res);
      unsub();
    });

    res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
    let safePath = decodeURIComponent(filePath);
    if (safePath === "/" || safePath === "") safePath = "/index.html";

    // Canonical containment: resolve + realpath to prevent prefix collision and symlink escape
    const webReal = (() => {
      try { return fs.realpathSync(this.webDist); } catch { return path.resolve(this.webDist); }
    })();
    const fullPath = path.resolve(path.join(webReal, safePath));
    const effective = (() => {
      try { return fs.realpathSync(fullPath); } catch {
        // File may not exist yet — check parent chain
        let cur = fullPath;
        for (;;) {
          try { return fs.realpathSync(cur); } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return fullPath;
            cur = parent;
          }
        }
      }
    })();
    const rel = path.relative(webReal, effective);
    const escapes = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
    const lexicalRel = path.relative(webReal, fullPath);
    const lexicalEscapes = lexicalRel === ".." || lexicalRel.startsWith(".." + path.sep) || path.isAbsolute(lexicalRel);
    if (escapes || lexicalEscapes) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(fullPath);
      const mimeTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(data);
    });
  }
}

export * from "./demo-runtime.js";
export * from "./workspace-event-adapter.js";
export * from "./agent-runtime.js";
export * from "./filesystem-service.js";
export * from "./command-service.js";
export * from "./validation-service.js";
export * from "./checkpoint-service.js";
export function createServer(options?: ServerOptions): CodeForgeServer {
  return new CodeForgeServer(options);
}
