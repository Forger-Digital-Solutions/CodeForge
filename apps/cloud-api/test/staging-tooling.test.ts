import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { runStagingPreflight, formatPreflightReport, preflightReportForSerialization } from "../src/staging-preflight.js";
import { STAGING_CONFIG_CONTRACT, SECRET_CONFIG_NAMES, redactSecrets, redactKnownValues, secretValuesIn } from "../src/staging-contract.js";
import { probeRemoteDeployment, formatProbeReport } from "../src/remote-probe.js";
import {
  CERTIFICATION_RECEIPT_SCHEMA_VERSION,
  serializeCertificationReceipt,
  parseCertificationReceipt,
  assertReceiptIsSecretFree,
  ReceiptSecretError,
} from "../src/certification-receipt.js";
import { CodeForgeCloudServer } from "../src/server.js";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";

/**
 * Unit coverage for the staging launch tooling itself.
 *
 * The preflight, the remote probe, and the receipt schema are the instruments the certification
 * process trusts. An instrument that reports PASS when it should not — or that prints a secret it
 * promised to withhold — is worse than no instrument, so each is tested against both a correct input
 * and a deliberately broken one.
 */

// Deliberately fake, syntactically valid credentials. The point of these tests is to prove these
// values never reach an output, so their VALUES are the sentinels being hunted for.
const SENTINEL = {
  DATABASE_URL: "postgresql://cfuser:SUPERSECRETDBPASSWORD@db.example.com:5432/codeforge?sslmode=require",
  JWT_SECRET: "PRODUCTIONJWTSECRETVALUE0123456789abcdef",
  GITHUB_CLIENT_SECRET: "ghs_SENTINELGITHUBCLIENTSECRET0123456789",
  STRIPE_SECRET_KEY: "sk_test_SENTINELSTRIPETESTKEY0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_SENTINELWEBHOOKSECRET0123456789",
  OPENROUTER_API_KEY: "sk-or-v1-SENTINELOPENROUTERKEY0123456789abcd",
};

const COMPLETE_STAGING_ENV: Record<string, string> = {
  NODE_ENV: "production",
  CODEFORGE_CLOUD_ENV: "staging",
  CODEFORGE_PUBLIC_URL: "https://codeforge-cloud.example.com",
  HOST: "0.0.0.0",
  PORT: "3220",
  CODEFORGE_TRUST_PROXY: "true",
  CODEFORGE_CLOUD_DB_DRIVER: "postgres",
  CODEFORGE_CLOUD_DB_SSL: "true",
  GITHUB_CLIENT_ID: "Iv1.notasecret0123",
  ...SENTINEL,
};

describe("staging config contract", () => {
  it("declares every variable exactly once with a requirement level", () => {
    const names = STAGING_CONFIG_CONTRACT.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const variable of STAGING_CONFIG_CONTRACT) {
      expect(["required", "optional", "forbidden"]).toContain(variable.requirement);
      expect(variable.description.length).toBeGreaterThan(10);
    }
  });

  it("marks every credential-bearing variable as secret", () => {
    for (const name of ["DATABASE_URL", "JWT_SECRET", "GITHUB_CLIENT_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OPENROUTER_API_KEY", "GROQ_API_KEY"]) {
      expect(SECRET_CONFIG_NAMES.has(name), `${name} must be marked secret`).toBe(true);
    }
    // Public configuration is deliberately NOT marked secret, so it can appear in reports.
    for (const name of ["CODEFORGE_PUBLIC_URL", "GITHUB_CLIENT_ID", "CODEFORGE_TRUST_PROXY"]) {
      expect(SECRET_CONFIG_NAMES.has(name), `${name} should not be secret`).toBe(false);
    }
  });

  it("redacts every credential SHAPE it claims to", () => {
    const shaped = [
      SENTINEL.DATABASE_URL,
      SENTINEL.STRIPE_SECRET_KEY,
      SENTINEL.STRIPE_WEBHOOK_SECRET,
      SENTINEL.OPENROUTER_API_KEY,
      "ghp_0123456789abcdefghij",
      "github_pat_0123456789abcdefghij",
      "gsk_0123456789abcdefghij",
      "cfr_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    ];
    const redacted = redactSecrets(shaped.join(" "));
    for (const value of shaped) {
      expect(redacted, `shaped credential leaked: ${value.slice(0, 12)}`).not.toContain(value);
    }
    expect(redacted).not.toContain("SUPERSECRETDBPASSWORD");
  });

  it("removes opaque secrets by exact value, since they have no detectable shape", () => {
    // A session signing secret is indistinguishable from any other high-entropy string, so shape
    // matching cannot find it. Value-aware redaction is the only guarantee, and it is available
    // wherever the caller holds the environment the value came from.
    expect(redactSecrets(SENTINEL.JWT_SECRET)).toContain(SENTINEL.JWT_SECRET);

    const env = { ...SENTINEL };
    const redacted = redactKnownValues(`secret is ${SENTINEL.JWT_SECRET} here`, secretValuesIn(env));
    expect(redacted).not.toContain(SENTINEL.JWT_SECRET);
    expect(redacted).toContain("[REDACTED]");

    // Short values are ignored so unrelated text is not mangled.
    expect(redactKnownValues("the cat sat", ["cat"])).toBe("the cat sat");
  });
});

