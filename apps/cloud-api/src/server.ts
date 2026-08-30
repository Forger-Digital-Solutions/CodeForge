import http from "node:http";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import { CloudDatabase } from "@codeforge/cloud-db";
import { AuthService } from "@codeforge/cloud-auth";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { StripeBillingService, type StripeConfig } from "@codeforge/cloud-billing";
import { CloudFirewallManager, GatewayService, type HostedInferenceRequest, type HostedStreamEvent } from "@codeforge/cloud-gateway";

export interface CodeForgeCloudServerConfig {
  port?: number;
  dbPath?: string;
  jwtSecret?: string;
  gitHubClientId?: string;
  gitHubClientSecret?: string;
  stripeConfig?: StripeConfig;
  firewallManager?: CloudFirewallManager;
}

export class CodeForgeCloudServer {
  private readonly server: http.Server;
  public readonly db: CloudDatabase;
  public readonly auth: AuthService;
  public readonly entitlements: EntitlementService;
  public readonly usage: UsageEngine;
  public readonly billing: StripeBillingService;
  public readonly firewallManager: CloudFirewallManager;
  public readonly gateway: GatewayService;
  private actualPort = 0;

  constructor(config: CodeForgeCloudServerConfig = {}) {
    this.db = new CloudDatabase({ dbPath: config.dbPath ?? ":memory:" });
    this.entitlements = new EntitlementService(this.db);
    this.usage = new UsageEngine(this.db);
    this.firewallManager = config.firewallManager ?? new CloudFirewallManager();

    this.auth = new AuthService({
      db: this.db,
      jwtSecret: config.jwtSecret ?? "codeforge-cloud-test-jwt-secret-key-32chars",
      gitHubClientId: config.gitHubClientId ?? "gh_client_mock_123",
      gitHubClientSecret: config.gitHubClientSecret,
    });

    this.billing = new StripeBillingService(this.db, this.entitlements, config.stripeConfig ?? {
      secretKey: "sk_test_mock_123",
      webhookSecret: "whsec_mock_456",
      proPriceId: "price_pro_test",
      creditPackPriceId: "price_credits_test",
    });

    this.gateway = new GatewayService({
      firewallManager: this.firewallManager,
      entitlementService: this.entitlements,
      usageEngine: this.usage,
    });

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  get httpPort(): number {
    return this.actualPort;
  }

  async start(port = 0): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server.listen(port, "127.0.0.1", () => {
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
        this.db.close();
        resolve();
      });
    });
  }

  private async readJson<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private async readRawBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
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

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    res.end(JSON.stringify(data));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method?.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      });
      res.end();
      return;
    }

    try {
      // 1. Health Endpoints
      if (url.pathname === "/health/live" && method === "GET") {
        this.sendJson(res, 200, { status: "ok", version: "0.2.0" });
        return;
      }
      if (url.pathname === "/health/ready" && method === "GET") {
        this.sendJson(res, 200, {
          status: "ready",
          database: "connected",
          killSwitches: this.firewallManager.getKillSwitches(),
        });
        return;
      }

      // 2. Auth Endpoints
      if (url.pathname === "/v1/auth/start" && method === "POST") {
        const body = await this.readJson<{ redirectUri?: string; deviceName?: string }>(req);
        const result = this.auth.startOAuth({
          redirectUri: body.redirectUri ?? "http://127.0.0.1:8765/auth/callback",
          deviceName: body.deviceName,
        });
        this.sendJson(res, 200, result);
        return;
      }

      if (url.pathname === "/v1/auth/exchange" && method === "POST") {
        const body = await this.readJson<{
          code: string;
          state: string;
          expectedState: string;
          codeVerifier: string;
          redirectUri?: string;
          deviceName?: string;
          mockProfile?: any;
        }>(req);

        const result = await this.auth.handleOAuthCallback({
          code: body.code,
          state: body.state,
          expectedState: body.expectedState,
          codeVerifier: body.codeVerifier,
          redirectUri: body.redirectUri,
          deviceName: body.deviceName,
          ipAddress: req.socket.remoteAddress,
          userAgent: req.headers["user-agent"],
          mockProfile: body.mockProfile,
        });
        this.sendJson(res, 200, result);
        return;
      }

      if (url.pathname === "/v1/auth/refresh" && method === "POST") {
        const body = await this.readJson<{ refreshToken: string }>(req);
        const result = this.auth.refreshSession({
          refreshToken: body.refreshToken,
          ipAddress: req.socket.remoteAddress,
          userAgent: req.headers["user-agent"],
        });
        this.sendJson(res, 200, result);
        return;
      }

      if (url.pathname === "/v1/auth/logout" && method === "POST") {
        const body = await this.readJson<{ refreshToken: string }>(req);
        this.auth.logout(body.refreshToken);
        this.sendJson(res, 200, { ok: true });
        return;
      }

      // 3. Account Endpoints (Authenticated)
      if (url.pathname === "/v1/account" && method === "GET") {
        const userId = this.authenticateRequest(req);
        const account = this.auth.getAccount(userId);
        this.sendJson(res, 200, account);
        return;
      }

      if (url.pathname === "/v1/account/settings" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson<{ privacyMode?: "STRICT" | "STANDARD" | "MAXIMUM_FREE"; spendLimitUsd?: number }>(req);
        const updated = this.db.upsertAccountSettings({
          userId,
          ...body,
        });
        this.sendJson(res, 200, updated);
        return;
      }

      // 4. Usage Endpoints (Authenticated)
      if (url.pathname === "/v1/usage" && method === "GET") {
        const userId = this.authenticateRequest(req);
        const summary = this.usage.getUserUsageSummary(userId);
        this.sendJson(res, 200, summary);
        return;
      }

      // 5. Billing Endpoints
      if (url.pathname === "/v1/billing/checkout" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson<{ planId?: string; successUrl: string; cancelUrl: string }>(req);
        const user = this.db.getUserById(userId);
        const session = await this.billing.createCheckoutSession({
          userId,
          planId: body.planId,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
        });
        this.sendJson(res, 200, session);
        return;
      }

      if (url.pathname === "/v1/billing/portal" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson<{ returnUrl: string }>(req);
        const session = await this.billing.createCustomerPortalSession({
          userId,
          returnUrl: body.returnUrl,
        });
        this.sendJson(res, 200, session);
        return;
      }

      if (url.pathname === "/v1/billing/webhook" && method === "POST") {
        const rawBody = await this.readRawBody(req);
        const sigHeader = (req.headers["stripe-signature"] as string) || "";
        const isValid = this.billing.verifyWebhookSignature(rawBody, sigHeader);
        if (!isValid) {
          this.sendJson(res, 400, { error: "Invalid Stripe webhook signature" });
          return;
        }
        const event = JSON.parse(rawBody);
        const result = this.billing.handleWebhookEvent(event);
        this.sendJson(res, 200, result);
        return;
      }

      // 6. Hosted Inference Endpoint (Authenticated & Streaming SSE)
      if (url.pathname === "/v1/hosted/inference" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson<HostedInferenceRequest>(req);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        try {
          await this.gateway.executeHostedInference(userId, body, (event: HostedStreamEvent) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          });
          res.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.write(`data: ${JSON.stringify({ type: "turn.failed", turnId: body.turnId, error: msg })}\n\n`);
          res.end();
        }
        return;
      }

      this.sendJson(res, 404, { error: "Endpoint not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("Bearer token") || msg.includes("JWT") ? 401 : 400;
      this.sendJson(res, status, { error: msg });
    }
  }
}
