import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { isIP, type AddressInfo } from "node:net";
import { z } from "zod";
import { createCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { AuthService, GitHubAppAuthorizationService, GitHubAuthorizationError, GitHubWebhookError, GitHubWebhookService, type GitHubAppConfiguration } from "@codeforge/cloud-auth";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { StripeBillingService, type StripeConfig } from "@codeforge/cloud-billing";
import { CloudFirewallManager, GatewayService, HostedRuntime, type HostedInferenceRequest, type CloudProviderRegistry, type CloudKillSwitchConfig } from "@codeforge/cloud-gateway";
import type { HostedExecutionRecord } from "@codeforge/cloud-db";
import { REGION_UNKNOWN, classifyRegionEvidence, type RegionResolution } from "@codeforge/legal-policy";
import { deleteAccount } from "./account-deletion.js";
import { DesktopWorkerActionResultSchema } from "@codeforge/protocol";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { HostedWorkflowAuthority } from "./hosted-workflow-authority.js";
import { PublicationService } from "./publication-service.js";
import { PublicationError, PUBLICATION_ERROR_CODES, publicationErrorStatus, isPublicationErrorCode } from "./publication-errors.js";
import { LocalKeyEncryptionProvider, SecretEnvelopeService } from "@codeforge/crypto";
import { ConsoleSecurityAuditSink, SecurityAuditLog, createRedactingLogger, redactSecrets, type RedactingLogger, type SecurityAuditEvent, type SecurityAuditSink } from "@codeforge/secrets";
import { buildSecurityTxt } from "./security-txt.js";
import { isAllowedBillingReturnUrl } from "./billing-return-url.js";
import { RemoteDirectTransport, type RemoteDirectBinding, type RemoteDirectPrincipal } from "@codeforge/server";
import { ChatRequestSchema, type ChatRequest } from "@codeforge/providers";
import { handleRemoteDirectHttp } from "./remote-direct-http.js";
import { deploymentIdentity } from "./deployment-identity.js";
import { SponsorOperatorService, type SponsorOperatorPolicy } from "./sponsor-operator-service.js";
import { handleSponsorOperatorHttp } from "./sponsor-operator-http.js";

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

// A deliberate, hard-to-trigger-by-accident signal (R1 legal remediation spec §30 "recent-auth /
// confirmation safeguards") — this architecture has no password to re-prompt for, so an explicit
// literal string stands in for it, on top of requiring a live (short-lived) Bearer access token.
const AccountDeletionSchema = z.object({
  confirmation: z.literal("DELETE_MY_ACCOUNT"),
});

// Prices are chosen SERVER-side from the plan id; a client can never name a price, an amount, or a
// currency. Return URLs are further restricted to trusted origins (see billing-return-url.ts) so a
// Stripe-hosted page can never bounce a paying user to an attacker-chosen site.
const BillingCheckoutSchema = z.object({
  planId: z.enum(["pro", "credit_pack"]).optional(),
  successUrl: z.string().url().max(2048),
  cancelUrl: z.string().url().max(2048),
});

const BillingPortalSchema = z.object({
  returnUrl: z.string().url().max(2048),
});

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

const HostedToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const HostedToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.unknown()),
        required: z.array(z.string()).optional(),
      })
      .optional(),
  }),
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
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string(),
        name: z.string().optional(),
        toolCallId: z.string().optional(),
        toolCalls: z.array(HostedToolCallSchema).optional(),
      }),
    )
    .min(1),
  tools: z.array(HostedToolDefinitionSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  stop: z.array(z.string()).optional(),
});

const OpenAIChatCompletionsSchema = z.object({
  model: z.string().min(1).max(128),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    name: z.string().max(128).optional(),
    tool_call_id: z.string().max(256).optional(),
    tool_calls: z.array(z.object({
      id: z.string().max(256),
      type: z.literal("function"),
      function: z.object({ name: z.string().max(128), arguments: z.string().max(64 * 1024) }),
    })).optional(),
  })).min(1).max(256),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1).max(128),
      description: z.string().max(4096).optional(),
      parameters: z.object({ type: z.literal("object"), properties: z.record(z.unknown()), required: z.array(z.string()).optional() }).optional(),
    }),
  })).max(128).optional(),
  tool_choice: z.enum(["auto", "none", "required"]).optional(),
  stop: z.union([z.string(), z.array(z.string()).min(1).max(16)]).optional(),
}).strict();

