import { describe, it, expect } from "vitest";
import { loadCloudRuntimeConfig, CloudConfigError, describeConfig } from "../src/config.js";

const prodBase = {
  CODEFORGE_CLOUD_ENV: "production",
  JWT_SECRET: "a-really-long-production-secret-key-of-32+chars",
  GITHUB_CLIENT_ID: "gh_prod_id",
  GITHUB_CLIENT_SECRET: "gh_prod_secret",
  STRIPE_SECRET_KEY: "sk_test_prod",
  STRIPE_WEBHOOK_SECRET: "whsec_prod",
  CODEFORGE_CLOUD_DB_DRIVER: "postgres",
  DATABASE_URL: "postgres://user:pass@host:5432/db",
};

describe("loadCloudRuntimeConfig", () => {
  it("loads a valid development config with safe defaults", () => {
    const config = loadCloudRuntimeConfig({});
    expect(config.environment).toBe("development");
    expect(config.database.driver).toBe("sqlite");
    expect(config.killSwitches.hostedInferenceEnabled).toBe(true);
    expect(config.killSwitches.globalDailySpendLimitUsd).toBe(1000);
    expect(config.jwtSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("REFUSES live Stripe keys (test-mode only)", () => {
    expect(() => loadCloudRuntimeConfig({ STRIPE_SECRET_KEY: "sk_live_dangerous" })).toThrow(CloudConfigError);
    expect(() => loadCloudRuntimeConfig({ STRIPE_SECRET_KEY: "rk_live_dangerous" })).toThrow(/TEST MODE only/);
  });

  it("refuses an ephemeral :memory: SQLite database in production", () => {
    expect(() =>
      loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_CLOUD_DB_DRIVER: "sqlite", DATABASE_URL: undefined, CODEFORGE_CLOUD_DB_PATH: ":memory:" }),
    ).toThrow(/persistent/);
  });

  it("requires DATABASE_URL for the postgres driver", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("requires a strong JWT secret in production", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
  });

  it("requires GitHub OAuth credentials in production", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, GITHUB_CLIENT_SECRET: undefined })).toThrow(/GITHUB_CLIENT/);
  });

  it("requires Stripe test credentials in production", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, STRIPE_WEBHOOK_SECRET: undefined })).toThrow(/STRIPE/);
  });

  it("accepts a complete production configuration", () => {
    const config = loadCloudRuntimeConfig(prodBase);
    expect(config.environment).toBe("production");
    expect(config.database.driver).toBe("postgres");
    expect(config.database.url).toContain("postgres://");
    expect(config.gitHub.clientId).toBe("gh_prod_id");
  });

  it("honors operator kill-switch and spend-limit overrides", () => {
    const config = loadCloudRuntimeConfig({
      CODEFORGE_HOSTED_FREE_ENABLED: "false",
      CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD: "0.05",
      CODEFORGE_MAX_REQUESTS_PER_MINUTE: "30",
      CODEFORGE_REQUEST_TIMEOUT_MS: "45000",
    });
    expect(config.killSwitches.hostedFreeEnabled).toBe(false);
    expect(config.killSwitches.globalDailySpendLimitUsd).toBe(0.05);
    expect(config.rateLimits.maxRequestsPerMinute).toBe(30);
    expect(config.requestTimeoutMs).toBe(45000);
  });

  it("resolves server provider credentials from env", () => {
    const config = loadCloudRuntimeConfig({ OPENROUTER_API_KEY: "or", GROQ_API_KEY: "gq" });
    expect(config.providerCredentials.providerIds.sort()).toEqual(["groq", "openrouter"]);
  });

  it("produces a redacted, secret-free startup summary", () => {
    const summary = describeConfig(loadCloudRuntimeConfig({ ...prodBase, OPENROUTER_API_KEY: "or-secret-value" }));
    expect(summary).toContain("env=production");
    expect(summary).toContain("db=postgres");
    expect(summary).toContain("providers=[openrouter]");
    expect(summary).not.toContain("or-secret-value");
    expect(summary).not.toContain("postgres://");
  });
});
