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
  CODEFORGE_PUBLIC_URL: "https://cloud.codeforge.test",
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

  it("does not require Stripe for the production Hosted Free path", () => {
    const config = loadCloudRuntimeConfig({ ...prodBase, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
    expect(config.stripe).toBeUndefined();
  });

  it("requires a complete Stripe TEST-mode configuration when billing is enabled", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, STRIPE_WEBHOOK_SECRET: undefined })).toThrow(/both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, STRIPE_SECRET_KEY: "sk_not_test" })).toThrow(/TEST-mode/);
  });

  it("requires a valid public HTTPS URL in staging/production", () => {
    // GitHub redirects to `${publicUrl}/v1/auth/github/callback`, so a deployment without it can
    // never complete a login — that has to fail at boot, not at first sign-in.
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: undefined })).toThrow(/CODEFORGE_PUBLIC_URL/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "not-a-url" })).toThrow(/absolute URL/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "http://cloud.example.com" })).toThrow(/HTTPS/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "https://u:p@cloud.example.com" })).toThrow(/credentials/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "https://cloud.example.com/?x=1" })).toThrow(/query string/);

    // Trailing slashes are normalized away so the derived callback URL is stable.
    expect(loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "https://cloud.example.com/" }).publicUrl).toBe("https://cloud.example.com");
  });

  it("uses Render's runtime-assigned HTTPS URL without predicting a hostname", () => {
    const config = loadCloudRuntimeConfig({
      ...prodBase,
      CODEFORGE_PUBLIC_URL: undefined,
      RENDER_EXTERNAL_URL: "https://actual-render-host.onrender.com",
    });
    expect(config.publicUrl).toBe("https://actual-render-host.onrender.com");
  });

  it("permits a plain-http loopback public URL only outside staging/production", () => {
    expect(loadCloudRuntimeConfig({ CODEFORGE_PUBLIC_URL: "http://127.0.0.1:3220" }).publicUrl).toBe("http://127.0.0.1:3220");
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_PUBLIC_URL: "http://127.0.0.1:3220" })).toThrow(/HTTPS/);
  });

  it("accepts a complete production configuration", () => {
    const config = loadCloudRuntimeConfig(prodBase);
    expect(config.environment).toBe("production");
    expect(config.database.driver).toBe("postgres");
    expect(config.database.url).toContain("postgres://");
    expect(config.database.ssl).toBe(true);
    expect(config.gitHub.clientId).toBe("gh_prod_id");
  });

  it("requires certificate-validated TLS for remote PostgreSQL in staging and production", () => {
    expect(() => loadCloudRuntimeConfig({ ...prodBase, CODEFORGE_CLOUD_DB_SSL: "false" })).toThrow(/requires CODEFORGE_CLOUD_DB_SSL=true/);
    expect(() => loadCloudRuntimeConfig({ ...prodBase, DATABASE_URL: "postgres://user:pass@host:5432/db?sslmode=disable" })).toThrow(/must not disable or weaken TLS/);
  });

  it("allows an explicitly local PostgreSQL development connection without TLS", () => {
    const config = loadCloudRuntimeConfig({
      CODEFORGE_CLOUD_DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/codeforge",
    });
    expect(config.database.ssl).toBe(false);
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

  it("requires an explicit boolean when proxy trust is configured", () => {
    expect(() => loadCloudRuntimeConfig({ CODEFORGE_TRUST_PROXY: "maybe" })).toThrow(/CODEFORGE_TRUST_PROXY/);
    expect(loadCloudRuntimeConfig({ CODEFORGE_TRUST_PROXY: "true" }).trustProxy).toBe(true);
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
