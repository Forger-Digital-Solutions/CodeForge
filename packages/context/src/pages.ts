import { canonicalCacheKey, type CanonicalCacheIdentity } from "@codeforge/forge-green";
import type { ForgeGreenCacheStore } from "@codeforge/sessions";
import type {
  AnalysisCompleteness,
  EdgeProvenance,
  FileSummary,
  RepositoryEdge,
  RepositoryIntelligence,
  RepositoryMatch,
} from "@codeforge/repo-intelligence";

/**
 * FG-3D Context Pages.
 *
 * A Context Page is a bounded, provenance-rich, content-addressed repository unit — the
 * reusable substrate progressive context retrieval pulls from. Pages are deliberately built
 * from FG-2 structural intelligence (never LLM summarization): identical content always
 * produces an identical page, and reuse can be proven rather than trusted.
 *
 * Storage deliberately reuses FG-1's `ForgeGreenCacheStore` (the same namespaced,
 * bounded, secret-rejecting, corrupt-safe SQLite cache that already backs the canonical
 * repo-tool-result cache in `agent-runtime.ts`) rather than inventing a second persistence
 * layer (see FG-3 audit §8/§79). A page's identity IS a `CanonicalCacheIdentity` — the same
 * identity scheme FG-1D already certified — so page reuse inherits its namespace isolation,
 * content-hash-first invalidation, and graph-generation scoping for free.
 */

export type ContextPageType = "file" | "symbol" | "dependency_neighborhood" | "test_relationship";

export const CONTEXT_PAGE_SCHEMA_VERSION = "fg3-page-1";

export type ContextPageId = string & { readonly __contextPageId: unique symbol };

export function contextPageId(identity: CanonicalCacheIdentity): ContextPageId {
  return canonicalCacheKey(identity) as ContextPageId;
}

export interface ContextPageProvenance {
  sourceFiles: string[];
  contentHashes: string[];
  edgeProvenance?: EdgeProvenance[];
  /** Present when the page's underlying analysis reports FG-2 completeness (PARTIAL/UNKNOWN
   * must never be silently dropped — see FG-3 §36). */
  completeness?: AnalysisCompleteness;
  /** Present for graph-scoped pages; absent for pure file-local pages (content hash alone is
   * their invalidation key — FG-2 §48 file-local vs graph-scoped distinction). */
  graphGeneration?: number;
  builderVersion: string;
}

export interface ContextPage<T> {
  id: ContextPageId;
  type: ContextPageType;
  identity: CanonicalCacheIdentity;
  provenance: ContextPageProvenance;
  data: T;
  generatedAt: string;
}

/**
 * Thin typed envelope over `ForgeGreenCacheStore`. Get/put never throw: a missing, corrupt, or
 * schema-mismatched entry is treated as a cache miss (FG-3 §81 — fail safe, never trust
 * corrupted context), and namespace isolation is inherited directly from the underlying store.
 */
export class ContextPageStore {
  constructor(private readonly cacheStore: ForgeGreenCacheStore) {}

  async get<T>(identity: CanonicalCacheIdentity): Promise<ContextPage<T> | undefined> {
    const id = contextPageId(identity);
    const hit = await this.cacheStore.get(identity.namespace, id).catch(() => undefined);
    if (!hit) return undefined;
    try {
      const parsed = JSON.parse(hit.value) as Partial<ContextPage<T>>;
      if (!parsed || parsed.id !== id || !parsed.identity || !parsed.type || parsed.data === undefined) return undefined;
      return parsed as ContextPage<T>;
    } catch {
      return undefined;
    }
  }

  async put<T>(page: Omit<ContextPage<T>, "id">): Promise<ContextPage<T>> {
    const id = contextPageId(page.identity);
    const full: ContextPage<T> = { ...page, id };
    await this.cacheStore.put(page.identity.namespace, id, JSON.stringify(full)).catch(() => false);
    return full;
  }
}

export function createContextPageStore(cacheStore: ForgeGreenCacheStore): ContextPageStore {
  return new ContextPageStore(cacheStore);
}

function repositoryNamespaceOf(intelligence: RepositoryIntelligence): string {
  const status = intelligence.status();
  return status.repositoryNamespace ?? status.workspaceId;
}

export interface FilePageData {
  path: string;
  summary?: FileSummary;
}

export async function buildFilePageIdentity(
  intelligence: RepositoryIntelligence,
  filePath: string,
): Promise<CanonicalCacheIdentity | undefined> {
  const file = await intelligence.getFile(filePath);
  if (!file) return undefined;
  const status = intelligence.status();
  return {
    namespace: repositoryNamespaceOf(intelligence),
    analysis: "context_page:file",
    parameters: { path: filePath },
    // File-local identity: content hash + parser/index version only. FG-1D's certified
    // `repo_file_summary` cache identity deliberately omits the repo-wide `generation` here —
    // an edit to any OTHER file must provably never invalidate this page (FG-2 §48).
    contentHashes: [file.hash],
    scopeDigest: `${status.indexVersion}:${status.parserVersion}`,
    parserVersion: status.parserVersion,
    policyVersion: CONTEXT_PAGE_SCHEMA_VERSION,
  };
}

