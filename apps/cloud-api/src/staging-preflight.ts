import { buildCloudGitHubCallbackUrl } from "@codeforge/cloud-auth";
import {
  STAGING_CONFIG_CONTRACT,
  SECRET_CONFIG_NAMES,
  FORBIDDEN_VALUE_PATTERNS,
  redactSecrets,
  redactKnownValues,
  secretValuesIn,
} from "./staging-contract.js";

/**
 * Deterministic staging preflight. Answers exactly one question: "if this environment were handed to
 * the Cloud right now, would it boot and serve correct, zero-cost traffic?"
 *
 * It is a PURE function of an environment map so it is unit-testable and produces identical output in
 * CI, on a workstation, and inside a deployment pipeline. It performs no network I/O — database and
 * public-endpoint reachability are the jobs of the Postgres validator and the remote probe.
 *
 * It never prints a secret VALUE. For secret variables it reports presence, shape class, and length
 * class only.
 */
export type PreflightStatus = "PASS" | "FAIL" | "WARN";

export interface PreflightCheck {
  status: PreflightStatus;
  /** Short, stable identifier — safe to grep in CI logs. */
  id: string;
  message: string;
}

export interface PreflightReport {
  environment: string;
  checks: PreflightCheck[];
  passed: number;
  failed: number;
  warnings: number;
  ok: boolean;
  /**
   * The secret VALUES observed in the environment, kept only so {@link formatPreflightReport} can
   * scrub them from its output by exact match. Never serialize a report without stripping this —
   * {@link preflightReportForSerialization} does that.
   */
  secretValues?: string[];
}

type Env = Record<string, string | undefined>;

function present(env: Env, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim().length > 0;
}

function parseBoolStrict(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return undefined;
}

/**
 * Run the preflight against an environment.
 *
 * @param env the environment to inspect (defaults to `process.env`)
 */
