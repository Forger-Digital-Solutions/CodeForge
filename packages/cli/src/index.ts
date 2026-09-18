#!/usr/bin/env node
import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, generateControlPlaneToken } from "@codeforge/server";

const VERSION = "0.3.0";

function printHelp(): void {
  console.log(`forge ${VERSION} — CodeForge CLI

Usage:
  forge version              Show version
  forge serve [--port=N]     Start the CodeForge server (default port 3210)

Environment:
  CODEFORGE_REAL_RUNTIME     Set to "true" for real provider inference (default: demo)
  See .env.example for additional variables.
`);
}

function parsePort(args: string[]): number {
  const portArg = args.find((arg) => arg.startsWith("--port="));
  if (!portArg) return 3210;
  const parsed = Number.parseInt(portArg.slice("--port=".length), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${portArg}`);
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const [, , command, ...rest] = argv;

  if (!command || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return 0;
  }

  if (command === "version" || command === "-v" || command === "--version") {
    console.log(`forge ${VERSION}`);
    return 0;
  }

  if (command === "serve") {
    let port: number;
    try {
      port = parsePort(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const dataDir = path.join(os.homedir(), ".codeforge");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "codeforge.db");

    // The loopback control plane is never unauthenticated in a product entry point: every client
    // (including a local browser page) must present this per-process bearer. It is written to a
    // 0600 file in the data directory so local tooling owned by the same OS user can read it; it is
    // never accepted from a URL and never logged.
    const controlPlaneToken = process.env.CODEFORGE_LOCAL_CONTROL_TOKEN?.trim() || generateControlPlaneToken();
    const tokenPath = path.join(dataDir, "control-token");
    writeFileSync(tokenPath, controlPlaneToken, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch { /* Windows ignores POSIX modes; profile ACLs apply */ }

    const server = createServer({ port, dbPath, controlPlaneToken });
    await server.start();
    console.log(`CodeForge server running at http://localhost:${port}`);
    console.log(`Persistence: ${dbPath}`);
    console.log(`Control-plane bearer: ${tokenPath} (send it as X-CodeForge-Control-Token)`);

    const cleanup = () => { try { unlinkSync(tokenPath); } catch { /* already gone */ } };
    process.once("SIGINT", () => { cleanup(); process.exit(130); });
    process.once("SIGTERM", () => { cleanup(); process.exit(143); });

    await new Promise<void>(() => {});
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  return 1;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
