/**
 * THE canonical CodeForge Cloud staging/production configuration contract.
 *
 * Every environment variable the Cloud reads is declared exactly once, here, with its requirement
 * level and whether its value is a secret. Nothing else in the repository is allowed to invent a new
 * deployment variable: the preflight, the launch checklist, the deployment manifests, and the operator
 * documentation are all generated from (or checked against) this list, so they cannot drift apart.
 *
 * Requirement levels:
 *   * `required`  — a staging/production deployment cannot serve correct traffic without it.
 *   * `optional`  — tunes behavior; a sane default exists.
 *   * `forbidden` — its presence is a hard failure (live-money credentials).
 *
 * `secret: true` means the VALUE must never be printed, logged, or written to a receipt. Preflight
 * reports only presence/absence for these.
 */
export type ConfigRequirement = "required" | "optional" | "forbidden";

export interface StagingConfigVariable {
  name: string;
  requirement: ConfigRequirement;
  secret: boolean;
  description: string;
  /** Human-readable shape hint, shown in docs and failure messages. Never an example secret. */
  example?: string;
}

export const STAGING_CONFIG_CONTRACT: readonly StagingConfigVariable[] = [
  // --- Runtime identity ----------------------------------------------------------------------
  { name: "NODE_ENV", requirement: "required", secret: false, description: "Node runtime mode. Must be 'production' for a deployed image.", example: "production" },
  { name: "CODEFORGE_CLOUD_ENV", requirement: "required", secret: false, description: "CodeForge deployment tier. Drives fail-closed validation.", example: "staging" },
  {
    name: "CODEFORGE_PUBLIC_URL",
    requirement: "required",
    secret: false,
    description: "Public HTTPS origin of this deployment. The GitHub OAuth callback is derived from it.",
    example: "https://codeforge-cloud-api.example.com",
  },
  { name: "HOST", requirement: "optional", secret: false, description: "Bind address. Container deployments need 0.0.0.0.", example: "0.0.0.0" },
  { name: "PORT", requirement: "optional", secret: false, description: "Listen port. Defaults to 3220.", example: "3220" },
  {
    name: "CODEFORGE_TRUST_PROXY",
    requirement: "required",
    secret: false,
    description: "Whether X-Forwarded-For is honored. Must be explicit: 'true' behind a platform proxy, 'false' otherwise.",
    example: "true",
  },

  // --- Database ------------------------------------------------------------------------------
  { name: "CODEFORGE_CLOUD_DB_DRIVER", requirement: "required", secret: false, description: "Persistence driver. Staging/production must be 'postgres'.", example: "postgres" },
  {
    name: "DATABASE_URL",
    requirement: "required",
    secret: true,
    description: "PostgreSQL connection string. Must not weaken TLS (sslmode=disable/allow/prefer are refused).",
    example: "postgresql://user:password@host:5432/database",
  },
  { name: "CODEFORGE_CLOUD_DB_SSL", requirement: "required", secret: false, description: "Certificate-validated TLS for a remote database. Must be 'true' for a non-loopback host.", example: "true" },
  { name: "CODEFORGE_CLOUD_DB_PATH", requirement: "optional", secret: false, description: "SQLite file path. Only meaningful for the sqlite driver (not a cloud deployment).", example: "/data/codeforge.db" },

  // --- Session / token signing ---------------------------------------------------------------
  {
    name: "JWT_SECRET",
    requirement: "required",
    secret: true,
    description: "Access-token signing secret. At least 32 cryptographically strong characters. Rotating it invalidates all sessions.",
    example: "<32+ random characters>",
  },

  // --- GitHub OAuth (server-owned confidential client) ----------------------------------------
  { name: "GITHUB_CLIENT_ID", requirement: "required", secret: false, description: "GitHub OAuth App client id.", example: "Iv1.xxxxxxxxxxxxxxxx" },
  {
    name: "GITHUB_CLIENT_SECRET",
    requirement: "required",
    secret: true,
    description: "GitHub OAuth App client secret. Exists ONLY on the server; never shipped to the desktop.",
    example: "<github oauth app client secret>",
  },

  // --- Stripe (optional, TEST MODE ONLY) -------------------------------------------------------
  { name: "STRIPE_SECRET_KEY", requirement: "optional", secret: true, description: "Optional Stripe TEST-mode key. Configure it only with STRIPE_WEBHOOK_SECRET; Hosted Free does not depend on billing.", example: "sk_test_..." },
  { name: "STRIPE_WEBHOOK_SECRET", requirement: "optional", secret: true, description: "Optional Stripe test webhook signing secret. Configure it only with STRIPE_SECRET_KEY.", example: "whsec_..." },
  { name: "STRIPE_PRO_PRICE_ID", requirement: "optional", secret: false, description: "Stripe test price id for the Pro plan.", example: "price_..." },
  { name: "STRIPE_CREDIT_PRICE_ID", requirement: "optional", secret: false, description: "Stripe test price id for credit packs.", example: "price_..." },

  // --- Server-owned Hosted Free capacity -------------------------------------------------------
  {
    name: "OPENROUTER_API_KEY",
    requirement: "optional",
    secret: true,
    description: "Server-owned OpenRouter key. Supplies verified $0 (:free) Hosted capacity. At least one provider key is needed for Hosted Free to be available.",
    example: "sk-or-...",
  },
  { name: "GROQ_API_KEY", requirement: "optional", secret: true, description: "Server-owned Groq key. Supplies free-allowance Hosted capacity.", example: "gsk_..." },

  // --- Operator policy -------------------------------------------------------------------------
  { name: "CODEFORGE_ALLOWED_ORIGINS", requirement: "optional", secret: false, description: "Comma-separated CORS allow-list. Desktop loopback origins are always permitted.", example: "https://codeforge.dev" },
  { name: "CODEFORGE_REQUEST_TIMEOUT_MS", requirement: "optional", secret: false, description: "Upper bound on a single hosted inference.", example: "60000" },
  { name: "CODEFORGE_MAX_REQUESTS_PER_MINUTE", requirement: "optional", secret: false, description: "Per-IP rate limit.", example: "120" },
  { name: "CODEFORGE_HOSTED_INFERENCE_ENABLED", requirement: "optional", secret: false, description: "Master kill switch for hosted inference.", example: "true" },
  { name: "CODEFORGE_HOSTED_FREE_ENABLED", requirement: "optional", secret: false, description: "Kill switch for the Free tier specifically.", example: "true" },
  { name: "CODEFORGE_MAX_REQUEST_COST_USD", requirement: "optional", secret: false, description: "Per-request provider spend ceiling.", example: "2.0" },
  { name: "CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD", requirement: "optional", secret: false, description: "Global daily provider spend ceiling.", example: "1000.0" },
  { name: "CODEFORGE_LOG_LEVEL", requirement: "optional", secret: false, description: "Log verbosity.", example: "info" },
] as const;

