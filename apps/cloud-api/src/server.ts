import http from "node:http";
import { URL } from "node:url";
import { isIP, type AddressInfo } from "node:net";
import { z } from "zod";
import { CloudDatabase, createCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { AuthService, GitHubAppAuthorizationService, GitHubAuthorizationError, type GitHubAppConfiguration } from "@codeforge/cloud-auth";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { StripeBillingService, type StripeConfig } from "@codeforge/cloud-billing";
import { CloudFirewallManager, GatewayService, type HostedInferenceRequest, type HostedStreamEvent, type CloudProviderRegistry, type CloudKillSwitchConfig } from "@codeforge/cloud-gateway";
import { PublicationService } from "./publication-service.js";
import { PublicationError, PUBLICATION_ERROR_CODES, publicationErrorStatus, isPublicationErrorCode } from "./publication-errors.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB max payload
const DEFAULT_BROWSER_RETURN_URLS = [
  "https://forgerdigitalsolutions.com/codeforge/sign-in",
  "https://forger-digital-solutions.github.io/codeforge/sign-in",
  "http://127.0.0.1:4321/codeforge/sign-in",
  "http://localhost:4321/codeforge/sign-in",
] as const;

// Boundary Zod Schemas
//
// The desktop supplies its own PKCE challenge here. There is deliberately no default redirectUri:
// a login attempt must name the exact loopback listener it opened, and that value is then validated
// against the loopback policy in @codeforge/cloud-auth before it is ever stored or redirected to.
const AuthStartSchema = z.object({
  redirectUri: z.string().url(),
  codeChallenge: z.string().min(43).max(128),
  deviceName: z.string().max(255).optional(),
});

// Exchange of the single-use desktop authorization code. `state` is accepted for client-side
// correlation but carries no authority — the code itself is the only thing the server trusts.
const AuthExchangeSchema = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
  state: z.string().min(1).optional(),
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
  // The client may select only an approved business identifier. Price IDs and redirect
  // destinations are server-owned billing configuration.
  planId: z.string().min(1).max(64),
});

const BillingPortalSchema = z.object({}).strict();

// CF-11B: GitHub App authorization + publication schemas.
const GitHubAppAuthCallbackSchema = z.object({
  state: z.string().min(16).max(512),
  installationId: z.number().int().positive(),
});

const SHA1 = z.string().regex(/^[0-9a-f]{40}$/);