function idempotentRequestId(userId: string, key: string | undefined): string {
  if (!key) return randomUUID();
  const hex = createHash("sha256").update(`${userId}\u0000${key}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const HostedWorkflowCreateSchema = z.object({
  workerId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  task: z.string().min(1).max(20_000),
  publicCodeConsent: z.boolean().optional(),
});

const WorkerIdSchema = z.string().min(1).max(128);

/** Public wire shape: lease tokens and request/result payloads are worker-internal or fetched via the result route, never exposed on status reads. */
function publicHostedExecution(execution: HostedExecutionRecord, created?: boolean): Record<string, unknown> {
  return {
    executionId: execution.id,
    status: execution.status,
    providerId: execution.providerId,
    modelId: execution.modelId,
    attempt: execution.attempt,
    cancellationRequested: execution.cancellationRequested,
    parentExecutionId: execution.parentExecutionId,
    rootExecutionId: execution.rootExecutionId,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    dispatchedAt: execution.dispatchedAt,
    terminalAt: execution.terminalAt,
    resultError: execution.resultError,
    ...(created !== undefined ? { created } : {}),
  };
}

function hostedAdmissionErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/capacity|queue full|saturat|worker unavailable/i.test(message)) return 503;
  if (/free allowance|monthly allowance|allowance exhausted|credit allowance/i.test(message)) return 429;
  if (/not permitted|insufficient|credits|concurrent task limit/i.test(message)) return 402;
  if (/disabled|spend limit|no verified free model|not currently available|not available under current provider policy|not permitted under your|could not resolve/i.test(message)) return 503;
  return 500;
}

function openAIError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /free allowance|monthly allowance|allowance exhausted/i.test(message)
    ? "FREE_ALLOWANCE_EXHAUSTED"
    : /capacity|queue full|saturat|worker unavailable/i.test(message)
      ? "CODEFORGE_CAPACITY_SATURATED"
      : /provider|backend|429|rate limit/i.test(message)
        ? "BACKEND_RATE_LIMITED"
        : "CODEFORGE_INFERENCE_ERROR";
  return { error: { message: message.slice(0, 512), type: code === "FREE_ALLOWANCE_EXHAUSTED" ? "quota_exceeded" : "server_error", code } };
}

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
  /** Name of a trusted-edge-set header carrying a two-letter country code (R1 spec §12). Unset by
   *  default — no region header is trusted, so region-restricted hosted routes fail closed. */
  trustedRegionHeaderName?: string;
  /**
   * CF-11B: GitHub App configuration for publication authorization. The private key lives only in
   * this process; supplying it is what enables the publication routes at all.
   */
  gitHubAppConfig?: GitHubAppConfiguration;
  /** GitHub App installation/setup URL used to start repository authorization. */
  gitHubAppInstallationUrl?: string;
  /**
   * X-Hub-Signature-256 shared secret for POST /v1/github-app/webhook. When absent the webhook
   * route returns 503 — unsigned deliveries are never processed.
   */
  gitHubAppWebhookSecret?: string;
  /** Filesystem root for bounded publication artifact staging. */
  publicationArtifactDir?: string;
  /** Shared durable runtime state. When omitted, the server creates and owns one. */
  sessionPersistence?: ISessionPersistence;
  /**
   * Envelope service for reversible secrets at rest. REQUIRED in production (the entrypoint builds
   * it from CODEFORGE_DATA_ENCRYPTION_KEYS); tests and development default to an ephemeral key.
   */
  secretEnvelope?: SecretEnvelopeService;
  /** Additional security audit sinks (a database sink is always attached). */
  securityAuditSinks?: SecurityAuditSink[];
  /** RFC 9116 security contact. When unset, /.well-known/security.txt is not served. */
  securityContact?: string;
  /**
   * Durable hosted execution worker tuning. The runtime is always composed — hosted inference is
   * admitted exclusively through the durable queue — but tests can tighten its timers.
   */
  hostedRuntime?: {
    leaseMs?: number;
    heartbeatMs?: number;
    idleWaitMs?: number;
    reconcileMs?: number;
    maxUserConcurrent?: number;
    defaultRouteCapacity?: number;
    maxConcurrentDispatches?: number;
  };
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
  remoteDirectAdmission?: (binding: RemoteDirectBinding, request: ChatRequest) => boolean | Promise<boolean>;
  remoteDirectSubmit?: (accountId: string, workflowId: string, request: ChatRequest, role: string) => Promise<string>;
  remoteDirectScopeAuthorization?: (principal: RemoteDirectPrincipal, scope: { deviceId: string; workspaceId: string }) => boolean | Promise<boolean>;
  sponsorOperatorPolicy?: SponsorOperatorPolicy;
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
  private readonly gitHubWebhook?: GitHubWebhookService;
  public readonly publicationService?: PublicationService;
  public readonly hostedWorkflowAuthority: HostedWorkflowAuthority;
  public readonly hostedRuntime: HostedRuntime;
  public readonly remoteDirectTransport: RemoteDirectTransport;
  private readonly deployment = deploymentIdentity(process.env);
  private readonly remoteDirectDispatchConfigured: boolean;
  private readonly remoteDirectSubmit?: CodeForgeCloudServerConfig["remoteDirectSubmit"];
  public readonly sponsorOperators?: SponsorOperatorService;
  public readonly sessionPersistence: ISessionPersistence;
  private readonly ownsSessionPersistence: boolean;
  private readonly discoverOnStart: boolean;
  private readonly allowedOrigins: Set<string>;
  private readonly rateLimits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxRequestsPerMinute: number;
  private readonly trustProxy: boolean;
  private readonly trustedRegionHeaderName?: string;
  private readonly requestTimeoutMs?: number;
  // Tracked so stop() can terminate abandoned long-lived SSE streams — an open poll loop would
  // otherwise keep server.close() (and the queue worker behind it) alive past the client's life.
  private readonly sockets = new Set<import("node:net").Socket>();
  private stopped = false;
  private actualPort = 0;
  private host: string;
  private readonly hstsEnabled: boolean;
  private readonly securityContact?: string;
  private readonly billingReturnOrigins: string[];
  public readonly securityAudit: SecurityAuditLog;
  public readonly logger: RedactingLogger;

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
    this.trustedRegionHeaderName = config.trustedRegionHeaderName;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.securityContact = config.securityContact;
    this.logger = createRedactingLogger({ name: "cloud-api", level: config.logLevel ?? (isProduction ? "info" : "debug") });

    if (isProduction && !config.secretEnvelope) {
      throw new Error("Missing secret envelope service for production cloud server (CODEFORGE_DATA_ENCRYPTION_KEYS).");
    }
    const secretEnvelope = config.secretEnvelope ?? new SecretEnvelopeService(LocalKeyEncryptionProvider.ephemeral());

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

    this.ownsSessionPersistence = config.sessionPersistence === undefined;
    this.sessionPersistence = config.sessionPersistence ?? createSessionPersistence({
      driver: config.driver,
      dbPath: config.dbPath,
      databaseUrl: config.databaseUrl,
      databaseSsl: config.databaseSsl,
    });
    this.hostedWorkflowAuthority = new HostedWorkflowAuthority(this.sessionPersistence);
    this.remoteDirectDispatchConfigured = config.remoteDirectAdmission !== undefined;
    this.remoteDirectSubmit = config.remoteDirectSubmit;
    if (config.sponsorOperatorPolicy) this.sponsorOperators = new SponsorOperatorService(this.sessionPersistence, secretEnvelope, config.sponsorOperatorPolicy);
    this.remoteDirectTransport = new RemoteDirectTransport({ persistence: this.sessionPersistence, envelope: secretEnvelope,
      admit: config.remoteDirectAdmission ?? (() => false), authorizeSessionScope: config.remoteDirectScopeAuthorization ?? (async (principal, scope) =>
        (await this.hostedWorkflowAuthority.list(principal.accountId)).some((workflow) => workflow.workerId === scope.deviceId
          && workflow.workspaceId === scope.workspaceId && ["active", "awaiting_worker"].includes(workflow.status))), sessionActive: async (principal) => {
        const session = await this.db.getDeviceSessionById(principal.authSessionId);
        return !!session && session.userId === principal.accountId && !session.revokedAt && Date.parse(session.expiresAt) > Date.now();
      } });

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

    this.hstsEnabled = Boolean(publicUrl?.startsWith("https:"));
    this.billingReturnOrigins = [
      ...this.allowedOrigins,
      ...(config.allowedBrowserReturnUrls ?? DEFAULT_BROWSER_RETURN_URLS).map((u) => { try { return new URL(u).origin; } catch { return ""; } }).filter(Boolean),
      ...(publicUrl ? [new URL(publicUrl).origin] : []),
    ];

    // Security audit trail: every event is persisted (append-only, account link severed on
    // deletion) and echoed as a redacted JSON line for platform log aggregation.
    const db = this.db;
    this.securityAudit = new SecurityAuditLog([
      { record: (event) => db.recordSecurityAuditEvent({ occurredAt: event.occurredAt, eventType: event.type, outcome: event.outcome, userId: event.userId, ipAddress: event.ipAddress, details: event.details }).then(() => undefined) },
      new ConsoleSecurityAuditSink((line) => this.logger.info(line)),
      ...(config.securityAuditSinks ?? []),
    ]);

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
      secretEnvelope,
      securityAudit: this.securityAudit,
    });

    this.billing = stripeConfig ? new StripeBillingService(this.db, this.entitlements, stripeConfig) : undefined;

    this.gateway = new GatewayService({
      firewallManager: this.firewallManager,
      entitlementService: this.entitlements,
      usageEngine: this.usage,
      db: this.db,
      inferenceTimeoutMs: config.requestTimeoutMs,
    });

    // Durable hosted execution: every /v1/hosted/inference request is persisted and admitted
    // through this authority; only the queue worker may dispatch a provider call.
    this.hostedRuntime = new HostedRuntime({
      db: this.db,
      gateway: this.gateway,
      leaseMs: config.hostedRuntime?.leaseMs,
      heartbeatMs: config.hostedRuntime?.heartbeatMs,
      idleWaitMs: config.hostedRuntime?.idleWaitMs,
      reconcileMs: config.hostedRuntime?.reconcileMs,
      maxUserConcurrent: config.hostedRuntime?.maxUserConcurrent,
      defaultRouteCapacity: config.hostedRuntime?.defaultRouteCapacity,
      maxConcurrentDispatches: config.hostedRuntime?.maxConcurrentDispatches,
      onError: (error) => this.logger.warn("hosted queue worker error", { error: error instanceof Error ? error.message : String(error) }),
    });

    // CF-11B: publication is available only when a Cloud-side GitHub App is configured. The App
    // private key never leaves this process, and no route below can mint a credential without it.
    if (config.gitHubAppConfig) {
      this.gitHubAppAuth = new GitHubAppAuthorizationService({
        db: this.db,
        appConfig: config.gitHubAppConfig,
        ...(config.gitHubAppInstallationUrl ? { installationUrl: config.gitHubAppInstallationUrl } : {}),
      });
      if (config.gitHubAppWebhookSecret) {
        this.gitHubWebhook = new GitHubWebhookService({
          db: this.db,
          webhookSecret: config.gitHubAppWebhookSecret,
          authorization: this.gitHubAppAuth,
        });
      }
      this.publicationService = new PublicationService({
        db: this.db,
        authorization: this.gitHubAppAuth,
        appConfig: config.gitHubAppConfig,
        ...(config.publicationArtifactDir ? { artifactStorageDir: config.publicationArtifactDir } : {}),
      });
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  get httpPort(): number {
    return this.actualPort;
  }

  async start(port = 0, host?: string): Promise<number> {
    const bindHost = host ?? this.host;
    // Fail closed: initialize the database schema (async for Postgres) BEFORE accepting traffic.
    await this.db.init();
    await this.hostedWorkflowAuthority.init();
    await this.sponsorOperators?.init();
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

    // Retention sweep (Security R1, Phase 31): expired/consumed short-lived auth artifacts and
    // terminal publication bundles are removed at boot and then hourly. Never fatal.
    await this.runRetentionSweep();
    this.retentionTimer = setInterval(() => void this.runRetentionSweep(), 60 * 60 * 1000);
    this.retentionTimer.unref();

    // Discover real server-owned hosted capacity before serving. Non-fatal: a provider failure is
    // captured in the capacity report and the server still starts (Direct/BYOK stays independent).
    if (this.providerRegistry && this.discoverOnStart) {
      try {
        await this.providerRegistry.discover({ force: true });
      } catch {
        // Discovery never throws by contract; guard defensively so boot is deterministic.
      }
    }

    await this.hostedRuntime.syncProviderCapacity();

    // Durable hosted queue worker: starts only after schema init, crash recovery, and provider
    // discovery so the first claim pass observes a consistent ledger and a populated catalog.
    this.hostedRuntime.start();

    return new Promise<number>((resolve, reject) => {
      this.server.listen(port, bindHost, () => {
        const addr = this.server.address() as AddressInfo;
        this.actualPort = addr.port;
        resolve(this.actualPort);
      });
      this.server.on("error", reject);
    });
  }

  /** Revoked sessions are kept this long so a replayed rotated refresh token is still recognised as a breach. */
  private static readonly REVOKED_SESSION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
  private retentionTimer?: NodeJS.Timeout;

  async runRetentionSweep(): Promise<Record<string, number>> {
    const now = new Date();
    const counts: Record<string, number> = {};
    try {
      Object.assign(counts, await this.db.purgeExpiredSecurityArtifacts({
        nowIso: now.toISOString(),
        revokedSessionCutoffIso: new Date(now.getTime() - CodeForgeCloudServer.REVOKED_SESSION_GRACE_MS).toISOString(),
      }));
      if (this.publicationService) counts.publication_artifacts = await this.publicationService.sweepTerminalArtifacts();
      const removed = Object.values(counts).reduce((a, b) => a + b, 0);
      if (removed > 0) this.logger.info("retention sweep", counts);
    } catch (error) {
      this.logger.warn("retention sweep failed", { error });
    }
    return counts;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    // Terminate every open socket before close(): an abandoned durable SSE stream polls until the
    // request deadline, which would otherwise hold close() — and the queue worker behind it —
    // open past the caller's lifetime.
    this.server.closeIdleConnections();
    for (const socket of this.sockets) socket.destroy();
    return new Promise<void>((resolve, reject) => {
      this.server.close(() => {
        // Stop the queue worker (aborts local in-flight dispatch) BEFORE closing the durable
        // store so a terminalizing write never races a closed pool.
        const closeOperations: Promise<unknown>[] = [this.hostedRuntime.stop().then(() => this.db.close())];
        closeOperations.push((async () => { await this.sponsorOperators?.stop(); if (this.ownsSessionPersistence) await this.sessionPersistence.close(); })());
        void Promise.all(closeOperations).then(() => resolve(), reject);
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

  private async authenticateRequest(req: http.IncomingMessage): Promise<string> {
    const authHeader = req.headers["authorization"] || "";
    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid Bearer token");
    }
    const token = authHeader.slice(7).trim();
    if (token.length === 0 || token.length > 4096) throw new Error("Missing or invalid Bearer token");
    // Signature + expiry + live-session check: a token whose session was logged out or revoked is
    // refused even though its signature is still valid (see AuthService.verifyAccessSession).
    const payload = await this.auth.verifyAccessSession(token);
    return payload.sub;
  }

  private async remoteDirectPrincipal(req: http.IncomingMessage): Promise<RemoteDirectPrincipal> {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || header.length > 4103) throw new Error("Missing or invalid Bearer token");
    const payload = await this.auth.verifyAccessSession(header.slice(7).trim());
    const session = await this.db.getDeviceSessionById(payload.sid);
    if (!session || session.userId !== payload.sub || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) throw new Error("Session has been revoked or has expired");
    return { accountId: payload.sub, authSessionId: payload.sid };
  }

  private audit(event: SecurityAuditEvent): void {
    this.securityAudit.emit(event);
  }

  /** Headers applied to every response that carries data. */
  private securityHeaders(): Record<string, string> {
    return {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      ...(this.hstsEnabled ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    };
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
    if (authHeader.startsWith("Bearer ")) return await this.authenticateRequest(req);
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
      ...this.securityHeaders(),
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

  /**
   * Region evidence for provider-policy decisions. Deliberately narrower than getClientIp()'s
   * trustProxy gate: a raw IP is merely convenience-degraded by trusting the wrong proxy, but a
   * spoofed COUNTRY can silently defeat a legal region restriction, so this requires its own
   * explicit header name (trustedRegionHeaderName) rather than reusing trustProxy/X-Forwarded-For.
   * With no header configured (the default), every region-restricted hosted route fails closed.
   */
  private resolveRegionEvidence(req: http.IncomingMessage): RegionResolution {
    if (!this.trustedRegionHeaderName) return REGION_UNKNOWN;
    const raw = req.headers[this.trustedRegionHeaderName.toLowerCase()];
    const countryCode = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
    return classifyRegionEvidence({ countryCode, source: "TRUSTED_EDGE_HEADER", observedAt: new Date().toISOString() });
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
      ...this.securityHeaders(),
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
      ...this.securityHeaders(),
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
        ...this.securityHeaders(),
        ...this.corsHeaders(corsOrigin),
      });
      res.end();
      return;
    }

    try {
      // 0. RFC 9116 security.txt — served only when an operator configured a real contact.
      if ((url.pathname === "/.well-known/security.txt" || url.pathname === "/security.txt") && method === "GET") {
        const body = this.securityContact ? buildSecurityTxt({ contact: this.securityContact, canonicalBase: this.auth.publicBaseUrl }) : undefined;
        if (!body) {
          this.sendJson(res, 404, { error: "security.txt is not published for this deployment" }, corsOrigin);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", ...this.securityHeaders() });
        res.end(body);
        return;
      }

      // 1. Health & Meta Endpoints
      if (url.pathname === "/health/live" && method === "GET") {
        this.sendJson(res, 200, { status: "ok", version: "0.4.0", deployment: this.deployment,
          remoteDirect: { transportAvailable: true, dispatchConfigured: this.remoteDirectDispatchConfigured } }, corsOrigin);
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
            serverVersion: "0.4.0",
            hostedInferenceReady: availableFreeCount > 0,
            features: ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS", "OPENAI_CHAT_COMPLETIONS", ...(this.billing ? ["STRIPE_BILLING"] : [])],
          },
          corsOrigin,
        );
        return;
      }

      if (url.pathname === "/v1/hosted/models" && method === "GET") {
        this.triggerLazyRefresh();
        const eligible = this.firewallManager.listHostedModels().filter((model) => model.isEligibleFree && model.accessClass === "free");
        const available = eligible.length > 0;
        const capabilities = eligible.reduce<Record<string, boolean>>((result, model) => {
          for (const [key, enabled] of Object.entries(model.capabilities)) result[key] = (result[key] ?? false) || enabled;
          return result;
        }, { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: false, longContext: false });
        this.sendJson(res, 200, available ? [{
          providerId: "codeforge-cloud",
          modelId: "codeforge/forgeauto-free",
          displayName: "ForgeAuto Free",
          availability: "available",
          capabilities,
          contextWindow: Math.min(...eligible.map((model) => model.contextWindow)),
          accessClass: "free",
          isEligibleFree: true,
        }] : [], corsOrigin);
        return;
      }

      if (url.pathname === "/v1/models" && method === "GET") {
        await this.authenticateRequest(req);
        const available = this.firewallManager.listHostedModels().some((model) => model.isEligibleFree);
        this.sendJson(res, 200, {
          object: "list",
          data: available ? [{ id: "codeforge/forgeauto-free", object: "model", created: 0, owned_by: "codeforge" }] : [],
        }, corsOrigin);
        return;
      }

      // Rate limit sensitive operations
      if (!this.checkRateLimit(clientIp)) {
        this.audit({ type: "ratelimit.exceeded", outcome: "denied", ipAddress: clientIp, details: { path: url.pathname } });
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
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, AccountSettingsSchema);
        const updated = await this.db.upsertAccountSettings({
          userId,
          ...body,
        });
        this.audit({ type: "account.settings.changed", outcome: "success", userId, ipAddress: clientIp, details: { fields: Object.keys(body).join(",") } });
        this.sendJson(res, 200, updated, corsOrigin);
        return;
      }

      // GDPR Article 17 erasure (LEG-P0-02). userId comes ONLY from the verified Bearer token —
      // never from the request body/URL — so there is no parameter an attacker could substitute to
      // delete a different account (confused-deputy / arbitrary-user-ID deletion is structurally
      // impossible here, not just validated against). Bearer-only (not the cookie-accepting
      // authenticateBrowserOrBearerRequest) so this can never be triggered by a bare cross-site
      // request. Idempotent: see deleteAccount()/ICloudDatabase.deleteUserAccount() doc comments —
      // a retried call after an ambiguous network failure is safe.
      if (url.pathname === "/v1/account" && method === "DELETE") {
        const userId = await this.authenticateRequest(req);
        await this.readJson(req, AccountDeletionSchema);
        const receipt = await deleteAccount({
          db: this.db,
          sessionPersistence: this.sessionPersistence,
          hostedWorkflowAuthority: this.hostedWorkflowAuthority,
          ...(this.publicationService ? { publicationService: this.publicationService } : {}),
          userId,
        });
        // Every live access token of the deleted account stops working immediately, not at expiry.
        this.auth.forgetSessionsOf(userId);
        this.audit({ type: "account.deleted", outcome: "success", userId, ipAddress: clientIp, details: { sessionsDeleted: receipt.sessionsDeleted, artifactsPurged: receipt.artifactsPurged } });
        this.sendJson(res, 200, receipt, corsOrigin);
        return;
      }

      // 4. Usage Endpoints (Authenticated)
      if (url.pathname === "/v1/usage" && method === "GET") {
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, BillingCheckoutSchema);
        if (!isAllowedBillingReturnUrl(body.successUrl, this.billingReturnOrigins) || !isAllowedBillingReturnUrl(body.cancelUrl, this.billingReturnOrigins)) {
          this.audit({ type: "request.rejected", outcome: "denied", userId, ipAddress: clientIp, details: { reason: "billing_return_url_not_allowed" } });
          this.sendJson(res, 400, { error: "Checkout return URLs must point at a trusted CodeForge origin", code: "BILLING_RETURN_URL_NOT_ALLOWED" }, corsOrigin);
          return;
        }
        const session = await this.billing.createCheckoutSession({
          userId,
          planId: body.planId,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
        });
        this.audit({ type: "billing.checkout.started", outcome: "success", userId, ipAddress: clientIp, details: { planId: body.planId ?? "pro" } });
        this.sendJson(res, 200, session, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/billing/portal" && method === "POST") {
        if (!this.billing) {
          this.sendJson(res, 503, { error: "Stripe billing is not configured for this deployment" }, corsOrigin);
          return;
        }
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, BillingPortalSchema);
        if (!isAllowedBillingReturnUrl(body.returnUrl, this.billingReturnOrigins)) {
          this.audit({ type: "request.rejected", outcome: "denied", userId, ipAddress: clientIp, details: { reason: "billing_return_url_not_allowed" } });
          this.sendJson(res, 400, { error: "Portal return URL must point at a trusted CodeForge origin", code: "BILLING_RETURN_URL_NOT_ALLOWED" }, corsOrigin);
          return;
        }
        const session = await this.billing.createCustomerPortalSession({
          userId,
          returnUrl: body.returnUrl,
        });
        this.audit({ type: "billing.portal.opened", outcome: "success", userId, ipAddress: clientIp });
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
          this.audit({ type: "billing.webhook.signature_invalid", outcome: "denied", ipAddress: clientIp });
          this.sendJson(res, 400, { error: "Invalid Stripe webhook signature" }, corsOrigin);
          return;
        }
        let event: unknown;
        try {
          event = JSON.parse(rawBody);
        } catch {
          this.audit({ type: "billing.webhook.rejected", outcome: "failure", ipAddress: clientIp, details: { reason: "invalid_json" } });
          this.sendJson(res, 400, { error: "Invalid webhook payload" }, corsOrigin);
          return;
        }
        const result = await this.billing.handleWebhookEvent(event as Parameters<StripeBillingService["handleWebhookEvent"]>[0]);
        this.audit({
          type: result.action === "duplicate_skipped" ? "billing.webhook.duplicate" : result.action === "ignored" || result.action.startsWith("rejected") ? "billing.webhook.rejected" : "billing.webhook.processed",
          outcome: result.action.startsWith("rejected") ? "denied" : "info",
          ipAddress: clientIp,
          details: { action: result.action, eventType: String((event as { type?: unknown }).type ?? "unknown") },
        });
        this.sendJson(res, 200, result, corsOrigin);
        return;
      }


      // 6. Durable Hosted Execution Endpoints (Authenticated)
      //
      // POST /v1/hosted/inference persists the request and admits it through the certified
      // capacity/fairness authority — it never calls a provider inline. The queue worker owns
      // dispatch. requestId is the idempotency key: a retried submit after a lost response
      // returns the same execution. Two wire modes:
      //   - Accept: application/json → async handle (202/200 { executionId, status, created });
      //     the owner polls status/result and may cancel via the executions routes below.
      //   - default (SSE) → the handler durably enqueues and streams persisted provider deltas as
      //     they arrive. Client disconnect cancels the execution, matching the inline-stream contract.
      if (url.pathname === "/v1/chat/completions" && method === "POST") {
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, OpenAIChatCompletionsSchema);
        const publicModelId = "codeforge/forgeauto-free";
        if (![publicModelId, "codeforge-auto", "auto"].includes(body.model)) {
          this.sendJson(res, 404, { error: { message: "Only the logical model codeforge/forgeauto-free is available on the Free gateway", type: "invalid_request_error", code: "MODEL_NOT_FOUND" } }, corsOrigin);
          return;
        }
        if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined && body.max_tokens !== body.max_completion_tokens) {
          this.sendJson(res, 400, { error: { message: "max_tokens and max_completion_tokens must match when both are supplied", type: "invalid_request_error", code: "INVALID_TOKEN_LIMIT" } }, corsOrigin);
          return;
        }
        const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 2000;
        if (maxTokens > 8000) {
          this.sendJson(res, 400, { error: { message: "max completion tokens exceeds the CodeForge hosted limit of 8,000", type: "invalid_request_error", code: "OUTPUT_LIMIT_EXCEEDED" } }, corsOrigin);
          return;
        }
        const idempotencyHeader = req.headers["idempotency-key"];
        const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
        if (idempotencyKey && (idempotencyKey.length > 200 || idempotencyKey.trim().length === 0)) {
          this.sendJson(res, 400, { error: { message: "Idempotency-Key must contain 1 to 200 non-whitespace characters", type: "invalid_request_error", code: "INVALID_IDEMPOTENCY_KEY" } }, corsOrigin);
          return;
        }
        const requestId = idempotentRequestId(userId, idempotencyKey);
        const request: HostedInferenceRequest = {
          requestId,
          modelId: "auto",
          taskType: "coding",
          privacyMode: (await this.db.getAccountSettings(userId)).privacyMode,
          estimatedContextTokens: Math.max(1, Math.ceil(body.messages.reduce((total, message) => total + message.content.length, 0) / 4)),
          messages: body.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
            ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
            ...(message.tool_calls ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, type: call.type, function: call.function })) } : {}),
          })),
          ...(body.tools?.length ? { tools: body.tools.map((tool) => ({ type: "function" as const, function: { name: tool.function.name, description: tool.function.description ?? "", ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}) } })) } : {}),
          maxTokens,
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.tool_choice ? { toolChoice: body.tool_choice } : {}),
          ...(body.stop ? { stop: typeof body.stop === "string" ? [body.stop] : body.stop } : {}),
        };

        let admission: { execution: HostedExecutionRecord; created: boolean };
        try {
          admission = await this.hostedRuntime.enqueue(userId, request, this.resolveRegionEvidence(req));
        } catch (error) {
          this.sendJson(res, hostedAdmissionErrorStatus(error), openAIError(error), corsOrigin);
          return;
        }

        const { execution } = admission;
        const isStreaming = body.stream === true;
        let clientGone = false;
        const onDisconnect = () => { if (!res.writableEnded) clientGone = true; };
        if (isStreaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Content-Type-Options": "nosniff",
            "X-Accel-Buffering": "no",
            ...this.corsHeaders(corsOrigin),
          });
          res.flushHeaders();
        }
        res.on("close", onDisconnect);
        req.on("aborted", onDisconnect);

        const created = Math.floor(Date.now() / 1000);
        const chunk = (choices: unknown[], usage?: unknown) => ({
          id: `chatcmpl-${execution.id}`,
          object: "chat.completion.chunk",
          created,
          model: publicModelId,
          choices,
          ...(usage ? { usage } : {}),
        });
        const writeChunk = (choices: unknown[], usage?: unknown) => {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify(chunk(choices, usage))}\n\n`);
        };

        let cursor = 0;
        let sentEventCount = 0;
        const toolCallIndices = new Map<string, number>();
        let finishReason: "stop" | "tool_calls" | "length" = "stop";
        const deadline = Date.now() + (this.requestTimeoutMs ?? 120_000);
        let current: HostedExecutionRecord | undefined;
        while (!clientGone && Date.now() < deadline) {
          const deltas = await this.hostedRuntime.streamEvents(execution.id, userId, cursor).catch(() => []);
          for (const item of deltas) {
            cursor = item.sequence;
            sentEventCount++;
            const event = item.event;
            if (!isStreaming) continue;
            if (event.type === "assistant.message.delta") {
              writeChunk([{ index: 0, delta: { content: event.delta }, finish_reason: null }]);
            } else if (event.type === "assistant.tool_call.started") {
              const index = toolCallIndices.size;
              toolCallIndices.set(event.toolCallId, index);
              writeChunk([{ index: 0, delta: { tool_calls: [{ index, id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: "" } }] }, finish_reason: null }]);
            } else if (event.type === "assistant.tool_call.delta") {
              const index = toolCallIndices.get(event.toolCallId);
              if (index !== undefined) writeChunk([{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] }, finish_reason: null }]);
            } else if (event.type === "assistant.message.completed") {
              finishReason = event.finishReason === "tool_calls" ? "tool_calls" : event.finishReason;
              writeChunk([{ index: 0, delta: {}, finish_reason: finishReason }]);
              if (body.stream_options?.include_usage) {
                writeChunk([], { prompt_tokens: event.usage.inputTokens, completion_tokens: event.usage.outputTokens, total_tokens: event.usage.inputTokens + event.usage.outputTokens });
              }
            } else if (event.type === "turn.failed") {
              if (!res.writableEnded) res.write(`data: ${JSON.stringify(openAIError(new Error(event.error)))}\n\n`);
            }
          }
          current = await this.hostedRuntime.status(execution.id, userId).catch(() => undefined);
          if (!current || ["completed", "failed", "cancelled"].includes(current.status)) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 75));
        }

        if (clientGone) {
          await this.hostedRuntime.cancel(execution.id, userId).catch(() => undefined);
          if (!res.writableEnded) res.end();
          return;
        }
        const trailing = await this.hostedRuntime.streamEvents(execution.id, userId, cursor).catch(() => []);
        for (const item of trailing) {
          cursor = item.sequence;
          sentEventCount++;
          const event = item.event;
          if (!isStreaming) continue;
          if (event.type === "assistant.message.delta") writeChunk([{ index: 0, delta: { content: event.delta }, finish_reason: null }]);
          else if (event.type === "assistant.tool_call.started") {
            const index = toolCallIndices.size;
            toolCallIndices.set(event.toolCallId, index);
            writeChunk([{ index: 0, delta: { tool_calls: [{ index, id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: "" } }] }, finish_reason: null }]);
          } else if (event.type === "assistant.tool_call.delta") {
            const index = toolCallIndices.get(event.toolCallId);
            if (index !== undefined) writeChunk([{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] }, finish_reason: null }]);
          } else if (event.type === "assistant.message.completed") {
            finishReason = event.finishReason === "tool_calls" ? "tool_calls" : event.finishReason;
            writeChunk([{ index: 0, delta: {}, finish_reason: finishReason }]);
            if (body.stream_options?.include_usage) writeChunk([], { prompt_tokens: event.usage.inputTokens, completion_tokens: event.usage.outputTokens, total_tokens: event.usage.inputTokens + event.usage.outputTokens });
          } else if (event.type === "turn.failed" && !res.writableEnded) res.write(`data: ${JSON.stringify(openAIError(new Error(event.error)))}\n\n`);
        }
        const found = await this.hostedRuntime.result(execution.id, userId).catch(() => undefined);
        current = found?.execution ?? current;
        if (isStreaming) {
          if (current?.status !== "completed" && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(openAIError(new Error(current?.resultError ?? "CodeForge inference did not complete")))}\n\n`);
          }
          if (!res.writableEnded) {
            res.write("data: [DONE]\n\n");
            res.end();
          }
          return;
        }
        if (!current || current.status !== "completed" || !found?.result?.outcome) {
          this.sendJson(res, current?.status === "failed" ? 502 : 504, openAIError(new Error(current?.resultError ?? "CodeForge inference did not complete")), corsOrigin);
          return;
        }
        const outcome = found.result.outcome;
        const toolCalls = (found.result.events ?? []).filter((event) => event.type === "assistant.tool_call.completed").map((event) => event.type === "assistant.tool_call.completed" ? ({ id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: event.arguments } }) : null).filter(Boolean);
        this.sendJson(res, 200, {
          id: `chatcmpl-${execution.id}`,
          object: "chat.completion",
          created,
          model: publicModelId,
          choices: [{ index: 0, message: { role: "assistant", content: toolCalls.length ? null : outcome.fullText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: outcome.finishReason }],
          usage: { prompt_tokens: outcome.usage.inputTokens, completion_tokens: outcome.usage.outputTokens, total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens },
        }, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/hosted/inference" && method === "POST") {
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, HostedInferenceSchema);
        const wantsJson = (req.headers.accept ?? "").includes("application/json") && !(req.headers.accept ?? "").includes("text/event-stream");

        let admission: { execution: HostedExecutionRecord; created: boolean };
        try {
          admission = await this.hostedRuntime.enqueue(userId, body as HostedInferenceRequest, this.resolveRegionEvidence(req));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Hosted execution admission failed";
          this.audit({ type: "hosted.execution.enqueued", outcome: "denied", userId, ipAddress: clientIp, details: { reason: message } });
          if (wantsJson) {
            this.sendJson(res, hostedAdmissionErrorStatus(error), { error: message }, corsOrigin);
          } else {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Accel-Buffering": "no", ...this.corsHeaders(corsOrigin) });
            res.write(`data: ${JSON.stringify({ type: "turn.failed", turnId: body.turnId ?? body.requestId, error: message })}\n\n`);
            res.end();
          }
          return;
        }

        const { execution, created } = admission;
        this.audit({ type: "hosted.execution.enqueued", outcome: "success", userId, ipAddress: clientIp, details: { executionId: execution.id, created } });

        if (wantsJson) {
          this.sendJson(res, created ? 202 : 200, publicHostedExecution(execution, created), corsOrigin);
          return;
        }

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
        res.write(`data: ${JSON.stringify({ type: "execution.enqueued", executionId: execution.id, status: execution.status })}\n\n`);

        // A client that goes away mid-stream must stop the upstream inference, or the Cloud keeps
        // paying a provider to generate tokens nobody will ever read. The signal has to come from
        // the RESPONSE, not the request: by this point the request body has been fully consumed,
        // so `req` is already complete and its 'close' does not track the client at all.
        let clientGone = false;
        let sentEventCount = 0;
        let streamCursor = 0;
        const onDisconnect = () => {
          if (!res.writableEnded) clientGone = true;
        };
        res.on("close", onDisconnect);
        req.on("aborted", onDisconnect);

        const deadline = Date.now() + (this.requestTimeoutMs ?? 120_000);
        while (!clientGone && Date.now() < deadline) {
          const deltas = await this.hostedRuntime.streamEvents(execution.id, userId, streamCursor).catch(() => []);
          for (const item of deltas) {
            streamCursor = item.sequence;
            sentEventCount++;
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(item.event)}\n\n`);
          }
          const current = await this.hostedRuntime.status(execution.id, userId).catch(() => undefined);
          if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") break;
          await new Promise<void>((resolve) => setTimeout(resolve, 75));
        }

        if (clientGone) {
          await this.hostedRuntime.cancel(execution.id, userId).catch(() => undefined);
          if (!res.writableEnded) res.end();
          return;
        }

        const finalDeltas = await this.hostedRuntime.streamEvents(execution.id, userId, streamCursor).catch(() => []);
        for (const item of finalDeltas) {
          streamCursor = item.sequence;
          sentEventCount++;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(item.event)}\n\n`);
        }
        const found = await this.hostedRuntime.result(execution.id, userId).catch(() => undefined);
        const replay = found?.result?.events ?? [];
        // Older executions may have only the terminal result payload. If a persistence outage
        // interrupted delta writes, replay only the unsent suffix after the worker has finished.
        for (const event of replay.slice(sentEventCount)) if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (!res.writableEnded) {
          if (!found || !["completed", "failed", "cancelled"].includes(found.execution.status)) {
            res.write(`data: ${JSON.stringify({ type: "turn.failed", turnId: body.turnId ?? body.requestId, error: "Hosted execution timed out before reaching a terminal state" })}\n\n`);
          } else if (replay.length === 0 && sentEventCount === 0) {
            res.write(`data: ${JSON.stringify({ type: "turn.failed", turnId: body.turnId ?? body.requestId, error: found.execution.resultError ?? `Hosted execution ${found.execution.status}` })}\n\n`);
          }
          res.end();
        }
        return;
      }

      if (url.pathname === "/v1/hosted/executions" && method === "GET") {
        const userId = await this.authenticateRequest(req);
        const executions = await this.hostedRuntime.authority.list(userId);
        this.sendJson(res, 200, executions.map((execution) => publicHostedExecution(execution)), corsOrigin);
        return;
      }

      const executionResultRoute = url.pathname.match(/^\/v1\/hosted\/executions\/([^/]+)\/result$/);
      if (executionResultRoute && method === "GET") {
        const userId = await this.authenticateRequest(req);
        const found = await this.hostedRuntime.result(executionResultRoute[1]!, userId);
        if (!found) {
          this.sendJson(res, 404, { error: "Hosted execution not found" }, corsOrigin);
          return;
        }
        const { execution, result } = found;
        if (execution.status === "queued" || execution.status === "claimed" || execution.status === "dispatching" || execution.status === "recovery_pending") {
          this.sendJson(res, 409, { executionId: execution.id, status: execution.status }, corsOrigin);
          return;
        }
        this.sendJson(res, 200, { executionId: execution.id, status: execution.status, result: result ?? null, error: execution.resultError }, corsOrigin);
        return;
      }

      const executionCancelRoute = url.pathname.match(/^\/v1\/hosted\/executions\/([^/]+)\/cancel$/);
      if (executionCancelRoute && method === "POST") {
        const userId = await this.authenticateRequest(req);
        try {
          const cancelled = await this.hostedRuntime.cancel(executionCancelRoute[1]!, userId);
          this.audit({ type: "hosted.execution.cancelled", outcome: "success", userId, ipAddress: clientIp, details: { executionId: executionCancelRoute[1]!, transitioned: cancelled.transitioned } });
          this.sendJson(res, 200, { ...publicHostedExecution(cancelled.execution), dispatchMayHaveStarted: cancelled.dispatchMayHaveStarted, transitioned: cancelled.transitioned, cancelledChildIds: cancelled.cancelledChildIds }, corsOrigin);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.sendJson(res, /not found/i.test(message) ? 404 : 500, { error: /not found/i.test(message) ? "Hosted execution not found" : "Cancellation failed" }, corsOrigin);
        }
        return;
      }

      // Subagent fan-out: a child execution is durably linked to its parent at enqueue time —
      // the DB enforces same-owner and a live (non-terminal) parent, and parent cancellation
      // cascades to every non-terminal descendant in one transaction.
      const executionChildrenRoute = url.pathname.match(/^\/v1\/hosted\/executions\/([^/]+)\/children$/);
      if (executionChildrenRoute && method === "POST") {
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, HostedInferenceSchema);
        try {
          const { execution, created } = await this.hostedRuntime.enqueueChild(userId, executionChildrenRoute[1]!, body as HostedInferenceRequest, this.resolveRegionEvidence(req));
          this.audit({ type: "hosted.execution.enqueued", outcome: "success", userId, ipAddress: clientIp, details: { executionId: execution.id, parentExecutionId: executionChildrenRoute[1]!, created } });
          this.sendJson(res, created ? 202 : 200, publicHostedExecution(execution, created), corsOrigin);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Hosted child execution admission failed";
          this.audit({ type: "hosted.execution.enqueued", outcome: "denied", userId, ipAddress: clientIp, details: { parentExecutionId: executionChildrenRoute[1]!, reason: message } });
          this.sendJson(res, /not found/i.test(message) ? 404 : /terminal/i.test(message) ? 409 : hostedAdmissionErrorStatus(error), { error: message }, corsOrigin);
        }
        return;
      }

      if (executionChildrenRoute && method === "GET") {
        const userId = await this.authenticateRequest(req);
        try {
          const children = await this.hostedRuntime.listChildren(executionChildrenRoute[1]!, userId);
          this.sendJson(res, 200, children.map((execution) => publicHostedExecution(execution)), corsOrigin);
        } catch (error) {
          this.sendJson(res, /not found/i.test(error instanceof Error ? error.message : "") ? 404 : 500, { error: "Hosted execution not found" }, corsOrigin);
        }
        return;
      }

      const executionStatusRoute = url.pathname.match(/^\/v1\/hosted\/executions\/([^/]+)$/);
      if (executionStatusRoute && method === "GET") {
        const userId = await this.authenticateRequest(req);
        const execution = await this.hostedRuntime.status(executionStatusRoute[1]!, userId);
        if (!execution) {
          this.sendJson(res, 404, { error: "Hosted execution not found" }, corsOrigin);
          return;
        }
        this.sendJson(res, 200, publicHostedExecution(execution), corsOrigin);
        return;
      }

      // Hosted workflows are owner-scoped. Worker actions themselves can only be minted by the
      // server-side workflow authority; the public transport can poll and return results only.
      if (await handleSponsorOperatorHttp(req, res, url, { service: this.sponsorOperators,
        authenticate: (request) => this.authenticateRequest(request), readJson: (request, schema) => this.readJson(request, schema),
        sendJson: (response, status, body) => this.sendJson(response, status, body, corsOrigin) })) return;

      if (url.pathname.startsWith("/v1/remote-direct/")) {
        const principal = await this.remoteDirectPrincipal(req);
        await handleRemoteDirectHttp({ path: url.pathname, method: method ?? "GET", principal, transport: this.remoteDirectTransport,
          read: () => this.readJson(req, z.unknown()), send: (status, body) => this.sendJson(res, status, body, corsOrigin) });
        return;
      }

      const remoteSubmitRoute = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/remote-direct$/);
      if (remoteSubmitRoute && method === "POST") {
        const ownerUserId = await this.authenticateRequest(req);
        if (!this.remoteDirectSubmit) { this.sendJson(res, 503, { error: "REMOTE_DISPATCH_UNAVAILABLE" }, corsOrigin); return; }
        const body = await this.readJson(req, z.object({ request: ChatRequestSchema,
          role: z.enum(["CODER", "EXPLORER", "TOOL_AGENT", "PLANNER", "REVIEWER"]).default("CODER") }).strict());
        try {
          const jobId = await this.remoteDirectSubmit(ownerUserId, remoteSubmitRoute[1]!, body.request, body.role ?? "CODER");
          this.sendJson(res, 201, { jobId }, corsOrigin);
        } catch { this.sendJson(res, 409, { error: "REMOTE_DISPATCH_DENIED" }, corsOrigin); }
        return;
      }

      const remoteStatusRoute = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/remote-direct\/([^/]+)$/);
      if (remoteStatusRoute && method === "GET") {
        const ownerUserId = await this.authenticateRequest(req);
        const workflow = await this.hostedWorkflowAuthority.get(remoteStatusRoute[1]!, ownerUserId);
        const job = await this.sessionPersistence.getWorkItem(remoteStatusRoute[2]!);
        if (!workflow || job?.kind !== "remote_direct_job" || job.ownerUserId !== ownerUserId
          || job.runId !== workflow.id || job.workspaceId !== workflow.workspaceId || job.deviceId !== workflow.workerId) {
          this.sendJson(res, 404, { error: "Remote assignment not found" }, corsOrigin); return;
        }
        this.sendJson(res, 200, await this.remoteDirectTransport.status(ownerUserId, job.id), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/workflows" && method === "POST") {
        const ownerUserId = await this.authenticateRequest(req);
        const body = await this.readJson(req, HostedWorkflowCreateSchema);
        this.sendJson(res, 201, await this.hostedWorkflowAuthority.create({ ownerUserId, ...body }), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/workflows" && method === "GET") {
        const ownerUserId = await this.authenticateRequest(req);
        this.sendJson(res, 200, await this.hostedWorkflowAuthority.list(ownerUserId), corsOrigin);
        return;
      }

      const workflowCancelRoute = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/cancel$/);
      if (workflowCancelRoute && method === "POST") {
        const ownerUserId = await this.authenticateRequest(req);
        const workflowId = workflowCancelRoute[1]!;
        if (!await this.hostedWorkflowAuthority.get(workflowId, ownerUserId)) {
          this.sendJson(res, 404, { error: "Hosted workflow not found" }, corsOrigin);
          return;
        }
        const cancelled = await this.hostedWorkflowAuthority.cancel(ownerUserId, workflowId);
        for (const job of await this.sessionPersistence.getWorkItemsByKind("remote_direct_job")) {
          if (job.kind === "remote_direct_job" && job.ownerUserId === ownerUserId && job.runId === workflowId) await this.remoteDirectTransport.cancel(ownerUserId, job.id);
        }
        this.sendJson(res, 200, cancelled, corsOrigin);
        return;
      }

      const workflowStatusRoute = url.pathname.match(/^\/v1\/workflows\/([^/]+)$/);
      if (workflowStatusRoute && method === "GET") {
        const ownerUserId = await this.authenticateRequest(req);
        const workflow = await this.hostedWorkflowAuthority.get(workflowStatusRoute[1]!, ownerUserId);
        if (!workflow) {
          this.sendJson(res, 404, { error: "Hosted workflow not found" }, corsOrigin);
          return;
        }
        this.sendJson(res, 200, workflow, corsOrigin);
        return;
      }

      if (url.pathname === "/v1/worker/actions" && method === "GET") {
        const ownerUserId = await this.authenticateRequest(req);
        const workerId = WorkerIdSchema.parse(url.searchParams.get("workerId"));
        this.sendJson(res, 200, await this.hostedWorkflowAuthority.pending(ownerUserId, workerId), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/worker/actions/result" && method === "POST") {
        const ownerUserId = await this.authenticateRequest(req);
        const result = await this.readJson(req, DesktopWorkerActionResultSchema);
        this.sendJson(res, 200, await this.hostedWorkflowAuthority.result(ownerUserId, {
          ...result,
          changedResources: result.changedResources ?? [],
        }), corsOrigin);
        return;
      }

      // 7. CF-11B: GitHub App repository authorization. Identity OAuth is unchanged and remains
      //    identity-only; write access is granted exclusively by installing the GitHub App.
      if (url.pathname === "/v1/github-app/authorizations/start" && method === "POST") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = await this.authenticateRequest(req);
        this.sendJson(res, 200, await service.startAuthorization(userId), corsOrigin);
        return;
      }

      if (url.pathname === "/v1/github-app/authorizations/callback" && method === "POST") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = await this.authenticateRequest(req);
        const body = await this.readJson(req, GitHubAppAuthCallbackSchema);
        try {
          const result = await service.handleCallback({ state: body.state, installationId: body.installationId, expectedUserId: userId });
          this.audit({ type: "github.app.authorized", outcome: "success", userId, ipAddress: clientIp, details: { installationId: result.installation.installationId, repositories: result.repositories.length } });
          this.sendJson(res, 200, {
            installation: { id: result.installation.id, installationId: result.installation.installationId, accountLogin: result.installation.accountLogin, accountType: result.installation.accountType, status: result.installation.status },
            repositories: result.repositories.map((item) => ({ repositoryId: item.repositoryId, fullName: item.fullName, private: item.private, authorizationState: item.authorizationState })),
          }, corsOrigin);
        } catch (error) {
          this.audit({ type: "github.app.authorization_failed", outcome: "failure", userId, ipAddress: clientIp, details: { code: error instanceof GitHubAuthorizationError ? error.code : "unknown" } });
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      if (url.pathname === "/v1/github-app/installations" && method === "GET") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = await this.authenticateRequest(req);
        const installations = await service.listUserInstallations(userId);
        this.sendJson(res, 200, installations.map((item) => ({ id: item.id, installationId: item.installationId, accountLogin: item.accountLogin, accountType: item.accountType, status: item.status, repositorySelection: item.repositorySelection })), corsOrigin);
        return;
      }

      // 7b. R22: GitHub App webhook — UNAUTHENTICATED by design (GitHub is the caller); the
      //     HMAC-SHA256 signature over the raw body is the authentication, and the delivery
      //     GUID claim is the dedup boundary. Never gated by user auth, never trusts payload
      //     content beyond the fields needed for access invalidation.
      if (url.pathname === "/v1/github-app/webhook" && method === "POST") {
        if (!this.gitHubWebhook) {
          this.sendJson(res, 503, { error: "GitHub App webhooks are not configured for this deployment" }, corsOrigin);
          return;
        }
        const rawBody = await this.readRawBody(req);
        try {
          const result = await this.gitHubWebhook.handleDelivery({
            signatureHeader: req.headers["x-hub-signature-256"] as string | undefined,
            deliveryId: req.headers["x-github-delivery"] as string | undefined,
            event: req.headers["x-github-event"] as string | undefined,
            rawBody,
          });
          this.audit({
            type: `github.webhook.${result.action === "duplicate_skipped" ? "duplicate" : result.action === "ignored" ? "ignored" : "processed"}`,
            outcome: "info",
            ipAddress: clientIp,
            details: { event: result.event, action: result.action },
          });
          this.sendJson(res, 200, result, corsOrigin);
        } catch (error) {
          const code = error instanceof GitHubWebhookError ? error.code : "unknown";
          this.audit({ type: "github.webhook.rejected", outcome: "denied", ipAddress: clientIp, details: { code } });
          this.sendJson(res, code === "GITHUB_WEBHOOK_PAYLOAD_TOO_LARGE" ? 413 : 400, { error: "Webhook rejected", code }, corsOrigin);
        }
        return;
      }

      if (url.pathname === "/v1/github-app/repositories" && method === "GET") {
        const service = this.requireGitHubAppAuth(res, corsOrigin);
        if (!service) return;
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
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
        const userId = await this.authenticateRequest(req);
        try {
          this.sendJson(res, 200, await service.getStatus(userId, statusRoute[1]!), corsOrigin);
        } catch (error) {
          this.sendPublicationError(res, error, corsOrigin);
        }
        return;
      }

      this.sendJson(res, 404, { error: "Endpoint not found" }, corsOrigin);
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError = msg.includes("Bearer token") || msg.includes("browser session") || msg.includes("JWT") || msg.includes("expired") || msg.includes("revoked") || msg.includes("Session has been");
      const isPayloadTooLarge = msg.includes("Payload Too Large");
      const isValidation = msg.startsWith("Validation error:") || msg === "Invalid JSON body";
      // Messages a client is entitled to see: authentication outcomes, request-shape problems, and
      // the deliberately client-facing domain errors (OAuth/PKCE/redirect policy, billing
      // configuration, ownership). Anything else — driver errors, upstream bodies, filesystem
      // paths — is an internal error and is replaced by a generic message with a correlation id.
      const isClientFacingDomainError =
        /^(OAuth|Desktop authorization code|PKCE|Browser OAuth|Unknown browser OAuth|Invalid (redirect|loopback)|Redirect URI|A base64url|CODEFORGE_PUBLIC_URL|No Stripe customer|User not found|Hosted work|Unknown hosted|GitHub identity|Unable to resolve)/.test(msg);
      const status = isPayloadTooLarge ? 413 : isAuthError ? 401 : 400;

      if (isAuthError) {
        this.audit({ type: "auth.session.rejected", outcome: "denied", ipAddress: clientIp, details: { path: url.pathname, reason: msg.slice(0, 120) } });
        this.sendJson(res, status, { error: this.redactClientMessage(msg), code: PUBLICATION_ERROR_CODES.UNAUTHENTICATED }, corsOrigin);
        return;
      }

      if (isPayloadTooLarge || isValidation || isClientFacingDomainError) {
        this.sendJson(res, status, { error: this.redactClientMessage(msg) }, corsOrigin);
        return;
      }

      const correlationId = randomUUID();
      this.logger.error("unhandled request error", { correlationId, path: url.pathname, method, error: err });
      this.sendJson(res, 500, { error: "Internal server error", code: "INTERNAL_ERROR", correlationId }, corsOrigin);
    }
  }

  /** Client-facing text passes through the shared redactor and is bounded; no stack, no internals. */
  private redactClientMessage(message: string): string {
    return redactSecrets(message).slice(0, 512);
  }
}
