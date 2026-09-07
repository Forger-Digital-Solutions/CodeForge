export const REPOSITORY_INDEX_VERSION = 2;
export const REPOSITORY_PARSER_VERSION = "typescript-5.9+deterministic-2";

export type RepositoryIndexState = "NOT_INDEXED" | "INDEXING" | "READY" | "STALE" | "DEGRADED" | "ERROR";
export type SymbolKind = "module" | "namespace" | "class" | "interface" | "type" | "function" | "method" | "constructor" | "property" | "variable" | "enum" | "test";
export type EdgeKind = "imports" | "references" | "package_dependency" | "test_for";

/**
 * FG-2 edge provenance. Every relationship exposes how it was established. A heuristic
 * relationship may not masquerade as a statically resolved one, and a runtime-observed
 * relationship proves only that one path occurred — never that all paths are enumerated.
 * `type-resolved` and `framework-inferred` are reserved taxonomy slots: no current analyzer
 * emits them, and nothing may relabel an edge into them without a real analyzer.
 */
export type EdgeProvenance =
  | "static-direct"
  | "syntax-resolved"
  | "import-resolved"
  | "type-resolved"
  | "framework-inferred"
  | "runtime-observed"
  | "heuristic"
  | "unresolved";

export type CallRecordKind =
  | "identifier_call"
  | "member_call"
  | "dynamic_import"
  | "dynamic_require"
  | "computed_call"
  | "eval_call";

/**
 * FG-2G explicit analysis completeness. Static analysis is not omniscient: dynamic dispatch,
 * unresolved specifiers, parse failures, and unanalyzable files all leave the graph
 * incomplete, and that must be stated categorically rather than erased by a score.
 */
export type AnalysisCompletenessLevel = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface CompletenessBasis {
  level: AnalysisCompletenessLevel;
  reasons: string[];
}

declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

export type AnalysisCompleteness = Brand<CompletenessBasis, "AnalysisCompleteness">;

export function asAnalysisCompleteness(level: AnalysisCompletenessLevel, reasons: string[]): AnalysisCompleteness {
  return { level, reasons: [...reasons] } as AnalysisCompleteness;
}

/**
 * FG-2 runtime-observation boundary. A runtime trace may feed future repository
 * intelligence as advisory evidence, but it carries its producing run identity with it so
 * Verification Policy can always distinguish same-run observation from independent broader
 * evidence. Runtime observations never raise static completeness and never suppress
 * invalidation — the completeness computation does not read them.
 */
export interface RuntimeObservationScope {
  runId: string;
  observer: string;
  revision?: string;
  observedAt: string;
}

export interface RuntimeObservation {
  id: string;
  sourcePath: string;
  sourceSymbolId?: string;
  targetPath?: string;
  targetSymbolId?: string;
  relation: string;
  scope: RuntimeObservationScope;
  evidenceHash: string;
  provenance: "runtime-observed";
}

export interface RuntimeObservationInput {
  sourcePath: string;
  sourceSymbolId?: string;
  targetPath?: string;
  targetSymbolId?: string;
  relation: string;
  scope: RuntimeObservationScope;
  evidenceHash: string;
}

export interface RuntimeObservationRecord extends RuntimeObservation {
  /** True when this observation was produced by the same run identity given in the query. */
  sameRun: boolean;
}

export interface RuntimeObservationQuery extends QueryOptions {
  /** Run identity to compare against, exposing the same-run vs independent distinction. */
  sameRunAs?: string;
}

export interface WorkspaceIdentity {
  id: string;
  root: string;
  realRoot: string;
  gitCommonDirectory?: string;
  gitWorktreeDirectory?: string;
  repositoryFingerprint: string;
  /**
   * FG-2 repository-level security namespace: stable across worktrees of one repository
   * (they share the Git common directory) and unique per repository clone or non-Git
   * directory. Content-addressed parse reuse is keyed on this, never on the worktree id.
   */
  repositoryNamespace: string;
}

export interface RepositoryFile {
  path: string;
  language: string;
  size: number;
  mtimeMs: number;
  hash: string;
  lines: number;
  binary: boolean;
  generated: boolean;
  sensitive: boolean;
  tracked: boolean;
  gitStatus?: string;
  parserStatus: "parsed" | "fallback" | "skipped" | "error";
  parserError?: string;
}

export interface RepositorySymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  parentId?: string;
}

export interface RepositoryEdge {
  id: string;
  kind: EdgeKind;
  sourcePath: string;
  targetPath?: string;
  sourceSymbolId?: string;
  targetSymbolId?: string;
  specifier?: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  provenance: EdgeProvenance;
}

/** A named binding captured from a static import/export declaration. */
export interface ImportBindingRecord {
  path: string;
  specifier: string;
  targetPath?: string;
  binding: string;
  importKind: "named" | "default" | "namespace";
  provenance: EdgeProvenance;
}

