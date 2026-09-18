import { availableParallelism } from "node:os";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

const packages = [
  "core",
  "protocol",
  "forge-zero",
  "model-registry",
  "providers",
  "paid-auto",
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
  "forgegreen-campaign",
  "cloud-db",
  "cloud-auth",
  "cloud-entitlements",
  "cloud-usage",
  "cloud-billing",
  "cloud-gateway",
  "legal-policy",
  "crypto",
];

const aliases: Record<string, string | string[]> = {};
for (const pkg of packages) {
  aliases[`@codeforge/${pkg}`] = resolve(import.meta.dirname, `packages/${pkg}/src`);
}
aliases["codeforge-cloud-api"] = resolve(import.meta.dirname, "apps/cloud-api/src");

// Real-process integration suites (git worktrees, bare remotes, spawned verification commands,
// sqlite) saturate a Windows host when every logical CPU runs a worker: measured on a 12-CPU
// host, the long CF-08/CF-10C/CF-11 and workflow-cap tests ran 2–3× slower than in isolation and
// overran their budgets (R4). Half the logical CPUs keeps them at ≥2× headroom for ~40% more
// wall time; other platforms keep Vitest's default.
const windowsWorkerBound = process.platform === "win32" ? Math.max(2, Math.floor(availableParallelism() / 2)) : undefined;

export default defineConfig({
  test: {
    ...(windowsWorkerBound ? { minWorkers: 1, maxWorkers: windowsWorkerBound } : {}),
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    exclude: [
      // Certification archives preserve intentionally failing fixture repositories. They are
      // evidence, not part of the active source test suite.
      "tests/evidence/**",
      // VS Code test-electron tests must run separately (require real VS Code instance)
      "packages/vscode/src/test/**/*",
      "packages/vscode/test/suite/**/*",
    ],
    globals: false,
    // One isolated repository-index cache root per run (see tests/setup/repository-index-root.*):
    // default-rooted RepositoryIntelligence instances otherwise shared the user's real profile
    // cache and raced on it across workers (Windows EPERM on mkdir).
    globalSetup: ["./tests/setup/repository-index-root.global.ts"],
    setupFiles: ["./tests/setup/repository-index-root.ts"],
    testTimeout: 30000,
    // Spawned-process hooks (real server fixtures) can exceed the 10s default while a cold
    // machine or a cold WSL2 PostgreSQL host boots underneath them; the assertions are unchanged.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: aliases,
  },
});
