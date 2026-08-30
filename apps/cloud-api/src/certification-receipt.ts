import { z } from "zod";
import { redactSecrets } from "./staging-contract.js";

/**
 * Machine-readable certification evidence.
 *
 * A receipt is the artifact a certification run leaves behind: enough detail to audit what was
 * actually proven, and deliberately nothing that could be replayed or spent. The schema is versioned
 * and validated on write, so a receipt that would carry a credential fails to serialize rather than
 * silently shipping one.
 *
 * FORBIDDEN by construction (see {@link assertReceiptIsSecretFree}): OAuth codes, access tokens,
 * refresh tokens, provider API keys, database passwords, session secrets, raw prompts, raw
 * repository code.
 */
export const CERTIFICATION_RECEIPT_SCHEMA_VERSION = "1.0.0";

export const CertificationStageResultSchema = z.object({
  /** Stable stage id, e.g. "oauth.real_login". */
  id: z.string().min(1),
  status: z.enum(["PASS", "FAIL", "SKIP", "BLOCKED"]),
  /** Short human-readable outcome. Redacted on write. */
  detail: z.string().max(2000).optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type CertificationStageResult = z.infer<typeof CertificationStageResultSchema>;

export const CertificationReceiptSchema = z.object({
  schemaVersion: z.literal(CERTIFICATION_RECEIPT_SCHEMA_VERSION),
  timestamp: z.string().datetime(),

  // --- Provenance ---------------------------------------------------------------------------
  gitSha: z.string().regex(/^[0-9a-f]{7,40}$/, "gitSha must be a hex commit id"),
  dockerImageDigest: z.string().optional(),
  desktopPackageSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

  // --- Target -------------------------------------------------------------------------------
  /** Origin only — never a URL with credentials or a query string. */
  cloudUrl: z.string().url().optional(),
  cloudEnvironment: z.enum(["development", "staging", "production"]),
  databaseEngine: z.enum(["postgres", "sqlite"]),
  databaseTls: z.boolean(),

  // --- Authentication -------------------------------------------------------------------------
  oauthFlow: z.enum(["server-brokered-github-pkce", "none"]),
  /** The URL registered with GitHub. Public configuration, not a secret. */
  oauthCallbackUrl: z.string().url().optional(),

  // --- Inference ------------------------------------------------------------------------------
  provider: z.string().optional(),
  model: z.string().optional(),
  verifiedFree: z.boolean().optional(),
  requestId: z.string().optional(),
  reservationId: z.string().optional(),
  usageId: z.string().optional(),
  providerCostUsd: z.number().nonnegative().optional(),
  creditBefore: z.number().optional(),
  creditAfter: z.number().optional(),
  sseFirstEventMs: z.number().nonnegative().optional(),
  sseTerminalEventMs: z.number().nonnegative().optional(),

  // --- Invariant outcomes ----------------------------------------------------------------------
  twoClientConcurrencyResult: z.enum(["PASS", "FAIL", "SKIP", "BLOCKED"]).optional(),
  directByokOutageResult: z.enum(["PASS", "FAIL", "SKIP", "BLOCKED"]).optional(),
  securityResult: z.enum(["PASS", "FAIL", "SKIP", "BLOCKED"]).optional(),

  // --- Run metadata -----------------------------------------------------------------------------
  ciRun: z.string().optional(),
  ownerCashUsd: z.number().nonnegative(),
  stages: z.array(CertificationStageResultSchema).default([]),
  verdict: z.enum([
    "CODEFORGE_CLOUD_REMOTE_ZERO_SETUP_CERTIFIED",
    "CODEFORGE_CLOUD_STAGING_LAUNCH_READY_EXTERNAL_RESOURCES_REQUIRED",
    "CODEFORGE_CLOUD_STAGING_LAUNCH_NOT_READY",
    "CODEFORGE_CLOUD_STAGING_CERTIFICATION_FAILED",
  ]),
});
export type CertificationReceipt = z.infer<typeof CertificationReceiptSchema>;

/**
 * Field names that must never appear anywhere in a receipt, at any depth. Presence of the KEY is the
 * failure — the receipt should not have a place to put a credential in the first place.
 */
export const FORBIDDEN_RECEIPT_KEYS: readonly string[] = [
  "accessToken",
  "refreshToken",
  "code",
  "codeVerifier",
  "codeChallenge",
  "clientSecret",
  "apiKey",
  "providerKey",
  "databaseUrl",
  "connectionString",
  "password",
  "jwtSecret",
  "sessionSecret",
  "prompt",
  "messages",
  "sourceCode",
];

/** Value patterns that indicate a real credential leaked into a receipt field. */
const FORBIDDEN_RECEIPT_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(sk|rk)_(live|test)_[A-Za-z0-9_]{8,}/,
  /\bwhsec_[A-Za-z0-9_]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-or-[A-Za-z0-9-]{16,}/,
  /\bgsk_[A-Za-z0-9]{16,}/,
  /\bcfr_[A-Za-z0-9_-]{16,}/,
  /\bcfa_[A-Za-z0-9_-]{16,}/,
  /\b(postgres|postgresql):\/\/[^\s"']*:[^\s"'@]*@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export class ReceiptSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptSecretError";
  }
}

/**
 * Reject a receipt that has a SLOT for a credential, anywhere in the object graph.
 *
 * A forbidden key is a design error, not an accident of formatting: it means the certification code
 * intended to record a credential. That is never scrubbed away silently — it fails.
 *
 * @throws {ReceiptSecretError} on the first violation found.
 */
export function assertNoForbiddenReceiptKeys(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenReceiptKeys(item, `${path}[${i}]`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RECEIPT_KEYS.includes(key)) {
      throw new ReceiptSecretError(`Certification receipt must not contain the field '${key}' (at ${path})`);
    }
    assertNoForbiddenReceiptKeys(child, `${path}.${key}`);
  }
}

