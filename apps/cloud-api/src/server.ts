import http from "node:http";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { CloudDatabase, createCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { AuthService } from "@codeforge/cloud-auth";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { StripeBillingService, type StripeConfig } from "@codeforge/cloud-billing";
import { CloudFirewallManager, GatewayService, type HostedInferenceRequest, type HostedStreamEvent } from "@codeforge/cloud-gateway";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB max payload

// Boundary Zod Schemas
const AuthStartSchema = z.object({
  redirectUri: z.string().url().default("http://127.0.0.1:8765/auth/callback"),
  deviceName: z.string().max(255).optional(),
});

const AuthExchangeSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectUri: z.string().url().optional(),
  deviceName: z.string().max(255).optional(),
});

const AuthRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const AuthLogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const AccountSettingsSchema = z.object({
  privacyMode: z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]).optional(),
  spendLimitUsd: z.number().nonnegative().optional(),
});

const BillingCheckoutSchema = z.object({
  planId: z.string().optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const BillingPortalSchema = z.object({
  returnUrl: z.string().url(),
});

const HostedInferenceSchema = z.object({
  requestId: z.string().min(1),
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  providerId: z.string().optional(),
  taskType: z.string().optional(),
  estimatedContextTokens: z.number().int().nonnegative().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
});

export interface CodeForgeCloudServerConfig {
  port?: number;
  host?: string;
  db?: ICloudDatabase;
  dbPath?: string;
  databaseUrl?: string;
  driver?: "sqlite" | "postgres";
  jwtSecret?: string;
  gitHubClientId?: string;
  gitHubClientSecret?: string;
  stripeConfig?: StripeConfig;
  firewallManager?: CloudFirewallManager;
  fetchFn?: typeof fetch;
  allowedOrigins?: string[];
  maxRequestsPerMinute?: number;
}

export class CodeForgeCloudServer {
  private readonly server: http.Server;
  public readonly db: ICloudDatabase;
  public readonly auth: AuthService;
  public readonly entitlements: EntitlementService;
  public readonly usage: UsageEngine;
  public readonly billing: StripeBillingService;
  public readonly firewallManager: CloudFirewallManager;
  public readonly gateway: GatewayService;
  private readonly allowedOrigins: Set<string>;
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxRequestsPerMinute: number;
  private actualPort = 0;
  private host: string;

  constructor(config: CodeForgeCloudServerConfig = {}) {
    const isProduction = process.env.NODE_ENV === "production";

    // Fail closed in production for insecure or default secrets
    const jwtSecret = config.jwtSecret ?? (isProduction ? undefined : "codeforge-cloud-test-jwt-secret-key-32chars");
    if (!jwtSecret || jwtSecret.length < 32 || (isProduction && jwtSecret.includes("test-jwt-secret"))) {
      throw new Error("Invalid or insecure JWT_SECRET. In production, JWT_SECRET must be at least 32 cryptographically strong characters.");
    }

    const gitHubClientId = config.gitHubClientId ?? (isProduction ? undefined : "gh_client_mock_123");
    if (!gitHubClientId || (isProduction && gitHubClientId.includes("mock"))) {
      throw new Error("Missing or invalid GITHUB_CLIENT_ID for cloud server.");
    }

    if (isProduction && !config.gitHubClientSecret) {
      throw new Error("Missing GITHUB_CLIENT_SECRET for production cloud server.");
    }

    const stripeConfig = config.stripeConfig ?? {
      secretKey: isProduction ? (process.env.STRIPE_SECRET_KEY as string) : "sk_test_mock_123",
      webhookSecret: isProduction ? (process.env.STRIPE_WEBHOOK_SECRET as string) : "whsec_mock_456",
      proPriceId: isProduction ? (process.env.STRIPE_PRO_PRICE_ID as string) : "price_pro_test",
      creditPackPriceId: isProduction ? (process.env.STRIPE_CREDIT_PRICE_ID as string) : "price_credits_test",
    };

    if (isProduction && (!stripeConfig.secretKey || !stripeConfig.webhookSecret)) {
      throw new Error("Missing Stripe test-mode credentials for production cloud server.");
    }

    this.host = config.host ?? "127.0.0.1";
    this.allowedOrigins = new Set(config.allowedOrigins ?? ["http://127.0.0.1", "http://localhost", "https://codeforge.dev"]);
    this.maxRequestsPerMinute = config.maxRequestsPerMinute ?? 120;

    if (config.db) {
      this.db = config.db;
    } else {
      this.db = createCloudDatabase({
        driver: config.driver,
        dbPath: config.dbPath,
        databaseUrl: config.databaseUrl,
      });
    }

    this.entitlements = new EntitlementService(this.db);
    this.usage = new UsageEngine(this.db);
    this.firewallManager = config.firewallManager ?? new CloudFirewallManager();

    this.auth = new AuthService({
      db: this.db,
      jwtSecret,
      gitHubClientId,
      gitHubClientSecret: config.gitHubClientSecret,
      fetchFn: config.fetchFn,
    });

    this.billing = new StripeBillingService(this.db, this.entitlements, stripeConfig);

    this.gateway = new GatewayService({
      firewallManager: this.firewallManager,
      entitlementService: this.entitlements,
      usageEngine: this.usage,
      db: this.db,
    });

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  get httpPort(): number {
    return this.actualPort;
  }

  async start(port = 0, host?: string): Promise<number> {
    const bindHost = host ?? this.host;
    return new Promise<number>((resolve, reject) => {
      this.server.listen(port, bindHost, () => {
        const addr = this.server.address() as AddressInfo;
        this.actualPort = addr.port;
        resolve(this.actualPort);
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        void Promise.resolve(this.db.close()).then(() => resolve());
      });
    });
  }

  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(key);
    if (!entry || now > entry.resetAt) {
      this.rateLimits.set(key, { count: 1, resetAt: now + 60000 });
      return true;
    }
    if (entry.count >= this.maxRequestsPerMinute) {
      return false;
    }
    entry.count++;
    return true;
  }

  private async readJson<T>(req: http.IncomingMessage, schema: z.ZodSchema<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let data = "";
      let bytes = 0;
      let exceeded = false;

      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          exceeded = true;
          return;
        }
        data += chunk;
      });

      req.on("end", () => {
        if (exceeded) {
          reject(new Error("Payload Too Large: Request body exceeds maximum allowed size (1 MiB)"));
          return;
        }
        try {
          const parsed = data ? JSON.parse(data) : {};
          const validated = schema.parse(parsed);
          resolve(validated);
        } catch (e) {
          if (e instanceof z.ZodError) {
            reject(new Error(`Validation error: ${e.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join(", ")}`));
          } else {
            reject(new Error("Invalid JSON body"));
          }
        }
      });

      req.on("error", reject);
    });
  }

  private async readRawBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = "";
      let bytes = 0;
      let exceeded = false;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          exceeded = true;
          return;
        }
        data += chunk;
      });
      req.on("end", () => {
        if (exceeded) {
          reject(new Error("Payload Too Large"));
          return;
        }
        resolve(data);
      });
      req.on("error", reject);
    });
  }

  private authenticateRequest(req: http.IncomingMessage): string {
    const authHeader = req.headers["authorization"] || "";
    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid Bearer token");
    }
    const token = authHeader.slice(7).trim();
    const payload = this.auth.verifyToken(token);
    return payload.sub;
  }

  private getCorsOrigin(req: http.IncomingMessage): string {
    const origin = req.headers.origin;
    if (!origin) return "*";
    if (this.allowedOrigins.has(origin) || origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:")) {
      return origin;
    }
    return "null";
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown, origin = "*"): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, stripe-signature",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(data));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method?.toUpperCase();
    const corsOrigin = this.getCorsOrigin(req);
    const clientIp = req.socket.remoteAddress || "127.0.0.1";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type, stripe-signature",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    try {
      // 1. Health & Meta Endpoints
      if (url.pathname === "/health/live" && method === "GET") {
        this.sendJson(res, 200, { status: "ok", version: "0.2.0" }, corsOrigin);
        return;
      }

      if (url.pathname === "/health/ready" && method === "GET") {
        const hostedModels = this.firewallManager.listHostedModels();
        const availableFreeCount = hostedModels.filter((m) => m.isEligibleFree).length;
        const killSwitches = this.firewallManager.getKillSwitches();
        const hostedInferenceReady = killSwitches.hostedInferenceEnabled && availableFreeCount > 0;

        this.sendJson(
          res,
          200,
          {
            status: "ready",
            database: "connected",
            hostedInferenceReady,
            availableModelsCount: hostedModels.length,
            killSwitches,
          },
          corsOrigin,
        );
        return;
      }

      if (url.pathname === "/v1/meta" && method === "GET") {
        const hostedModels = this.firewallManager.listHostedModels();
        const availableFreeCount = hostedModels.filter((m) => m.isEligibleFree).length;
        this.sendJson(
          res,
          200,
          {
            apiVersion: "1.0.0",
            serverVersion: "0.2.0",
            hostedInferenceReady: availableFreeCount > 0,
            features: ["HOSTED_FREE", "STRIPE_BILLING", "DYNAMIC_MODELS"],
          },
          corsOrigin,
        );
        return;
      }

      if (url.pathname === "/v1/hosted/models" && method === "GET") {
        const models = this.firewallManager.listHostedModels();
        this.sendJson(res, 200, models, corsOrigin);
        return;
      }

      // Rate limit sensitive operations
      if (!this.checkRateLimit(clientIp)) {
        this.sendJson(res, 429, { error: "Too Many Requests. Rate limit exceeded." }, corsOrigin);
        return;
      }

      // 2. Auth Endpoints
      if (url.pathname === "/v1/auth/start" && method === "POST") {
        const body = await this.readJson(req, AuthStartSchema);
        const result = this.auth.startOAuth({
          redirectUri: body.redirectUri ?? "http://127.0.0.1:8765/auth/callback",
          deviceName: body.deviceName,
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/exchange" && method === "POST") {
        const body = await this.readJson(req, AuthExchangeSchema);
        const result = await this.auth.handleOAuthCallback({
          code: body.code,
          state: body.state,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
          deviceName: body.deviceName,
          ipAddress: clientIp,
          userAgent: req.headers["user-agent"],
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/refresh" && method === "POST") {
        const body = await this.readJson(req, AuthRefreshSchema);
        const result = this.auth.refreshSession({
          refreshToken: body.refreshToken,
          ipAddress: clientIp,
          userAgent: req.headers["user-agent"],
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/logout" && method === "POST") {
        const body = await this.readJson(req, AuthLogoutSchema);
        this.auth.logout(body.refreshToken);
        this.sendJson(res, 200, { ok: true }, corsOrigin);
        return;
      }

      // 3. Account Endpoints (Authenticated)
      if (url.pathname === "/v1/account" && method === "GET") {
        const userId = this.authenticateRequest(req);
        const account = this.auth.getAccount(userId);
        this.sendJson(res, 200, account, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/account/settings" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, AccountSettingsSchema);
        const updated = this.db.upsertAccountSettings({
          userId,
          ...body,
        });
        this.sendJson(res, 200, updated, corsOrigin);
        return;
      }

      // 4. Usage Endpoints (Authenticated)
      if (url.pathname === "/v1/usage" && method === "GET") {
        const userId = this.authenticateRequest(req);
        const summary = this.usage.getUserUsageSummary(userId);
        this.sendJson(res, 200, summary, corsOrigin);
        return;
      }

      // 5. Billing Endpoints
      if (url.pathname === "/v1/billing/checkout" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, BillingCheckoutSchema);
        const session = await this.billing.createCheckoutSession({
          userId,
          planId: body.planId,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
        });
        this.sendJson(res, 200, session, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/billing/portal" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, BillingPortalSchema);
        const session = await this.billing.createCustomerPortalSession({
          userId,
          returnUrl: body.returnUrl,
        });
        this.sendJson(res, 200, session, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/billing/webhook" && method === "POST") {
        const rawBody = await this.readRawBody(req);
        const sigHeader = (req.headers["stripe-signature"] as string) || "";
        const isValid = this.billing.verifyWebhookSignature(rawBody, sigHeader);
        if (!isValid) {
          this.sendJson(res, 400, { error: "Invalid Stripe webhook signature" }, corsOrigin);
          return;
        }
        const event = JSON.parse(rawBody);
        const result = this.billing.handleWebhookEvent(event);
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      // 6. Hosted Inference Endpoint (Authenticated & Streaming SSE)
      if (url.pathname === "/v1/hosted/inference" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, HostedInferenceSchema);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": corsOrigin,
          "X-Content-Type-Options": "nosniff",
        });

        const abortController = new AbortController();
        req.on("close", () => {
          if (!res.writableEnded) {
            abortController.abort(new Error("Client disconnected"));
          }
        });

        try {
          await this.gateway.executeHostedInference(
            userId,
            body as HostedInferenceRequest,
            (event: HostedStreamEvent) => {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            },
            abortController.signal,
          );
          if (!res.writableEnded) {
            res.end();
          }
        } catch {
          // Terminal error event is handled inside GatewayService
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      this.sendJson(res, 404, { error: "Endpoint not found" }, corsOrigin);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError = msg.includes("Bearer token") || msg.includes("JWT") || msg.includes("expired") || msg.includes("revoked");
      const isPayloadTooLarge = msg.includes("Payload Too Large");
      const status = isPayloadTooLarge ? 413 : isAuthError ? 401 : 400;

      // Error sanitization: ensure no internal secrets or full stack traces leak
      const sanitizedMsg = msg
        .replace(/sk_[a-zA-Z0-9_]+/g, "[REDACTED_STRIPE_KEY]")
        .replace(/ghp_[a-zA-Z0-9_]+/g, "[REDACTED_GITHUB_KEY]")
        .replace(/cfr_[a-zA-Z0-9_]+/g, "[REDACTED_REFRESH_TOKEN]");

      this.sendJson(res, status, { error: sanitizedMsg }, corsOrigin);
    }
  }
}
