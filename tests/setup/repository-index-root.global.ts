import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GlobalSetupContext } from "vitest/node";

/**
 * One repository-index cache root per test run.
 *
 * Every RepositoryIntelligence created without an explicit cacheRoot resolves to
 * CODEFORGE_REPOSITORY_INDEX_ROOT (packages/repo-intelligence engine.ts). Before this setup the
 * suite fell through to the user's real profile cache (%LOCALAPPDATA%\CodeForge) and to a
 * shared, never-cleaned temp directory: parallel workers raced on the same parent directory
 * (Windows EPERM on mkdir) and every run left its index databases behind. The root is created
 * once here, handed to each worker through `provide`, and removed after the run.
 */
export default function setup({ provide }: GlobalSetupContext): () => void {
  const preset = process.env.CODEFORGE_REPOSITORY_INDEX_ROOT?.trim();
  const root = preset || fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-vitest-repository-indexes-"));
  process.env.CODEFORGE_REPOSITORY_INDEX_ROOT = root;
  provide("repositoryIndexRoot", root);
  return () => {
    if (preset) return;
    try {
      // Bounded retries absorb the Windows delete-pending window left by a worker that was still
      // closing an index database when the run ended.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.warn(`[vitest] repository index root not removed (${root}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    repositoryIndexRoot: string;
  }
}