describe("staging preflight", () => {
  it("passes a complete, correct staging environment", () => {
    const report = runStagingPreflight(COMPLETE_STAGING_ENV);
    expect(report.failed, formatPreflightReport(report)).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.environment).toBe("staging");
  });

  it("names the exact GitHub callback URL an operator must register", () => {
    const report = runStagingPreflight(COMPLETE_STAGING_ENV);
    const callback = report.checks.find((c) => c.id === "oauth.callback_url");
    expect(callback?.status).toBe("PASS");
    expect(callback?.message).toContain("https://codeforge-cloud.example.com/v1/auth/github/callback");
  });

  it("NEVER prints a secret value, in any check or in the rendered report", () => {
    const report = runStagingPreflight(COMPLETE_STAGING_ENV);
    const rendered = formatPreflightReport(report);
    const serialized = JSON.stringify(preflightReportForSerialization(report));

    for (const value of Object.values(SENTINEL)) {
      expect(rendered, `rendered report leaked ${value.slice(0, 12)}`).not.toContain(value);
      expect(serialized, `report object leaked ${value.slice(0, 12)}`).not.toContain(value);
    }
    expect(rendered).not.toContain("SUPERSECRETDBPASSWORD");
  });

  it.each([
    ["CODEFORGE_PUBLIC_URL", "public_url.present"],
    ["DATABASE_URL", "db.url_present"],
    ["JWT_SECRET", "session.secret_present"],
    ["GITHUB_CLIENT_ID", "oauth.client_id"],
    ["GITHUB_CLIENT_SECRET", "oauth.client_secret"],
    ["STRIPE_WEBHOOK_SECRET", "stripe.webhook_secret"],
    ["CODEFORGE_TRUST_PROXY", "network.trust_proxy"],
  ])("fails when %s is missing", (variable, expectedCheckId) => {
    const env = { ...COMPLETE_STAGING_ENV };
    delete env[variable];
    const report = runStagingPreflight(env);

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === expectedCheckId)?.status).toBe("FAIL");
  });

  it("fails a live Stripe key regardless of everything else being correct", () => {
    const report = runStagingPreflight({ ...COMPLETE_STAGING_ENV, STRIPE_SECRET_KEY: "sk_live_realmoney0123456789" });
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.id === "stripe.live_key_forbidden" && c.status === "FAIL")).toBe(true);
  });

  it("fails a live key hidden in an unrelated variable", () => {
    const report = runStagingPreflight({ ...COMPLETE_STAGING_ENV, SOME_OTHER_VAR: "rk_live_sneaky0123456789" });
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.id === "stripe.live_key_forbidden" && c.status === "FAIL")).toBe(true);
  });

  it("fails a database URL that weakens TLS", () => {
    const report = runStagingPreflight({
      ...COMPLETE_STAGING_ENV,
      DATABASE_URL: "postgresql://u:p@db.example.com:5432/codeforge?sslmode=disable",
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "db.tls_required")?.status).toBe("FAIL");
  });

  it("fails a non-HTTPS public URL and a wildcard CORS allow-list", () => {
    expect(runStagingPreflight({ ...COMPLETE_STAGING_ENV, CODEFORGE_PUBLIC_URL: "http://cloud.example.com" }).ok).toBe(false);
    expect(runStagingPreflight({ ...COMPLETE_STAGING_ENV, CODEFORGE_ALLOWED_ORIGINS: "*" }).ok).toBe(false);
  });

  it("fails a placeholder or short session secret", () => {
    expect(runStagingPreflight({ ...COMPLETE_STAGING_ENV, JWT_SECRET: "short" }).ok).toBe(false);
    expect(runStagingPreflight({ ...COMPLETE_STAGING_ENV, JWT_SECRET: "codeforge-cloud-test-jwt-secret-key-32chars" }).ok).toBe(false);
  });

  it("fails a development environment (a preflight is for a deployment, not a laptop)", () => {
    const report = runStagingPreflight({});
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "env.tier")?.status).toBe("FAIL");
  });

  it("reports missing hosted capacity rather than silently passing", () => {
    const env = { ...COMPLETE_STAGING_ENV };
    delete env.OPENROUTER_API_KEY;
    const report = runStagingPreflight(env);
    expect(report.checks.find((c) => c.id === "capacity.provider_credential")?.status).toBe("FAIL");
  });
});

