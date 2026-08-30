import { z } from "zod";
import {
  resolveCloudProviderCredentials,
  type CloudKillSwitchConfig,
  type ResolvedProviderCredentials,
} from "@codeforge/cloud-gateway";

/**
 * Canonical CodeForge Cloud runtime configuration. Built and validated exactly once at startup from
 * the process environment (or an injected env for tests). Business services receive this typed object
 * instead of reaching into `process.env`, so configuration is validated in one place and fails closed.
 */
export interface CloudRuntimeConfig {
  environment: "development" | "staging" | "production";
  host: string;
  port: number;

  /**
   * The deployment's public base URL (scheme + host, no trailing slash). This is the origin GitHub
   * redirects back to, so it is REQUIRED in staging/production and must be HTTPS there. It is not a
   * secret; it is authoritative configuration, which is exactly why it may not come from a client.
   */
  publicUrl?: string;

  database: {
    driver: "sqlite" | "postgres";
    /** Postgres connection string (postgres driver only). */
    url?: string;
    /** Certificate-validated TLS for a non-loopback Postgres connection. */
    ssl?: boolean;
    /** SQLite file path (sqlite driver only). `:memory:` is refused outside development. */
    path?: string;
  };

  jwtSecret: string;

  gitHub: {
    clientId?: string;
    clientSecret?: string;
  };

  /** Optional Stripe TEST-mode billing integration. Hosted Free does not depend on it. */
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    proPriceId: string;
    creditPackPriceId: string;
  };

  killSwitches: CloudKillSwitchConfig;

  rateLimits: {
    maxRequestsPerMinute: number;
  };

  /** Honor X-Forwarded-For only when the deployment proxy is explicitly trusted. */
  trustProxy: boolean;

  requestTimeoutMs: number;

  allowedOrigins: string[];

  logLevel: "debug" | "info" | "warn" | "error" | "silent";

  /** Server-owned provider credentials resolved from env (never logged, never sent to clients). */
  providerCredentials: ResolvedProviderCredentials;
}

const EnvSchema = z.object({
  CODEFORGE_CLOUD_ENV: z.enum(["development", "staging", "production"]).optional(),
  NODE_ENV: z.string().optional(),
  HOST: z.string().optional(),
  PORT: z.string().optional(),
  CODEFORGE_PUBLIC_URL: z.string().optional(),
  CODEFORGE_CLOUD_DB_DRIVER: z.enum(["sqlite", "postgres"]).optional(),
  DATABASE_URL: z.string().optional(),
  CODEFORGE_CLOUD_DB_SSL: z.string().optional(),
  CODEFORGE_CLOUD_DB_PATH: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_CREDIT_PRICE_ID: z.string().optional(),
  CODEFORGE_HOSTED_INFERENCE_ENABLED: z.string().optional(),
  CODEFORGE_HOSTED_FREE_ENABLED: z.string().optional(),
  CODEFORGE_MAX_REQUEST_COST_USD: z.string().optional(),
  CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD: z.string().optional(),
  CODEFORGE_MAX_REQUESTS_PER_MINUTE: z.string().optional(),
  CODEFORGE_TRUST_PROXY: z.string().optional(),
  CODEFORGE_REQUEST_TIMEOUT_MS: z.string().optional(),
  CODEFORGE_ALLOWED_ORIGINS: z.string().optional(),
  CODEFORGE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
});

function parseBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseOptionalBool(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  throw new CloudConfigError(`${name} must be a boolean value.`);
}

function parsePostgresUrl(databaseUrl: string): URL {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    return parsed;
  } catch {
    throw new CloudConfigError("DATABASE_URL must be a valid postgres:// or postgresql:// URL.");
  }
}

function isLoopbackDatabase(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function parseNum(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudConfigError";
  }
}

/**
 * Load and validate the cloud runtime configuration. Throws {@link CloudConfigError} on any unsafe or
 * incomplete production configuration — a bad config must stop boot, never degrade silently.
 */
