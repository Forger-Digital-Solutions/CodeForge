/**
 * Local CodeForge Cloud API for the zero-setup R1 certification rig.
 *
 * Boots the REAL production cloud server (CodeForgeCloudServer + CloudFirewallManager +
 * EntitlementService + UsageEngine + SQLite ledger) with two local doubles and nothing else:
 *   1. the GitHub identity provider (scripts/dev-cert/dev-idp.mjs) via the config endpoint
 *      overrides — no GitHub OAuth App exists on a dev machine;
 *   2. the "devpool" fixture managed provider (scripts/dev-cert/fixture-provider.mjs) via the
 *      direct fixture registration — no legitimately shareable upstream free capacity exists on a
 *      dev machine. It is not part of the reviewed managed-free inventory.
 *
 * Everything between those two doubles — auth, PKCE, JWT, entitlement, per-user allowance,
 * reservation/settlement, ForgeZero verification, 8-Bit qualification, hosted routing, usage
 * summary — is production code running in this process.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeForgeCloudServer, describeConfig, loadCloudRuntimeConfig } from "codeforge-cloud-api";
import { configureGitHubEndpoints } from "@codeforge/cloud-auth";
import { CloudFirewallManager } from "@codeforge/cloud-gateway";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { createFixtureManagedAdapter, FIXTURE_MODEL_ID, FIXTURE_PROVIDER_ID } from "./fixture-provider.mjs";

const CERT_DIR = process.env.DEV_CERT_DIR ?? mkdtempSync(join(tmpdir(), "codeforge-dev-cert-"));
const PORT = Number(process.env.DEV_CLOUD_PORT ?? 3220);
const IDP_PORT = Number(process.env.DEV_IDP_PORT ?? 3340);

process.env.CODEFORGE_CLOUD_ENV = process.env.CODEFORGE_CLOUD_ENV ?? "development";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.CODEFORGE_CLOUD_DB_DRIVER = "sqlite";
process.env.CODEFORGE_CLOUD_DB_PATH = process.env.CODEFORGE_CLOUD_DB_PATH ?? join(CERT_DIR, "cloud.sqlite");
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "codeforge-dev-cert-jwt-secret-0123456789abcdef";
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "codeforge-dev-cert-client";
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "codeforge-dev-cert-client-secret";
process.env.GITHUB_OAUTH_AUTHORIZE_URL = `http://127.0.0.1:${IDP_PORT}/login/oauth/authorize`;
process.env.GITHUB_OAUTH_TOKEN_URL = `http://127.0.0.1:${IDP_PORT}/login/oauth/access_token`;
process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${IDP_PORT}`;
process.env.CODEFORGE_PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.CODEFORGE_ALLOWED_BROWSER_RETURN_URLS = process.env.CODEFORGE_ALLOWED_BROWSER_RETURN_URLS ?? "http://localhost:5173,http://127.0.0.1:5173";

const config = loadCloudRuntimeConfig(process.env);
console.log(`[dev-cloud] config: ${describeConfig(config)}`);

if (config.gitHub.endpointOverrides) {
  configureGitHubEndpoints(config.gitHub.endpointOverrides, { productionLike: false });
  console.log("[dev-cloud] GitHub IdP endpoint overrides applied (dev double)");
}

const firewallManager = new CloudFirewallManager({ killSwitches: config.killSwitches });
const fixtureAdapter = createFixtureManagedAdapter();
firewallManager.registerProvider(fixtureAdapter);
firewallManager.registerModel(createGenericFreeRecord({ providerId: FIXTURE_PROVIDER_ID, modelId: FIXTURE_MODEL_ID }));

const server = new CodeForgeCloudServer({
  host: config.host,
  port: config.port,
  driver: "sqlite",
  dbPath: config.database.path,
  jwtSecret: config.jwtSecret,
  gitHubClientId: config.gitHub.clientId,
  gitHubClientSecret: config.gitHub.clientSecret,
  publicUrl: config.publicUrl,
  allowedBrowserReturnUrls: config.allowedBrowserReturnUrls,
  firewallManager,
  allowedOrigins: config.allowedOrigins,
  maxRequestsPerMinute: config.rateLimits.maxRequestsPerMinute,
  requestTimeoutMs: config.requestTimeoutMs,
});

const actualPort = await server.start(config.port, config.host);
console.log(`[dev-cloud] running on http://127.0.0.1:${actualPort}`);
console.log(`[dev-cloud] db at ${config.database.path}`);

console.log(`[dev-cloud] deterministic fixture ${FIXTURE_PROVIDER_ID} registered for A/B allowance certification`);

const shutdown = async () => {
  console.log("[dev-cloud] shutting down...");
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