describe("remote deployment probe", () => {
  class ProbeProvider implements ProviderAdapter {
    readonly providerId = "probe-free";
    readonly isTestProvider = true;
    async *streamChat(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "finish", finishReason: "stop" };
    }
    async healthCheck() {
      return { status: "available" as const };
    }
    async listModels() {
      return [];
    }
    async chat() {
      return { id: "1", model: "m", choices: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
  }

  let server: CodeForgeCloudServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      db: new CloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: "remote-probe-cert-jwt-secret-32-characters",
    });
    server.firewallManager.registerModel(createGenericFreeRecord({ providerId: "probe-free", modelId: "probe-model" }));
    server.firewallManager.registerProvider(new ProbeProvider());
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("passes against a correctly configured deployment", async () => {
    const report = await probeRemoteDeployment(baseUrl, { allowInsecure: true });
    const rendered = formatProbeReport(report);
    expect(report.failed, rendered).toBe(0);
    expect(report.ok).toBe(true);
  });

  it("verifies health, readiness, auth enforcement, OAuth readiness, and open-redirect refusal", async () => {
    const report = await probeRemoteDeployment(baseUrl, { allowInsecure: true });
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    expect(byId.get("health.live")?.status).toBe("PASS");
    expect(byId.get("health.ready")?.status).toBe("PASS");
    expect(byId.get("auth.required/v1/account")?.status).toBe("PASS");
    expect(byId.get("auth.required/v1/usage")?.status).toBe("PASS");
    expect(byId.get("auth.forged_token")?.status).toBe("PASS");
    expect(byId.get("oauth.ready")?.status).toBe("PASS");
    expect(byId.get("oauth.no_verifier_leak")?.status).toBe("PASS");
    expect(byId.get("oauth.open_redirect")?.status).toBe("PASS");
    expect(byId.get("cors.untrusted_origin")?.status).toBe("PASS");
    expect(byId.get("limits.payload")?.status).toBe("PASS");
    expect(byId.get("errors.normalized")?.status).toBe("PASS");
    expect(byId.get("sse.auth_required")?.status).toBe("PASS");
    expect(byId.get("security.header.x-content-type-options")?.status).toBe("PASS");
  });

  it("REFUSES a plain-http target unless explicitly allowed", async () => {
    const report = await probeRemoteDeployment(baseUrl);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "target.https")?.status).toBe("FAIL");
  });

  it("reports a DNS failure rather than a generic error", async () => {
    const report = await probeRemoteDeployment("https://codeforge-probe-does-not-exist.invalid");
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.id === "target.dns" && c.status === "FAIL")).toBe(true);
  });

  it("detects a secret leaked in a response body, without echoing it", async () => {
    // A deployment that leaks a provider key in its metadata response.
    const leaked = "sk-or-v1-LEAKEDPROVIDERKEY0123456789abcdef";
    const leakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (href.includes("/v1/meta")) {
        return new Response(JSON.stringify({ apiVersion: "1.0.0", providerKey: leaked }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fetch(input as never, init);
    }) as typeof fetch;

    const report = await probeRemoteDeployment(baseUrl, { allowInsecure: true, fetchFn: leakyFetch });
    expect(report.ok).toBe(false);
    const leakCheck = report.checks.find((c) => c.id === "leak.meta");
    expect(leakCheck?.status).toBe("FAIL");
    // The finding is reported; the secret itself is not.
    expect(JSON.stringify(report)).not.toContain(leaked);
    expect(formatProbeReport(report)).not.toContain(leaked);
  });

  it("produces a JSON receipt containing no secrets", async () => {
    const report = await probeRemoteDeployment(baseUrl, { allowInsecure: true });
    const json = JSON.stringify(report);
    for (const value of Object.values(SENTINEL)) {
      expect(json).not.toContain(value);
    }
    expect(report.schemaVersion).toBe("1.0.0");
    expect(typeof report.timestamp).toBe("string");
  });
});