export interface ParsedCallRecord {
  kind: CallRecordKind;
  calleeName: string;
  line: number;
  enclosingSymbolId?: string;
}

export interface ResolvedSymbolRef {
  symbolId: string;
  path: string;
  name: string;
}

export interface CallCandidate {
  calleeName: string;
  line: number;
  enclosingSymbolId?: string;
  kind: CallRecordKind;
  /** Every resolvable candidate target. Empty when the call site could not be resolved. */
  resolvedTo: ResolvedSymbolRef[];
  provenance: EdgeProvenance;
  /** More than one candidate target exists; ambiguity is preserved, never silently picked. */
  ambiguous: boolean;
}

export interface CallGraphReport {
  path: string;
  callees: CallCandidate[];
  /** Non-dynamic call sites with zero resolvable candidates. */
  unresolvedCalls: number;
  /** Call sites with more than one candidate target. */
  ambiguousCalls: number;
  dynamicConstructs: Array<{ kind: CallRecordKind; line: number; detail?: string }>;
  completeness: AnalysisCompleteness;
}

export interface CallerCandidate {
  callerPath: string;
  callerSymbolId?: string;
  line: number;
  targetName: string;
  provenance: EdgeProvenance;
  ambiguous: boolean;
}

export interface CallerReport {
  symbol: RepositorySymbol;
  /** More than one definition shares this symbol name; caller attribution is ambiguous. */
  ambiguous: boolean;
  definitionCandidates: ResolvedSymbolRef[];
  callers: CallerCandidate[];
  /** The bounded caller scan stopped before exhausting candidate files. */
  truncated: boolean;
  completeness: AnalysisCompleteness;
}

export interface RepositoryCompletenessReport {
  indexState: RepositoryIndexState;
  analyzableFiles: number;
  parsedFiles: number;
  fallbackFiles: number;
  skippedFiles: number;
  errorFiles: number;
  unresolvedRelativeImportEdges: number;
  dynamicConstructRecords: number;
  completeness: AnalysisCompleteness;
}

export type RetrievalScore = Brand<number, "RetrievalScore">;
export type RelevanceScore = Brand<number, "RelevanceScore">;
export type SymbolConfidence = Brand<"high" | "medium" | "low", "SymbolConfidence">;

export function asRetrievalScore(n: number): RetrievalScore {
  return n as RetrievalScore;
}
export function asRelevanceScore(n: number): RelevanceScore {
  return n as RelevanceScore;
}
export function asSymbolConfidence(c: "high" | "medium" | "low"): SymbolConfidence {
  return c as SymbolConfidence;
}

export type ImpactEstimate = Brand<{
  changedPath: string;
  candidateDependents: string[];
  candidateTests: string[];
  depth: number;
  truncated: boolean;
  unresolvedEdges: number;
  reason: string;
}, "ImpactEstimate">;

export type BlastRadiusEstimate = Brand<{
  targetPath: string;
  candidateDependents: string[];
  candidateTests: string[];
  depth: number;
  truncated: boolean;
  unresolvedEdges: number;
  confidence: SymbolConfidence;
  completeness: AnalysisCompleteness;
  reasons: string[];
}, "BlastRadiusEstimate">;

export interface ImpactCandidates {
  changedPaths: string[];
  candidateDependents: string[];
  candidateTests: string[];
  maxDepthReached: number;
  truncated: boolean;
  unresolvedEdges: number;
  completeness: AnalysisCompleteness;
  evidence: Array<{ path: string; reason: string; depth: number }>;
}

export interface FileSummary {
  path: string;
  language: string;
  size: number;
  lines: number;
  hash: string;
  exports: RepositorySymbol[];
  imports: string[];
  symbols: RepositorySymbol[];
  sensitive: boolean;
  binary: boolean;
}

export interface ModuleSummary {
  prefix: string;
  files: string[];
  symbols: RepositorySymbol[];
  packageDependencies: string[];
  internalDependencies: string[];
  relatedTests: string[];
}

export interface RepositorySummary {
  root: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  packages: string[];
  languages: Record<string, number>;
  entryPoints: string[];
  testLayout: string[];
  indexState: RepositoryIndexState;
  generation: number;
  graphGeneration: number;
}

export interface RepositoryMatch {
  path: string;
  line?: number;
  column?: number;
  preview?: string;
  symbol?: RepositorySymbol;
  score: number;
  reasons: string[];
  confidence: "high" | "medium" | "low";
}

export interface QueryOptions {
  limit?: number;
  cursor?: string;
  pathPrefix?: string;
  languages?: string[];
}

export interface QueryPage<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}