export interface PageBuildResult<T> {
  page: ContextPage<T>;
  /** True when served from the persistent page cache without recomputing from
   * RepositoryIntelligence — the observable signal FG-3's cross-session/cross-worktree reuse
   * proofs and ledger accounting key off. */
  reused: boolean;
}

/** Deterministic, structural (never LLM-summarized) file page: symbols/exports/imports from
 * FG-2's `getFileSummary`. Content-hash-keyed only — a comments-only or unrelated edit
 * elsewhere in the repository provably cannot invalidate it. */
export async function buildFilePage(
  intelligence: RepositoryIntelligence,
  filePath: string,
  pageStore?: ContextPageStore,
): Promise<PageBuildResult<FilePageData> | undefined> {
  const identity = await buildFilePageIdentity(intelligence, filePath);
  if (!identity) return undefined;
  if (pageStore) {
    const cached = await pageStore.get<FilePageData>(identity);
    if (cached) return { page: cached, reused: true };
  }
  const summary = await intelligence.getFileSummary(filePath);
  const page: Omit<ContextPage<FilePageData>, "id"> = {
    type: "file",
    identity,
    provenance: {
      sourceFiles: [filePath],
      contentHashes: identity.contentHashes ?? [],
      builderVersion: CONTEXT_PAGE_SCHEMA_VERSION,
    },
    data: { path: filePath, summary },
    generatedAt: new Date().toISOString(),
  };
  const stored = pageStore ? await pageStore.put(page) : { ...page, id: contextPageId(identity) };
  return { page: stored, reused: false };
}

export interface DependencyNeighborhoodData {
  path: string;
  dependencies: RepositoryEdge[];
  dependents: RepositoryEdge[];
  relatedTests: RepositoryMatch[];
  dependenciesTruncated: boolean;
  dependentsTruncated: boolean;
  testsTruncated: boolean;
}

/** FG-3F bound: at most this many dependencies/dependents/tests per one-hop neighborhood page. */
export const ONE_HOP_MAX_EDGES = 5;

/**
 * Bounded one-hop structural neighborhood: direct dependencies, direct dependents, and
 * candidate related tests for one file — never a recursive crawl (FG-3 §35). Graph-scoped: the
 * identity includes `graphGeneration`, so a comments-only edit that does not change the call
 * graph does not invalidate it (FG-2 §47), while a signature/import change does.
 */
export async function buildDependencyNeighborhoodPage(
  intelligence: RepositoryIntelligence,
  filePath: string,
  pageStore?: ContextPageStore,
): Promise<PageBuildResult<DependencyNeighborhoodData> | undefined> {
  const file = await intelligence.getFile(filePath);
  if (!file) return undefined;
  const status = intelligence.status();
  const identity: CanonicalCacheIdentity = {
    namespace: repositoryNamespaceOf(intelligence),
    analysis: "context_page:dependency_neighborhood",
    parameters: { path: filePath, maxEach: ONE_HOP_MAX_EDGES },
    // Graph-scoped identity: `graphGeneration` (advances only on structural symbol/edge/call
    // changes) lives inside `scopeDigest`. The repo-wide content `generation` (advances on ANY
    // file edit, comments included) is deliberately NOT part of this identity — otherwise an
    // unrelated comment-only edit anywhere in the repository would invalidate every
    // dependency-neighborhood page, defeating FG-2's graph-vs-content distinction (§47).
    scopeDigest: `${status.indexVersion}:${status.parserVersion}:graphgen-${status.graphGeneration}`,
    parserVersion: status.parserVersion,
    policyVersion: CONTEXT_PAGE_SCHEMA_VERSION,
  };
  if (pageStore) {
    const cached = await pageStore.get<DependencyNeighborhoodData>(identity);
    if (cached) return { page: cached, reused: true };
  }
  const [dependencies, dependents, relatedTests] = await Promise.all([
    intelligence.findDependencies(filePath, { limit: ONE_HOP_MAX_EDGES }),
    intelligence.findDependents(filePath, { limit: ONE_HOP_MAX_EDGES }),
    intelligence.findRelatedTests(filePath, { limit: ONE_HOP_MAX_EDGES }),
  ]);
  const edgeProvenance = [...dependencies.items, ...dependents.items].map((edge) => edge.provenance);
  const page: Omit<ContextPage<DependencyNeighborhoodData>, "id"> = {
    type: "dependency_neighborhood",
    identity,
    provenance: {
      sourceFiles: [filePath],
      contentHashes: [],
      edgeProvenance,
      graphGeneration: status.graphGeneration,
      builderVersion: CONTEXT_PAGE_SCHEMA_VERSION,
    },
    data: {
      path: filePath,
      dependencies: dependencies.items,
      dependents: dependents.items,
      relatedTests: relatedTests.items,
      dependenciesTruncated: dependencies.truncated,
      dependentsTruncated: dependents.truncated,
      testsTruncated: relatedTests.truncated,
    },
    generatedAt: new Date().toISOString(),
  };
  const stored = pageStore ? await pageStore.put(page) : { ...page, id: contextPageId(identity) };
  return { page: stored, reused: false };
}
