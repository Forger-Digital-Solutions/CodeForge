import { inject } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Runs in every worker before each test file: point default-rooted RepositoryIntelligence
// instances at this run's isolated cache root (see repository-index-root.global.ts).
const root = inject("repositoryIndexRoot");
if (root) process.env.CODEFORGE_REPOSITORY_INDEX_ROOT = root;

// Test repositories must be deterministic and must not inherit a developer's line-ending,
// hooks, credential, or excludes configuration. This also prevents inaccessible user-global
// ignore files from producing stderr during otherwise successful Git fixture operations.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_CONFIG_SYSTEM = process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "init.defaultBranch";
process.env.GIT_CONFIG_VALUE_0 = "main";
if (root) {
  const xdgConfigHome = join(root, "xdg");
  mkdirSync(xdgConfigHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
}
