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
  "eight-bit",
  "forge-green",
  "cloud-db",
  "cloud-auth",
  "cloud-entitlements",
  "cloud-usage",
  "cloud-billing",
  "cloud-gateway",
  "legal-policy",
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
      // 8-Bit qualification fixtures are sample repositories the harness evaluates models
      // against; their *.test.ts files are fixture content (Jest-style globals), not suites.
      "tests/evidence/qualification-fixtures/**/*",
    ],
    globals: false,
    testTimeout: 30000,
    // Spawned-process hooks (real server fixtures) can exceed the 10s default while a cold
    // machine or a cold WSL2 PostgreSQL host boots underneath them; the assertions are unchanged.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: aliases,
  },
});