/**
 * Reject a receipt that carries — or even has a slot for — a credential. Runs over the whole object
 * graph, so a nested `detail` string with a leaked token is caught just as a top-level field is.
 *
 * This is the FINAL gate, applied after redaction: at that point any remaining credential-shaped
 * material is something redaction could not handle, and the receipt must not be written.
 *
 * @throws {ReceiptSecretError} on the first violation found.
 */
export function assertReceiptIsSecretFree(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    for (const pattern of FORBIDDEN_RECEIPT_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new ReceiptSecretError(`Certification receipt contains credential-shaped material at ${path}`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertReceiptIsSecretFree(item, `${path}[${i}]`));
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_RECEIPT_KEYS.includes(key)) {
        throw new ReceiptSecretError(`Certification receipt must not contain the field '${key}' (at ${path})`);
      }
      assertReceiptIsSecretFree(child, `${path}.${key}`);
    }
  }
}

/**
 * Validate, redact, and serialize a receipt. This is the ONLY supported way to write one: it applies
 * schema validation, then defense-in-depth redaction of free-text fields, then a final secret scan of
 * the serialized result.
 */
export function serializeCertificationReceipt(receipt: unknown): string {
  // Check forbidden KEYS on the RAW input. Schema parsing strips unknown keys, so a caller that
  // attached `accessToken` would otherwise have it silently dropped and the receipt would validate —
  // hiding the fact that the certification code tried to record a credential at all.
  assertNoForbiddenReceiptKeys(receipt);

  const parsed = CertificationReceiptSchema.parse(receipt);

  const redacted: CertificationReceipt = {
    ...parsed,
    stages: parsed.stages.map((s) => ({ ...s, detail: s.detail ? redactSecrets(s.detail) : undefined })),
  };

  assertReceiptIsSecretFree(redacted);
  const json = JSON.stringify(redacted, null, 2);

  // Final belt-and-braces pass over the exact bytes that will hit disk.
  for (const pattern of FORBIDDEN_RECEIPT_VALUE_PATTERNS) {
    if (pattern.test(json)) {
      throw new ReceiptSecretError("Serialized certification receipt contains credential-shaped material");
    }
  }
  return json;
}

/** Parse and validate a receipt produced elsewhere (e.g. downloaded from a CI artifact). */
export function parseCertificationReceipt(json: string): CertificationReceipt {
  return CertificationReceiptSchema.parse(JSON.parse(json));
}
