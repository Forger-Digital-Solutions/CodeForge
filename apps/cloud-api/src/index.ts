export * from "./server.js";

async function main() {
  const host = process.env.HOST || "127.0.0.1";
  const port = parseInt(process.env.PORT || "3220", 10);
  const driver = (process.env.CODEFORGE_CLOUD_DB_DRIVER as "sqlite" | "postgres") || "sqlite";

  const { CodeForgeCloudServer } = await import("./server.js");
  const server = new CodeForgeCloudServer({
    host,
    port,
    driver,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    gitHubClientId: process.env.GITHUB_CLIENT_ID,
    gitHubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  });

  const actualPort = await server.start(port, host);
  console.log(`[CodeForge Cloud API] running on http://${host}:${actualPort}`);

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
