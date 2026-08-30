export * from "./server.js";
export * from "./config.js";
export * from "./staging-contract.js";
export * from "./staging-preflight.js";
export * from "./remote-probe.js";
export * from "./certification-receipt.js";

async function main() {
  const { loadCloudRuntimeConfig, describeConfig } = await import("./config.js");
  const { CodeForgeCloudServer } = await import("./server.js");
  const { CloudFirewallManager, CloudProviderRegistry } = await import("@codeforge/cloud-gateway");

  const config = loadCloudRuntimeConfig(process.env);
  console.log(`[CodeForge Cloud API] config: ${describeConfig(config)}`);

  // The firewall manager owns the operator kill switches + verified-model pool. Build it up front so
  // the same instance backs both the capacity registry (which registers discovered models) and the
  // server (which routes against them).
  const firewallManager = new CloudFirewallManager({ killSwitches: config.killSwitches });

  // Real server-owned hosted capacity: only providers whose credentials are present are attempted.
  const { store, providerIds } = config.providerCredentials;
  const providerRegistry =
    providerIds.length > 0
      ? new CloudProviderRegistry({ firewallManager, credentialStore: store, providerIds })
      : undefined;
  if (providerIds.length === 0) {
    console.warn("[CodeForge Cloud API] no server provider credentials present — Hosted Free will report unavailable until a provider key is configured.");
  }

  const server = new CodeForgeCloudServer({
    host: config.host,
    port: config.port,
    driver: config.database.driver,
    databaseUrl: config.database.url,
    databaseSsl: config.database.ssl,
    dbPath: config.database.path,
    jwtSecret: config.jwtSecret,
    gitHubClientId: config.gitHub.clientId,
    gitHubClientSecret: config.gitHub.clientSecret,
    publicUrl: config.publicUrl,
    stripeConfig: config.stripe,
    firewallManager,
    providerRegistry,
    allowedOrigins: config.allowedOrigins,
    maxRequestsPerMinute: config.rateLimits.maxRequestsPerMinute,
    requestTimeoutMs: config.requestTimeoutMs,
    trustProxy: config.trustProxy,
  });

  const actualPort = await server.start(config.port, config.host);
  console.log(`[CodeForge Cloud API] running on http://${config.host}:${actualPort}`);
  if (providerRegistry) {
    for (const r of providerRegistry.getReports()) {
      console.log(`[CodeForge Cloud API] provider ${r.providerId}: ${r.status} (${r.verifiedFreeCount} verified-free)`);
    }
  }

  const shutdown = async () => {
    console.log("[CodeForge Cloud API] shutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void main();
}
