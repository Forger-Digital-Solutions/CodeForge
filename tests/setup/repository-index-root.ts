import { inject } from "vitest";

// Runs in every worker before each test file: point default-rooted RepositoryIntelligence
// instances at this run's isolated cache root (see repository-index-root.global.ts).
const root = inject("repositoryIndexRoot");
if (root) process.env.CODEFORGE_REPOSITORY_INDEX_ROOT = root;