export interface IndexProgress {
  phase: "discover" | "hash" | "parse" | "persist" | "ready";
  filesDiscovered: number;
  filesProcessed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  errors: number;
  percentage: number;
  elapsedMs: number;
}

export interface IndexStatus {
  state: RepositoryIndexState;
  workspaceId: string;
  /**
   * FG-3: repository-level security namespace (stable across worktrees of one repository —
   * see {@link WorkspaceIdentity.repositoryNamespace}), exposed here so callers that only hold
   * an `IndexStatus` (e.g. tool-result cache identity) can key content-addressed reuse at the
   * repository level instead of the per-worktree `workspaceId`. Optional so existing
   * hand-constructed `IndexStatus` values (stubs/fixtures) remain valid without this field.
   */
  repositoryNamespace?: string;
  root: string;
  indexPath: string;
  indexVersion: number;
  parserVersion: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  errorCount: number;
  generation: number;
  graphGeneration: number;
  filesParsed?: number;
  cacheHits?: number;
  bytesRead?: number;
  lastSuccessfulUpdate?: string;
  createdAt?: string;
  updatedAt?: string;
  sizeBytes: number;
}

export interface RefreshResult {
  added: string[];
  changed: string[];
  deleted: string[];
  unchanged: number;
  durationMs: number;
  generation: number;
  /** Advances only when symbol/edge/call records actually changed, not on any content edit. */
  graphGeneration: number;
  filesParsed: number;
  cacheHits: number;
  bytesRead: number;
  /** Direct dependents re-resolved because one of their resolved dependency targets was deleted. */
  invalidatedDependents: string[];
  /** True when more dependents needed re-resolution than the bounded re-resolution pass allowed. */
  invalidatedDependentsTruncated: boolean;
}

export interface RepositoryIntelligenceOptions {
  cacheRoot?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  batchSize?: number;
  includeHidden?: boolean;
  onProgress?: (progress: IndexProgress) => void;
}

export interface SemanticIndexProvider {
  index(workspaceId: string, documents: Array<{ id: string; text: string; metadata: Record<string, string> }>): Promise<void>;
  query(workspaceId: string, query: string, limit: number): Promise<RepositoryMatch[]>;
  remove(workspaceId: string, ids: string[]): Promise<void>;
}

export interface RepositoryIntelligence {
  openWorkspace(root: string): Promise<WorkspaceIdentity>;
  indexWorkspace(signal?: AbortSignal): Promise<IndexStatus>;
  refresh(paths?: string[], signal?: AbortSignal): Promise<RefreshResult>;
  status(): IndexStatus;
  /** Metrics of the most recent completed refresh or full index, for efficiency telemetry. */
  lastRefreshMetrics(): RefreshResult | undefined;
  searchFiles(query: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  listFiles(options?: QueryOptions): Promise<QueryPage<RepositoryFile>>;
  getFile(path: string): Promise<RepositoryFile | undefined>;
  searchText(query: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  searchSymbols(query: string, options?: QueryOptions): Promise<QueryPage<RepositorySymbol>>;
  getSymbol(id: string): Promise<RepositorySymbol | undefined>;
  /** All definitions for a name. Ambiguity is preserved: multiple candidates are all returned. */
  findDefinitions(name: string, options?: QueryOptions): Promise<QueryPage<RepositorySymbol>>;
  getDefinition(symbolIdOrName: string): Promise<RepositorySymbol | undefined>;
  findReferences(symbolIdOrName: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  findDependencies(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryEdge>>;
  findDependents(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryEdge>>;
  findRelatedTests(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  findRelevantContext(task: string, options?: QueryOptions & { mentionedPaths?: string[] }): Promise<QueryPage<RepositoryMatch>>;
  getFileSummary(path: string): Promise<FileSummary | undefined>;
  getModuleSummary(pathPrefix: string): Promise<ModuleSummary>;
  getImpactCandidates(changedPaths: string[], options?: QueryOptions & { maxDepth?: number }): Promise<ImpactCandidates>;
  estimateBlastRadius(changedPaths: string[], options?: QueryOptions & { maxDepth?: number }): Promise<BlastRadiusEstimate>;
  getCallGraph(path: string, options?: QueryOptions): Promise<CallGraphReport>;
  findCallers(symbolIdOrName: string, options?: QueryOptions & { maxCallerFiles?: number }): Promise<CallerReport>;
  getCompleteness(): Promise<RepositoryCompletenessReport>;
  recordRuntimeObservation(observation: RuntimeObservationInput): Promise<RuntimeObservation>;
  listRuntimeObservations(options?: RuntimeObservationQuery): Promise<QueryPage<RuntimeObservationRecord>>;
  getRepositorySummary(): Promise<RepositorySummary>;
  startWatching(): void;
  stopWatching(): void;
  closeWorkspace(): Promise<void>;
}