describe("certification receipt schema", () => {
  const validReceipt = {
    schemaVersion: CERTIFICATION_RECEIPT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    gitSha: "4d50239229a2cd1b61715fe45097b9d2e04100c2",
    cloudEnvironment: "staging" as const,
    databaseEngine: "postgres" as const,
    databaseTls: true,
    oauthFlow: "server-brokered-github-pkce" as const,
    oauthCallbackUrl: "https://cloud.example.com/v1/auth/github/callback",
    ownerCashUsd: 0,
    verdict: "CODEFORGE_CLOUD_STAGING_LAUNCH_READY_EXTERNAL_RESOURCES_REQUIRED" as const,
    stages: [{ id: "preflight", status: "PASS" as const, detail: "all checks passed" }],
  };

  it("round-trips a valid receipt", () => {
    const json = serializeCertificationReceipt(validReceipt);
    const parsed = parseCertificationReceipt(json);
    expect(parsed.gitSha).toBe(validReceipt.gitSha);
    expect(parsed.verdict).toBe(validReceipt.verdict);
    expect(parsed.ownerCashUsd).toBe(0);
  });

  it("rejects an unknown schema version and an invalid verdict", () => {
    expect(() => serializeCertificationReceipt({ ...validReceipt, schemaVersion: "9.9.9" })).toThrow();
    expect(() => serializeCertificationReceipt({ ...validReceipt, verdict: "TOTALLY_CERTIFIED" })).toThrow();
  });

  it("REFUSES a receipt with a field that could hold a credential", () => {
    for (const field of ["accessToken", "refreshToken", "codeVerifier", "clientSecret", "apiKey", "databaseUrl", "password", "prompt", "messages"]) {
      expect(() => serializeCertificationReceipt({ ...validReceipt, [field]: "anything" }), `field ${field}`).toThrow();
    }
  });

  it("REFUSES a receipt whose free text contains credential-shaped material", () => {
    const shaped = [SENTINEL.DATABASE_URL, SENTINEL.STRIPE_SECRET_KEY, SENTINEL.STRIPE_WEBHOOK_SECRET, SENTINEL.OPENROUTER_API_KEY];
    for (const leaked of shaped) {
      expect(
        () => assertReceiptIsSecretFree({ ...validReceipt, stages: [{ id: "x", status: "PASS", detail: `saw ${leaked}` }] }),
        `leaked ${leaked.slice(0, 12)}`,
      ).toThrow(ReceiptSecretError);
    }
  });

  it("redacts credential-shaped stage detail rather than emitting it", () => {
    // Serialization applies redaction before the final scan, so a near-miss is cleaned up instead of
    // aborting the whole certification run.
    const json = serializeCertificationReceipt({
      ...validReceipt,
      stages: [{ id: "oauth", status: "PASS", detail: "session refresh token cfr_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rotated" }],
    });
    expect(json).not.toContain("cfr_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(json).toContain("[REDACTED_REFRESH_TOKEN]");
  });

  it("accepts a receipt carrying non-secret evidence", () => {
    const json = serializeCertificationReceipt({
      ...validReceipt,
      dockerImageDigest: "sha256:a895d07e79d8551bad0bbb114c63ba08b200d81d3217ae7b0590410a4c398c29",
      desktopPackageSha256: "3140792624045F77B04BE7FAEF9077BE2DD9C315068B741EBDEA743B0474C562",
      provider: "openrouter",
      model: "some-model:free",
      verifiedFree: true,
      requestId: randomUUID(),
      providerCostUsd: 0,
      creditBefore: 500_000,
      creditAfter: 499_988,
      sseFirstEventMs: 120,
      sseTerminalEventMs: 940,
      twoClientConcurrencyResult: "PASS" as const,
      directByokOutageResult: "PASS" as const,
      securityResult: "PASS" as const,
    });
    const parsed = parseCertificationReceipt(json);
    expect(parsed.verifiedFree).toBe(true);
    expect(parsed.providerCostUsd).toBe(0);
    expect(parsed.sseFirstEventMs! < parsed.sseTerminalEventMs!).toBe(true);
  });

  it("requires owner cash to be present and non-negative", () => {
    expect(() => serializeCertificationReceipt({ ...validReceipt, ownerCashUsd: undefined })).toThrow();
    expect(() => serializeCertificationReceipt({ ...validReceipt, ownerCashUsd: -1 })).toThrow();
  });
});