export function runStagingPreflight(env: Env = process.env): PreflightReport {
  const checks: PreflightCheck[] = [];
  const pass = (id: string, message: string) => checks.push({ status: "PASS", id, message });
  const fail = (id: string, message: string) => checks.push({ status: "FAIL", id, message });
  const warn = (id: string, message: string) => checks.push({ status: "WARN", id, message });

  const environment = env.CODEFORGE_CLOUD_ENV ?? (env.NODE_ENV === "production" ? "production" : "development");
  const isProdLike = environment === "staging" || environment === "production";

  // --- Deployment tier ---------------------------------------------------------------------
  if (isProdLike) {
    pass("env.tier", `deployment tier is '${environment}'`);
  } else {
    fail("env.tier", `CODEFORGE_CLOUD_ENV must be 'staging' or 'production' for a deployment preflight (got '${environment}')`);
  }
  if (env.NODE_ENV === "production") {
    pass("env.node", "NODE_ENV=production");
  } else {
    fail("env.node", `NODE_ENV must be 'production' for a deployed image (got '${env.NODE_ENV ?? "unset"}')`);
  }

  // --- Forbidden values: live money ---------------------------------------------------------
  // Checked FIRST and across every variable, because a single live key is disqualifying regardless
  // of how correct the rest of the configuration is.
  let liveKeyFound = false;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    for (const { pattern, reason } of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(value.trim())) {
        liveKeyFound = true;
        fail("stripe.live_key_forbidden", `${name} contains a ${reason} — CodeForge Cloud is TEST MODE ONLY`);
      }
    }
  }
  if (!liveKeyFound) {
    pass("stripe.live_key_absent", "no live Stripe key present in the environment");
  }

  // --- Public URL & OAuth callback ----------------------------------------------------------
  const publicUrlRaw = env.CODEFORGE_PUBLIC_URL;
  if (!publicUrlRaw) {
    fail("public_url.present", "CODEFORGE_PUBLIC_URL is not set");
  } else {
    try {
      const callbackUrl = buildCloudGitHubCallbackUrl(publicUrlRaw, { requireHttps: true });
      pass("public_url.https", `CODEFORGE_PUBLIC_URL is a valid HTTPS origin (${new URL(publicUrlRaw).origin})`);
      pass("oauth.callback_url", `GitHub OAuth App callback must be registered as: ${callbackUrl}`);
    } catch (err) {
      fail("public_url.https", redactSecrets(err instanceof Error ? err.message : String(err)));
    }
  }

  // --- Database ------------------------------------------------------------------------------
  const driver = env.CODEFORGE_CLOUD_DB_DRIVER;
  if (driver === "postgres") {
    pass("db.driver", "database driver is postgres");
  } else {
    fail("db.driver", `CODEFORGE_CLOUD_DB_DRIVER must be 'postgres' for a cloud deployment (got '${driver ?? "unset"}')`);
  }

  if (!present(env, "DATABASE_URL")) {
    fail("db.url_present", "DATABASE_URL is not set");
  } else {
    pass("db.url_present", "DATABASE_URL present");
    let dbUrl: URL | undefined;
    try {
      dbUrl = new URL(env.DATABASE_URL!);
    } catch {
      fail("db.url_valid", "DATABASE_URL is not a parseable URL");
    }
    if (dbUrl) {
      if (dbUrl.protocol === "postgres:" || dbUrl.protocol === "postgresql:") {
        pass("db.url_valid", "DATABASE_URL uses a supported PostgreSQL URL scheme");
      } else {
        fail("db.url_valid", `DATABASE_URL must use a PostgreSQL URL scheme (got '${dbUrl.protocol.replace(":", "")}')`);
      }

      const isLoopbackDb = dbUrl.hostname === "localhost" || dbUrl.hostname === "127.0.0.1" || dbUrl.hostname === "::1";
      const sslMode = dbUrl.searchParams.get("sslmode")?.toLowerCase();
      const explicitSsl = parseBoolStrict(env.CODEFORGE_CLOUD_DB_SSL);

      if (sslMode && ["disable", "allow", "prefer", "no-verify"].includes(sslMode)) {
        fail("db.tls_required", `DATABASE_URL weakens TLS (sslmode=${sslMode}); staging/production requires verified TLS`);
      } else if (isLoopbackDb) {
        warn("db.tls_required", "database host is loopback — TLS is not enforced, which is only appropriate for a sidecar database");
      } else if (explicitSsl === false) {
        fail("db.tls_required", "CODEFORGE_CLOUD_DB_SSL=false with a remote database host — certificate-validated TLS is required");
      } else if (env.CODEFORGE_CLOUD_DB_SSL === undefined) {
        warn("db.tls_required", "CODEFORGE_CLOUD_DB_SSL is unset; TLS will be inferred as required for the remote host. Set it explicitly.");
      } else if (explicitSsl === undefined) {
        fail("db.tls_required", "CODEFORGE_CLOUD_DB_SSL must be a boolean value");
      } else {
        pass("db.tls_required", "database TLS required with certificate validation");
      }
    }
  }

  // --- Session signing ------------------------------------------------------------------------
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    fail("session.secret_present", "JWT_SECRET is not set");
  } else if (jwtSecret.length < 32) {
    fail("session.secret_strength", `JWT_SECRET is too short (${jwtSecret.length} chars; 32+ required)`);
  } else if (jwtSecret.includes("test-jwt-secret") || jwtSecret.includes("mock")) {
    fail("session.secret_strength", "JWT_SECRET looks like a development placeholder");
  } else {
    pass("session.secret_present", `session signing secret present (${jwtSecret.length} chars)`);
  }

  // --- GitHub OAuth ---------------------------------------------------------------------------
  if (present(env, "GITHUB_CLIENT_ID")) {
    pass("oauth.client_id", "GitHub Client ID present");
  } else {
    fail("oauth.client_id", "GITHUB_CLIENT_ID is not set");
  }
  if (present(env, "GITHUB_CLIENT_SECRET")) {
    pass("oauth.client_secret", "GitHub Client Secret present");
  } else {
    fail("oauth.client_secret", "GITHUB_CLIENT_SECRET is not set");
  }

  // --- Stripe (optional, test mode only) ---------------------------------------------------------
  const hasStripeSecretKey = present(env, "STRIPE_SECRET_KEY");
  const hasStripeWebhookSecret = present(env, "STRIPE_WEBHOOK_SECRET");
  if (!hasStripeSecretKey && !hasStripeWebhookSecret) {
    pass("stripe.disabled", "Stripe TEST billing is not configured; Hosted Free remains available without billing infrastructure");
  } else if (!hasStripeSecretKey || !hasStripeWebhookSecret) {
    fail("stripe.configuration_complete", "Stripe billing requires both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET when configured");
  } else if (hasStripeSecretKey) {
    if (env.STRIPE_SECRET_KEY!.startsWith("sk_test_") || env.STRIPE_SECRET_KEY!.startsWith("rk_test_")) {
      pass("stripe.test_mode", "Stripe secret key is a TEST-mode key");
    } else {
      fail("stripe.test_mode", "STRIPE_SECRET_KEY is not a recognizable test-mode key (expected sk_test_/rk_test_ prefix)");
    }
    pass("stripe.webhook_secret", "Stripe webhook signing secret present");
  }

  // --- Server-owned Hosted Free capacity ---------------------------------------------------------
  const providerKeys = ["OPENROUTER_API_KEY", "GROQ_API_KEY"].filter((n) => present(env, n));
  if (providerKeys.length > 0) {
    pass("capacity.provider_credential", `server-owned provider credential present (${providerKeys.join(", ")})`);
  } else {
    fail("capacity.provider_credential", "no server-owned provider credential — Hosted Free will report unavailable (set OPENROUTER_API_KEY and/or GROQ_API_KEY)");
  }

  // --- Proxy / networking -------------------------------------------------------------------------
  const trustProxy = parseBoolStrict(env.CODEFORGE_TRUST_PROXY);
  if (env.CODEFORGE_TRUST_PROXY === undefined) {
    fail("network.trust_proxy", "CODEFORGE_TRUST_PROXY must be set explicitly ('true' behind a platform proxy, 'false' otherwise)");
  } else if (trustProxy === undefined) {
    fail("network.trust_proxy", "CODEFORGE_TRUST_PROXY must be a boolean value");
  } else {
    pass("network.trust_proxy", `trust proxy explicitly ${trustProxy}`);
  }

  if (env.HOST === "0.0.0.0") {
    pass("network.bind", "HOST=0.0.0.0 (reachable inside a container)");
  } else {
    warn("network.bind", `HOST is '${env.HOST ?? "unset"}' — a container deployment normally needs 0.0.0.0`);
  }

  const origins = (env.CODEFORGE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) {
    pass("network.cors", "CORS allow-list unset — the built-in safe default applies (no wildcard)");
  } else if (origins.includes("*")) {
    fail("network.cors", "CODEFORGE_ALLOWED_ORIGINS contains a wildcard '*'");
  } else {
    const insecure = origins.filter((o) => o.startsWith("http://") && !o.includes("127.0.0.1") && !o.includes("localhost"));
    if (insecure.length > 0) {
      fail("network.cors", `CODEFORGE_ALLOWED_ORIGINS contains non-loopback plaintext origins (${insecure.length})`);
    } else {
      pass("network.cors", `CORS allow-list explicit (${origins.length} origin(s))`);
    }
  }

  // --- Contract completeness ----------------------------------------------------------------------
  // Anything the contract marks `required` and that no dedicated check above already covered.
  const covered = new Set(checks.map((c) => c.id));
  const uncoveredRequired = STAGING_CONFIG_CONTRACT.filter((v) => v.requirement === "required" && !present(env, v.name)).map((v) => v.name);
  if (uncoveredRequired.length === 0) {
    pass("contract.required_complete", `all ${STAGING_CONFIG_CONTRACT.filter((v) => v.requirement === "required").length} required contract variables are present`);
  } else {
    fail("contract.required_complete", `missing required configuration: ${uncoveredRequired.join(", ")}`);
  }
  void covered;

  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warnings = checks.filter((c) => c.status === "WARN").length;

  return { environment, checks, passed, failed, warnings, ok: failed === 0, secretValues: secretValuesIn(env) };
}

