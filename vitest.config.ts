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
  "repo-intelligence",
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
  "workflow",
  "cloud-db",
  "cloud-auth",
  "cloud-entitlements",
  "cloud-usage",
  "cloud-billing",
  "cloud-gateway",
];

const aliases: Record<string, string | string[]> = {};
for (const pkg of packages) {
  aliases[`@codeforge/${pkg}`] = resolve(__dirname, `packages/${pkg}/src`);
}
aliases["codeforge-cloud-api"] = resolve(__dirname, "apps/cloud-api/src");

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: [
      // VS Code test-electron tests must run separately (require real VS Code instance)
      "packages/vscode/src/test/**/*",
      "packages/vscode/test/suite/**/*",
    ],
    globals: false,
    testTimeout: 30000,
  },
  resolve: {
    alias: aliases,
  },
});