/** Variable names whose values must never be printed. Used by every reporting surface. */
export const SECRET_CONFIG_NAMES: ReadonlySet<string> = new Set(STAGING_CONFIG_CONTRACT.filter((v) => v.secret).map((v) => v.name));

export function getConfigVariable(name: string): StagingConfigVariable | undefined {
  return STAGING_CONFIG_CONTRACT.find((v) => v.name === name);
}

/**
 * Patterns that mark a credential as live-money or otherwise categorically refused. A match is fatal
 * everywhere: boot, preflight, and certification.
 */
export const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^sk_live_/, reason: "live Stripe secret key" },
  { pattern: /^rk_live_/, reason: "live Stripe restricted key" },
];

/**
 * Redact anything that looks like a credential out of a string destined for a log, a console line, or
 * a certification receipt. Deliberately aggressive: it is always better to over-redact evidence than
 * to publish one real secret.
 */
/**
 * Redact SPECIFIC known values.
 *
 * Pattern-based redaction ({@link redactSecrets}) can only catch credentials with a recognizable
 * shape. A session signing secret is just high-entropy text and is indistinguishable from any other
 * string, so the only way to guarantee it never appears in an output is to redact the exact value —
 * which is possible whenever the caller holds the environment it came from.
 *
 * @param input text destined for a log, console line, or receipt
 * @param values the secret values to remove (short values are ignored: redacting a 3-character
 *   string would mangle unrelated text without protecting anything meaningful)
 */
export function redactKnownValues(input: string, values: Iterable<string | undefined>): string {
  let out = input;
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length < 8) continue;
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

/** Collect the values of every secret-marked variable present in an environment. */
export function secretValuesIn(env: Record<string, string | undefined>): string[] {
  return [...SECRET_CONFIG_NAMES].map((name) => env[name]).filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function redactSecrets(input: string): string {
  return input
    .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9_]+/g, "[REDACTED_STRIPE_KEY]")
    .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[REDACTED_STRIPE_WEBHOOK_SECRET]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-or-[A-Za-z0-9-]+/g, "[REDACTED_PROVIDER_KEY]")
    .replace(/\bgsk_[A-Za-z0-9]+/g, "[REDACTED_PROVIDER_KEY]")
    .replace(/\bcfr_[A-Za-z0-9_-]+/g, "[REDACTED_REFRESH_TOKEN]")
    .replace(/\bcfa_[A-Za-z0-9_-]+/g, "[REDACTED_AUTH_CODE]")
    .replace(/\b(postgres|postgresql):\/\/[^\s"']*/g, "[REDACTED_DATABASE_URL]")
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}