export function loadCloudRuntimeConfig(env: Record<string, string | undefined> = process.env): CloudRuntimeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new CloudConfigError(`Invalid cloud configuration: ${parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
  }
  const e = parsed.data;

  const environment: CloudRuntimeConfig["environment"] =
    e.CODEFORGE_CLOUD_ENV ?? (e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "staging" ? "staging" : "development");
  const isProdLike = environment === "production" || environment === "staging";

  // --- Database -------------------------------------------------------------------------------
  const driver: "sqlite" | "postgres" = e.CODEFORGE_CLOUD_DB_DRIVER ?? (e.DATABASE_URL?.startsWith("postgres") ? "postgres" : "sqlite");
  const database: CloudRuntimeConfig["database"] = { driver };
  if (driver === "postgres") {
    if (!e.DATABASE_URL) throw new CloudConfigError("CODEFORGE_CLOUD_DB_DRIVER=postgres requires DATABASE_URL.");
    const parsedDatabaseUrl = parsePostgresUrl(e.DATABASE_URL);
    const requestedSslMode = parsedDatabaseUrl.searchParams.get("sslmode")?.toLowerCase();
    const explicitSsl = parseOptionalBool("CODEFORGE_CLOUD_DB_SSL", e.CODEFORGE_CLOUD_DB_SSL);
    if (isProdLike && (requestedSslMode === "disable" || requestedSslMode === "allow" || requestedSslMode === "prefer" || requestedSslMode === "no-verify")) {
      throw new CloudConfigError("DATABASE_URL must not disable or weaken TLS in staging/production.");
    }
    const ssl = explicitSsl ?? !isLoopbackDatabase(parsedDatabaseUrl);
    if (isProdLike && !isLoopbackDatabase(parsedDatabaseUrl) && !ssl) {
      throw new CloudConfigError("Remote PostgreSQL in staging/production requires CODEFORGE_CLOUD_DB_SSL=true with certificate validation.");
    }
    database.url = e.DATABASE_URL;
    database.ssl = ssl;
  } else {
    const path = e.CODEFORGE_CLOUD_DB_PATH ?? (e.DATABASE_URL && !e.DATABASE_URL.startsWith("postgres") ? e.DATABASE_URL : undefined);
    // Production-truth: a staging/production deployment must not run on an ephemeral in-memory DB.
    if (isProdLike && (!path || path === ":memory:")) {
      throw new CloudConfigError(
        "SQLite driver in staging/production requires a persistent CODEFORGE_CLOUD_DB_PATH (an ephemeral :memory: database is not cloud-ready). Prefer CODEFORGE_CLOUD_DB_DRIVER=postgres.",
      );
    }
    database.path = path ?? ":memory:";
  }

  // --- JWT ------------------------------------------------------------------------------------
  const jwtSecret = e.JWT_SECRET ?? (isProdLike ? "" : "codeforge-cloud-test-jwt-secret-key-32chars");
  if (!jwtSecret || jwtSecret.length < 32 || (isProdLike && jwtSecret.includes("test-jwt-secret"))) {
    throw new CloudConfigError("JWT_SECRET must be at least 32 cryptographically strong characters (and not the test default) in staging/production.");
  }

  // --- Public URL -----------------------------------------------------------------------------
  // GitHub redirects to `${publicUrl}/v1/auth/github/callback`, so a staging/production deployment
  // without a valid public HTTPS origin cannot complete authentication at all — fail at boot rather
  // than at the first login attempt.
  let publicUrl: string | undefined;
  if (e.CODEFORGE_PUBLIC_URL) {
    let parsedPublic: URL;
    try {
      parsedPublic = new URL(e.CODEFORGE_PUBLIC_URL);
    } catch {
      throw new CloudConfigError("CODEFORGE_PUBLIC_URL must be an absolute URL (e.g. https://cloud.example.com).");
    }
    const isLoopbackPublic = parsedPublic.hostname === "127.0.0.1" || parsedPublic.hostname === "localhost";
    if (parsedPublic.protocol !== "https:" && !(parsedPublic.protocol === "http:" && !isProdLike && isLoopbackPublic)) {
      throw new CloudConfigError("CODEFORGE_PUBLIC_URL must use HTTPS (plain http is permitted only for loopback development).");
    }
    if (parsedPublic.username || parsedPublic.password || parsedPublic.search || parsedPublic.hash) {
      throw new CloudConfigError("CODEFORGE_PUBLIC_URL must not contain credentials, a query string, or a fragment.");
    }
    publicUrl = `${parsedPublic.protocol}//${parsedPublic.host}${parsedPublic.pathname.replace(/\/+$/, "")}`;
  } else if (isProdLike) {
    throw new CloudConfigError("CODEFORGE_PUBLIC_URL is required in staging/production — it is the origin GitHub redirects back to.");
  }

  // --- GitHub OAuth ---------------------------------------------------------------------------
  const gitHub = { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET };
  if (isProdLike && (!gitHub.clientId || !gitHub.clientSecret)) {
    throw new CloudConfigError("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required in staging/production.");
  }

  // --- Stripe (optional, TEST MODE ONLY) ------------------------------------------------------
  // Hosted Free must remain usable without billing infrastructure. If an operator enables Stripe
  // separately, require a complete TEST-mode configuration rather than accepting a partial one.
  const hasStripeSecretKey = Boolean(e.STRIPE_SECRET_KEY);
  const hasStripeWebhookSecret = Boolean(e.STRIPE_WEBHOOK_SECRET);
  if (e.STRIPE_SECRET_KEY && /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY)) {
    throw new CloudConfigError("Live Stripe keys (sk_live_/rk_live_) are refused. CodeForge Cloud runs in Stripe TEST MODE only.");
  }
  if (hasStripeSecretKey !== hasStripeWebhookSecret) {
    throw new CloudConfigError("Stripe billing requires both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET when it is configured.");
  }
  if (e.STRIPE_SECRET_KEY && !/^(sk|rk)_test_/.test(e.STRIPE_SECRET_KEY)) {
    throw new CloudConfigError("STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_/rk_test_) when billing is configured.");
  }
  const stripe = hasStripeSecretKey
    ? {
        secretKey: e.STRIPE_SECRET_KEY!,
        webhookSecret: e.STRIPE_WEBHOOK_SECRET!,
        proPriceId: e.STRIPE_PRO_PRICE_ID ?? "price_pro_test",
        creditPackPriceId: e.STRIPE_CREDIT_PRICE_ID ?? "price_credits_test",
      }
    : isProdLike
      ? undefined
      : {
          secretKey: "sk_test_mock_123",
          webhookSecret: "whsec_mock_456",
          proPriceId: "price_pro_test",
          creditPackPriceId: "price_credits_test",
        };

  // --- Kill switches / spend firewall ---------------------------------------------------------
  const killSwitches: CloudKillSwitchConfig = {
    hostedInferenceEnabled: parseBool(e.CODEFORGE_HOSTED_INFERENCE_ENABLED, true),
    hostedFreeEnabled: parseBool(e.CODEFORGE_HOSTED_FREE_ENABLED, true),
    maxRequestCostUsd: parseNum(e.CODEFORGE_MAX_REQUEST_COST_USD, 2.0),
    globalDailySpendLimitUsd: parseNum(e.CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD, 1000.0),
  };

  const allowedOrigins = (e.CODEFORGE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    environment,
    host: e.HOST ?? "127.0.0.1",
    port: parseNum(e.PORT, 3220),
    publicUrl,
    database,
    jwtSecret,
    gitHub,
    stripe,
    killSwitches,
    rateLimits: { maxRequestsPerMinute: parseNum(e.CODEFORGE_MAX_REQUESTS_PER_MINUTE, 120) },
    requestTimeoutMs: parseNum(e.CODEFORGE_REQUEST_TIMEOUT_MS, 60_000),
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["http://127.0.0.1", "http://localhost", "https://codeforge.dev"],
    logLevel: e.CODEFORGE_LOG_LEVEL ?? (isProdLike ? "info" : "debug"),
    providerCredentials: resolveCloudProviderCredentials(env),
    trustProxy: parseOptionalBool("CODEFORGE_TRUST_PROXY", e.CODEFORGE_TRUST_PROXY) ?? false,
  };
}

/** Redacted one-line startup summary — safe to log (contains no secrets or credential values). */
export function describeConfig(config: CloudRuntimeConfig): string {
  const providers = config.providerCredentials.providerIds;
  return [
    `env=${config.environment}`,
    `db=${config.database.driver}`,
    `dbTls=${config.database.ssl ?? false}`,
    `host=${config.host}:${config.port}`,
    `publicUrl=${config.publicUrl ?? "unset"}`,
    `github=${config.gitHub.clientId ? "configured" : "absent"}`,
    `stripe=${config.stripe ? "test-mode" : "disabled"}`,
    `providers=[${providers.join(",") || "none"}]`,
    `hostedInference=${config.killSwitches.hostedInferenceEnabled}`,
    `hostedFree=${config.killSwitches.hostedFreeEnabled}`,
    `dailyLimitUsd=${config.killSwitches.globalDailySpendLimitUsd}`,
    `trustProxy=${config.trustProxy}`,
    `logLevel=${config.logLevel}`,
  ].join(" ");
}