/**
 * Render a preflight report as console lines. Secret VALUES never appear — only the variable names
 * that the checks already reference by name.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const secretValues = report.secretValues ?? [];
  const lines = report.checks.map((c) => `${c.status.padEnd(4)}  ${redactKnownValues(redactSecrets(c.message), secretValues)}`);
  lines.push("");
  lines.push(`${report.passed} passed, ${report.failed} failed, ${report.warnings} warning(s) — environment '${report.environment}'`);
  lines.push(report.ok ? "STAGING PREFLIGHT: PASS" : "STAGING PREFLIGHT: FAIL");
  return lines.join("\n");
}

/** Names of secret variables, for tooling that must assert it is not about to print one. */
export function secretVariableNames(): string[] {
  return [...SECRET_CONFIG_NAMES];
}

/**
 * Strip the in-memory secret values before a report is written anywhere. Serializing a report
 * without this would defeat the entire point of the value-aware redaction above.
 */
export function preflightReportForSerialization(report: PreflightReport): Omit<PreflightReport, "secretValues"> {
  const secretValues = report.secretValues ?? [];
  return {
    environment: report.environment,
    checks: report.checks.map((c) => ({ ...c, message: redactKnownValues(redactSecrets(c.message), secretValues) })),
    passed: report.passed,
    failed: report.failed,
    warnings: report.warnings,
    ok: report.ok,
  };
}
