import { resolve } from "path";
import { defineConfig } from "vitest/config";

const packages = [
  "core",
  "protocol",
  "forge-zero",
  "model-registry",
  "providers",
  "router",
  "agent",
  "director",
  "tools",
  "sessions",
  "context",
  "git",
  "permissions",
  "sandbox",
  "secrets",
  "server",
  "sdk",
  "cli",
  "lsp",
  "mcp",
  "telemetry",
  "gems",
  "benchmark",
  "plugins",
  "ui",
  "shared",
  "vscode",
  "integration-tests",
];

const aliases: Record<string, string | string[]> = {};
for (const pkg of packages) {
  aliases[`@codeforge/${pkg}`] = resolve(__dirname, `packages/${pkg}/src`);
}

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    globals: false,
    testTimeout: 30000,
  },
  resolve: {
    alias: aliases,
  },
});