const PublicationCreateSchema = z.object({
  deliveryId: z.string().min(1).max(200),
  repositoryId: z.number().int().positive(),
  targetBranch: z.string().min(1).max(200),
  baseSha: SHA1,
  targetSha: SHA1,
  certifiedHead: SHA1,
  certifiedTree: SHA1,
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // The service owns the canonical structured ARTIFACT_TOO_LARGE contract. Keeping the transport
  // schema numeric-only ensures oversized declarations reach that boundary instead of degrading
  // into a generic validation message.
  artifactBytes: z.number().int().positive(),
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
  databaseSsl?: boolean;
  driver?: "sqlite" | "postgres";
  jwtSecret?: string;
  gitHubClientId?: string;
  gitHubClientSecret?: string;
  /**
   * The deployment's public base URL. The GitHub OAuth callback is derived from it, so authentication
   * cannot start without it. Defaults to the loopback bind address for local development.
   */
  publicUrl?: string;
  /** Exact static-site URLs allowed as browser OAuth return targets. */
  allowedBrowserReturnUrls?: string[];
  /** Lifetime of the HttpOnly browser session cookie. */
  browserSessionExpiresInSeconds?: number;
  /**
   * Stripe TEST-mode configuration. Set this to null to explicitly disable billing, including in
   * local tests. Hosted Free stays independent of this integration.
   */
  stripeConfig?: StripeConfig | null;
  firewallManager?: CloudFirewallManager;
  /** Operator kill switches / spend limits applied when this server owns its firewall manager. */
  killSwitches?: Partial<CloudKillSwitchConfig>;
  /**
   * Real server-owned hosted capacity. When provided (and discoverOnStart is not false), the server
   * discovers verified-free models from configured providers at startup. Omit to run with no hosted
   * capacity (deterministic tests register models directly instead).
   */
  providerRegistry?: CloudProviderRegistry;
  /** Whether to run provider discovery during start(). Default true when a registry is provided. */
  discoverOnStart?: boolean;
  fetchFn?: typeof fetch;
  allowedOrigins?: string[];
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  /** Only honor proxy forwarding headers when an upstream proxy is explicitly trusted. */
  trustProxy?: boolean;
  /**
   * CF-11B: GitHub App configuration for publication authorization. The private key lives only in
   * this process; supplying it is what enables the publication routes at all.
   */
  gitHubAppConfig?: GitHubAppConfiguration;
  /** GitHub App installation/setup URL used to start repository authorization. */
  gitHubAppInstallationUrl?: string;
  /** Filesystem root for bounded publication artifact staging. */
  publicationArtifactDir?: string;
}

export class CodeForgeCloudServer {
  private readonly server: http.Server;
  public readonly db: ICloudDatabase;
  public readonly auth: AuthService;
  public readonly entitlements: EntitlementService;
  public readonly usage: UsageEngine;
  public readonly billing?: StripeBillingService;
  public readonly firewallManager: CloudFirewallManager;
  public readonly gateway: GatewayService;
  public readonly providerRegistry?: CloudProviderRegistry;
  public readonly gitHubAppAuth?: GitHubAppAuthorizationService;
  public readonly publicationService?: PublicationService;
  private readonly discoverOnStart: boolean;
  private readonly allowedOrigins: Set<string>;
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxRequestsPerMinute: number;
  private readonly trustProxy: boolean;
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

    const stripeConfig =
      config.stripeConfig === undefined
        ? isProduction && !process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET
          ? undefined
          : {
              secretKey: isProduction ? (process.env.STRIPE_SECRET_KEY as string) : "sk_test_mock_123",
              webhookSecret: isProduction ? (process.env.STRIPE_WEBHOOK_SECRET as string) : "whsec_mock_456",
              proPriceId: isProduction ? (process.env.STRIPE_PRO_PRICE_ID as string) : "price_pro_test",
              creditPackPriceId: isProduction ? (process.env.STRIPE_CREDIT_PRICE_ID as string) : "price_credits_test",
            }
        : config.stripeConfig;

    if (stripeConfig && (!stripeConfig.secretKey || !stripeConfig.webhookSecret)) {
      throw new Error("Stripe billing requires both test-mode credentials when configured.");
    }

    this.host = config.host ?? "127.0.0.1";
    this.allowedOrigins = new Set(
      config.allowedOrigins ?? [
        "http://127.0.0.1",
        "http://localhost",
        "https://codeforge.dev",
        "https://forgerdigitalsolutions.com",
        "https://forger-digital-solutions.github.io",
      ],
    );
    this.maxRequestsPerMinute = config.maxRequestsPerMinute ?? 120;
    this.trustProxy = config.trustProxy ?? false;

    if (config.db) {
      this.db = config.db;
    } else {
      this.db = createCloudDatabase({
        driver: config.driver,
        dbPath: config.dbPath,
        databaseUrl: config.databaseUrl,
        databaseSsl: config.databaseSsl,
      });
    }

    this.entitlements = new EntitlementService(this.db);
    this.usage = new UsageEngine(this.db);
    this.firewallManager = config.firewallManager ?? new CloudFirewallManager({ killSwitches: config.killSwitches });
    this.providerRegistry = config.providerRegistry;
    this.discoverOnStart = config.discoverOnStart ?? true;

    // Development default: the loopback origin this server is about to bind. Staging/production
    // always pass an explicit HTTPS origin from CODEFORGE_PUBLIC_URL (validated in config.ts).
    const publicUrl = config.publicUrl ?? (isProduction ? undefined : `http://127.0.0.1:${config.port ?? 3220}`);
    if (isProduction && !publicUrl) {
      throw new Error("Missing CODEFORGE_PUBLIC_URL for production cloud server.");
    }

    this.auth = new AuthService({
      db: this.db,
      jwtSecret,
      gitHubClientId,
      gitHubClientSecret: config.gitHubClientSecret,
      publicUrl,
      allowInsecurePublicUrl: !isProduction,
      allowedBrowserReturnUrls: config.allowedBrowserReturnUrls ?? DEFAULT_BROWSER_RETURN_URLS,
      browserSessionExpiresInSeconds: config.browserSessionExpiresInSeconds,
      fetchFn: config.fetchFn,
    });

    this.billing = stripeConfig ? new StripeBillingService(this.db, this.entitlements, stripeConfig) : undefined;

    this.gateway = new GatewayService({
      firewallManager: this.firewallManager,
      entitlementService: this.entitlements,
      usageEngine: this.usage,
      db: this.db,
      inferenceTimeoutMs: config.requestTimeoutMs,
    });

    // CF-11B: publication is available only when a Cloud-side GitHub App is configured. The App
    // private key never leaves this process, and no route below can mint a credential without it.
    if (config.gitHubAppConfig) {
      this.gitHubAppAuth = new GitHubAppAuthorizationService({
        db: this.db,
        appConfig: config.gitHubAppConfig,
        ...(config.gitHubAppInstallationUrl ? { installationUrl: config.gitHubAppInstallationUrl } : {}),
      });
      this.publicationService = new PublicationService({
        db: this.db,
        authorization: this.gitHubAppAuth,
        appConfig: config.gitHubAppConfig,
        ...(config.publicationArtifactDir ? { artifactStorageDir: config.publicationArtifactDir } : {}),
      });
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  get httpPort(): number {
    return this.actualPort;
  }

  async start(port = 0, host?: string): Promise<number> {
    const bindHost = host ?? this.host;
    // Fail closed: initialize the database schema (async for Postgres) BEFORE accepting traffic.
    await this.db.init();
    if (this.publicationService) {
      await this.publicationService.init();
      // Safe recovery is entirely durable and reacquires a new fenced lease before it can mutate a
      // remote. A newly restarted worker never trusts an in-memory checkpoint or persisted token.
      await this.publicationService.recoverAbandonedPublications().catch(() => undefined);
    }

    // Crash recovery: reclaim credits locked by reservations from a previous process that died
    // mid-inference. In-memory execution leases are already gone after a restart, so only persisted
    // reservations need reconciling.
    try {
      const recovered = await this.usage.reconcileStaleReservations();
      if (recovered.reconciled > 0) {
        console.log(`[CodeForge Cloud API] reclaimed ${recovered.reconciled} stale reservation(s), refunded ${recovered.refundedCredits} credits`);
      }
    } catch {
      // Non-fatal — never block boot on reconciliation.
    }

    // Discover real server-owned hosted capacity before serving. Non-fatal: a provider failure is
    // captured in the capacity report and the server still starts (Direct/BYOK stays independent).
    if (this.providerRegistry && this.discoverOnStart) {
      try {
        await this.providerRegistry.discover({ force: true });
      } catch {
        // Discovery never throws by contract; guard defensively so boot is deterministic.
      }
    }

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

  /**
   * Kick a TTL-guarded capacity refresh in the background. Non-blocking and error-swallowing so a
   * health/models poll never stalls on provider I/O; the registry itself enforces the refresh TTL,
   * so frequent polls do not hammer provider APIs.
   */
  private triggerLazyRefresh(): void {
    if (!this.providerRegistry) return;
    void this.providerRegistry.discover().catch(() => {});
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

  private getCookie(req: http.IncomingMessage, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const key = part.slice(0, separator).trim();
      if (key !== name) continue;
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
    return undefined;
  }

  private async authenticateBrowserOrBearerRequest(req: http.IncomingMessage): Promise<string> {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) return this.authenticateRequest(req);
    const token = this.getCookie(req, this.auth.getBrowserSessionCookieName());
    if (!token) throw new Error("Missing or invalid browser session");
    const user = await this.auth.authenticateBrowserSession(token);
    return user.id;
  }

  private sendRedirect(res: http.ServerResponse, location: string, setCookie?: string): void {
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      ...(setCookie ? { "Set-Cookie": setCookie } : {}),
    });
    res.end();
  }

  private browserSessionCookie(value: string, maxAge: number): string {
    const name = this.auth.getBrowserSessionCookieName();
    const secure = name.startsWith("__Host-") ? "; Secure" : "";
    return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  private browserSessionClearCookie(): string {
    return this.browserSessionCookie("", 0);
  }

  private getCorsOrigin(req: http.IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    if (!origin) return undefined;
    if (this.allowedOrigins.has(origin) || this.isDesktopLoopbackOrigin(origin)) {
      return origin;
    }
    return undefined;
  }

  private isDesktopLoopbackOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      return url.origin === origin && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Boolean(url.port);
    } catch {
      return false;
    }
  }

  private getClientIp(req: http.IncomingMessage): string {
    const socketIp = req.socket.remoteAddress || "127.0.0.1";
    if (!this.trustProxy) return socketIp;

    const forwarded = req.headers["x-forwarded-for"];
    const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    return firstForwarded && isIP(firstForwarded) !== 0 ? firstForwarded : socketIp;
  }

  private corsHeaders(origin?: string): Record<string, string> {
    if (!origin) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, stripe-signature",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    };
  }

  /**
   * Terminal browser page for a failed OAuth callback. Deliberately static: the message is a fixed
   * string, so nothing attacker-influenced is ever reflected into the response body.
   */
  private sendAuthErrorPage(res: http.ServerResponse, message: string): void {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>CodeForge Cloud</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;padding:2rem"><h2>CodeForge sign-in failed</h2><p style="color:#9ca3af">${message}</p><p style="color:#9ca3af">Return to CodeForge and try connecting again.</p></div></body></html>`;
    res.writeHead(400, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(body);
  }

  private requireGitHubAppAuth(res: http.ServerResponse, corsOrigin?: string): GitHubAppAuthorizationService | undefined {
    if (!this.gitHubAppAuth) {
      this.sendJson(res, 503, { error: "GitHub App authorization is not configured", code: "GITHUB_APP_NOT_CONFIGURED" }, corsOrigin);
      return undefined;
    }
    return this.gitHubAppAuth;
  }

  private requirePublicationService(res: http.ServerResponse, corsOrigin?: string): PublicationService | undefined {
    if (!this.publicationService) {
      this.sendJson(res, 503, { error: "Publication service is not configured", code: "PUBLICATION_NOT_CONFIGURED" }, corsOrigin);
      return undefined;
    }
    return this.publicationService;
  }

  /**
   * Publication failures are reported as a stable code only. Upstream GitHub bodies and Git
   * subprocess output are never reachable from here, so nothing sensitive can be reflected.
   */
  private sendPublicationError(res: http.ServerResponse, error: unknown, corsOrigin?: string): void {
    if (error instanceof PublicationError) {
      this.sendJson(res, publicationErrorStatus(error.code), { error: error.code, code: error.code, retryable: error.retryable }, corsOrigin);
      return;
    }
    if (error instanceof GitHubAuthorizationError) {
      const status = error.code === "GITHUB_TEMPORARY_FAILURE" ? 503 : error.code === "INSTALLATION_OWNED_BY_OTHER_USER" || error.code === "AUTHORIZATION_USER_MISMATCH" ? 403 : 400;
      this.sendJson(res, status, { error: error.code, code: error.code }, corsOrigin);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isPublicationErrorCode(message)) {
      this.sendJson(res, publicationErrorStatus(message), { error: message, code: message }, corsOrigin);
      return;
    }
    throw error;
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown, origin?: string, setCookie?: string): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      ...(setCookie ? { "Set-Cookie": setCookie } : {}),
      ...this.corsHeaders(origin),
    });
    res.end(JSON.stringify(data));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method?.toUpperCase();
    const corsOrigin = this.getCorsOrigin(req);
    const clientIp = this.getClientIp(req);

    // CORS preflight
    if (method === "OPTIONS") {
      if (req.headers.origin && !corsOrigin) {
        this.sendJson(res, 403, { error: "Origin is not allowed" });
        return;
      }
      res.writeHead(204, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...this.corsHeaders(corsOrigin),
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
        this.triggerLazyRefresh();
        const dbConnected = await this.db.ping();
        const hostedModels = this.firewallManager.listHostedModels();
        const availableFreeCount = hostedModels.filter((m) => m.isEligibleFree).length;
        const killSwitches = this.firewallManager.getKillSwitches();
        const hostedInferenceReady = dbConnected && killSwitches.hostedInferenceEnabled && availableFreeCount > 0;
        const providerCapacity = this.providerRegistry
          ? this.providerRegistry.getReports().map((r) => ({
              providerId: r.providerId,
              status: r.status,
              verifiedFreeCount: r.verifiedFreeCount,
            }))
          : undefined;

        const statusCode = dbConnected ? 200 : 503;
        this.sendJson(
          res,
          statusCode,
          {
            status: dbConnected ? "ready" : "not_ready",
            database: dbConnected ? "connected" : "disconnected",
            hostedInferenceReady,
            availableModelsCount: hostedModels.length,
            availableFreeCount,
            killSwitches,
            ...(providerCapacity ? { providerCapacity } : {}),
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
            features: ["HOSTED_FREE", "DYNAMIC_MODELS", ...(this.billing ? ["STRIPE_BILLING"] : [])],
          },
          corsOrigin,
        );
        return;
      }

      if (url.pathname === "/v1/hosted/models" && method === "GET") {
        this.triggerLazyRefresh();
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
        const result = await this.auth.startOAuth({
          redirectUri: body.redirectUri,
          codeChallenge: body.codeChallenge,
          deviceName: body.deviceName,
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/browser/start" && method === "GET") {
        const returnTarget = url.searchParams.get("return") ?? "";
        const result = await this.auth.startBrowserOAuth({ returnTarget });
        this.sendRedirect(res, result.authUrl);
        return;
      }

      // GitHub authorization-server callback. This is the ONE URL registered in the GitHub OAuth
      // App. It either redirects to the loopback URI recorded in a desktop transaction with a
      // single-use authorization code, or completes a browser transaction with an HttpOnly cookie.
      if (url.pathname === "/v1/auth/github/callback" && method === "GET") {
        const oauthError = url.searchParams.get("error");
        const state = url.searchParams.get("state") ?? "";
        const browserTransaction = state ? await this.auth.getBrowserOAuthTransaction(state) : undefined;
        if (oauthError) {
          if (browserTransaction) {
            try {
              this.sendRedirect(res, await this.auth.handleBrowserAuthorizationDenied(state));
            } catch {
              this.sendAuthErrorPage(res, "This CodeForge sign-in link is invalid or has already been used.");
            }
            return;
          }
          // Desktop failures have no validated browser destination, so keep the existing static
          // terminal page and preserve the loopback flow's authority boundary.
          this.sendAuthErrorPage(res, "GitHub authorization was not completed.");
          return;
        }

        if (browserTransaction) {
          try {
            const result = await this.auth.handleBrowserGitHubCallback({
              code: url.searchParams.get("code") ?? "",
              state,
            });
            const cookie = result.sessionCookie ? this.browserSessionCookie(result.sessionCookie.value, result.sessionCookie.maxAge) : undefined;
            this.sendRedirect(res, result.redirectTo, cookie);
          } catch {
            // A replayed/expired state is safely mapped back to the already-validated static-site
            // destination when possible. No request-supplied URL is ever reflected.
            try {
              const invalidRedirect = await this.auth.getBrowserAuthStatusRedirect(state, "invalid");
              this.sendRedirect(res, invalidRedirect);
            } catch {
              this.sendAuthErrorPage(res, "This CodeForge sign-in link is invalid or has already been used.");
            }
          }
          return;
        }

        try {
          const result = await this.auth.handleGitHubCallback({
            code: url.searchParams.get("code") ?? "",
            state,
          });
          // 302 to the server-validated loopback target. `Location` is derived entirely from the
          // stored transaction, so no request parameter can steer this redirect.
          this.sendRedirect(res, result.redirectTo);
        } catch {
          // Never echo the failure reason into a browser-rendered page: it is attacker-influenced
          // input and the detail is of no use to a legitimate user.
          this.sendAuthErrorPage(res, "This CodeForge sign-in link is invalid or has already been used.");
        }
        return;
      }

      if (url.pathname === "/v1/auth/session" && method === "GET") {
        const userId = await this.authenticateBrowserOrBearerRequest(req);
        const account = await this.auth.getAccount(userId);
        this.sendJson(res, 200, { user: account.user }, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/browser/logout" && method === "POST") {
        if (req.headers.origin && !corsOrigin) {
          this.sendJson(res, 403, { error: "Origin is not allowed" });
          return;
        }
        const token = this.getCookie(req, this.auth.getBrowserSessionCookieName());
        if (token) await this.auth.logoutBrowserSession(token);
        this.sendJson(res, 200, { ok: true }, corsOrigin, this.browserSessionClearCookie());
        return;
      }

      if (url.pathname === "/v1/auth/exchange" && method === "POST") {
        const body = await this.readJson(req, AuthExchangeSchema);
        const result = await this.auth.exchangeDesktopAuthCode({
          code: body.code,
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
        const result = await this.auth.refreshSession({
          refreshToken: body.refreshToken,
          ipAddress: clientIp,
          userAgent: req.headers["user-agent"],
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/auth/logout" && method === "POST") {
        const body = await this.readJson(req, AuthLogoutSchema);
        await this.auth.logout(body.refreshToken);
        this.sendJson(res, 200, { ok: true }, corsOrigin);
        return;
      }

      // 3. Account Endpoints (Authenticated)
      if (url.pathname === "/v1/account" && method === "GET") {
        const userId = await this.authenticateBrowserOrBearerRequest(req);
        const account = await this.auth.getAccount(userId);
        this.sendJson(res, 200, account, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/account/settings" && method === "POST") {
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, AccountSettingsSchema);
        const updated = await this.db.upsertAccountSettings({
          userId,
          ...body,
        });
        this.sendJson(res, 200, updated, corsOrigin);
        return;
      }

      // 4. Usage Endpoints (Authenticated)
      if (url.pathname === "/v1/usage" && method === "GET") {
        const userId = this.authenticateRequest(req);
        const summary = await this.usage.getUserUsageSummary(userId);
        this.sendJson(res, 200, summary, corsOrigin);
        return;
      }

      // 5. Billing Endpoints
      if (url.pathname === "/v1/billing/checkout" && method === "POST") {
        if (!this.billing) {
          this.sendJson(res, 503, { error: "Stripe billing is not configured for this deployment" }, corsOrigin);
          return;
        }
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, BillingCheckoutSchema);
        const session = await this.billing.createCheckoutSession({
          userId,
          planId: body.planId,
        });
        this.sendJson(res, 200, session, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/billing/portal" && method === "POST") {
        if (!this.billing) {
          this.sendJson(res, 503, { error: "Stripe billing is not configured for this deployment" }, corsOrigin);
          return;
        }
        const userId = this.authenticateRequest(req);
        await this.readJson(req, BillingPortalSchema);
        const session = await this.billing.createCustomerPortalSession({
          userId,
        });
        this.sendJson(res, 200, session, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/billing/webhook" && method === "POST") {
        if (!this.billing) {
          this.sendJson(res, 503, { error: "Stripe billing is not configured for this deployment" }, corsOrigin);
          return;
        }
        const rawBody = await this.readRawBody(req);
        const sigHeader = (req.headers["stripe-signature"] as string) || "";
        const isValid = this.billing.verifyWebhookSignature(rawBody, sigHeader);
        if (!isValid) {
          this.sendJson(res, 400, { error: "Invalid Stripe webhook signature" }, corsOrigin);
          return;
        }
        const event = JSON.parse(rawBody);
        const result = await this.billing.handleWebhookEvent(event);
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
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Accel-Buffering": "no",
          ...this.corsHeaders(corsOrigin),
        });
        res.flushHeaders();

        const abortController = new AbortController();
        // A client that goes away mid-stream must stop the upstream inference, or the Cloud keeps
        // paying a provider to generate tokens nobody will ever read.
        //
        // The signal has to come from the RESPONSE, not the request: by this point the request body
        // has been fully consumed, so `req` is already complete and its 'close' does not track the
        // client at all. `res` emits 'close' when the connection is terminated — including
        // prematurely — and `writableEnded` distinguishes "we finished" from "they left".
        const abortOnDisconnect = () => {
          if (!res.writableEnded) {
            abortController.abort(new Error("Client disconnected"));
          }
        };
        res.on("close", abortOnDisconnect);
        req.on("aborted", abortOnDisconnect);

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

      // 7. CF-11B: GitHub App repository authorization. Identity OAuth is unchanged and remains
      //    identity-only; write access is granted exclusively by installing the GitHub App.
      if (url.pathname === "/v1/github-app/authorizations/start" && method === "POST") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        this.sendJson(res, 200, await service.startAuthorization(userId), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/github-app/authorizations/callback" && method === "POST") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, GitHubAppAuthCallbackSchema);
        try {
          const result = await service.handleCallback({ state: body.state, installationId: body.installationId, expectedUserId: userId });
          this.sendJson(res, 200, {
            installation: { id: result.installation.id, installationId: result.installation.installationId, accountLogin: result.installation.accountLogin, accountType: result.installation.accountType, status: result.installation.status },
            repositories: result.repositories.map((item) => ({ repositoryId: item.repositoryId, fullName: item.fullName, private: item.private, authorizationState: item.authorizationState })),
          }, corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      if (url.pathname === "/v1/github-app/installations" && method === "GET") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        const installations = await service.listUserInstallations(userId);
        this.sendJson(res, 200, installations.map((item) => ({ id: item.id, installationId: item.installationId, accountLogin: item.accountLogin, accountType: item.accountType, status: item.status, repositorySelection: item.repositorySelection })), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/github-app/repositories" && method === "GET") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        const repositoryId = url.searchParams.get("repositoryId");
        if (repositoryId !== null) {
          const parsed = Number(repositoryId);
          if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            this.sendJson(res, 400, { error: PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED, code: PUBLICATION_ERROR_CODES.REPOSITORY_NOT_AUTHORIZED }, corsOrigin);
            return;
          }
          const view = await service.describeRepositoryAuthorization(userId, parsed);
          this.sendJson(res, 200, view ?? { repositoryId: parsed, authorized: false, authorizationState: "unknown" }, corsOrigin);
          return;
        }
        this.sendJson(res, 200, await service.listUserRepositoryAuthorizations(userId), corsOrigin);
        return;
      }

      // 8. CF-11B: publication lifecycle. Every route is authenticated and ownership-scoped.
      if (url.pathname === "/v1/publications" && method === "POST") {
        const service = this.requirePublicationService(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        const body = await this.readJson(req, PublicationCreateSchema);
        try {
          const publication = await service.createPublication(userId, body);
          this.sendJson(res, 201, await service.getStatus(userId, publication.id), corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      const artifactRoute = url.pathname.match(/^\/v1\/publications\/([^/]+)\/artifact$/);
      if (artifactRoute && method === "POST") {
        const service = this.requirePublicationService(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        try {
          // The body streams straight into bounded storage: bundle bytes never become a JSON
          // payload, are never logged, and never reach SQL.
          this.sendJson(res, 200, await service.uploadArtifact(userId, artifactRoute[1]!, req), corsOrigin);
        } catch (error) {
          req.resume();
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      const executeRoute = url.pathname.match(/^\/v1\/publications\/([^/]+)\/execute$/);
      if (executeRoute && method === "POST") {
        const service = this.requirePublicationService(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        try {
          this.sendJson(res, 200, await service.execute(userId, executeRoute[1]!), corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      const retryRoute = url.pathname.match(/^\/v1\/publications\/([^/]+)\/retry$/);
      if (retryRoute && method === "POST") {
        const service = this.requirePublicationService(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        try {
          this.sendJson(res, 200, await service.retry(userId, retryRoute[1]!), corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      const statusRoute = url.pathname.match(/^\/v1\/publications\/([^/]+)$/);
      if (statusRoute && method === "GET") {
        const service = this.requirePublicationService(res, corsOrigin);
        if (!service) return;
        const userId = this.authenticateRequest(req);
        try {
          this.sendJson(res, 200, await service.getStatus(userId, statusRoute[1]!), corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      this.sendJson(res, 404, { error: "Endpoint not found" }, corsOrigin);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError = msg.includes("Bearer token") || msg.includes("browser session") || msg.includes("JWT") || msg.includes("expired") || msg.includes("revoked");
      const isPayloadTooLarge = msg.includes("Payload Too Large");
      const status = isPayloadTooLarge ? 413 : isAuthError ? 401 : 400;

      // Error sanitization: ensure no internal secrets or full stack traces leak
      const sanitizedMsg = msg
        .replace(/sk_[a-zA-Z0-9_]+/g, "[REDACTED_STRIPE_KEY]")
        .replace(/ghp_[a-zA-Z0-9_]+/g, "[REDACTED_GITHUB_KEY]")
        .replace(/cfr_[a-zA-Z0-9_]+/g, "[REDACTED_REFRESH_TOKEN]");

      if (isAuthError) {
        this.sendJson(res, status, { error: sanitizedMsg, code: PUBLICATION_ERROR_CODES.UNAUTHENTICATED }, corsOrigin);
        return;
      }

      this.sendJson(res, status, { error: sanitizedMsg }, corsOrigin);
    }
  }
}
