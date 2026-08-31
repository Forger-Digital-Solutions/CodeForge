export const REPOSITORY_INDEX_VERSION = 1;
export const REPOSITORY_PARSER_VERSION = "typescript-5.9+deterministic-1";

export type RepositoryIndexState = "NOT_INDEXED" | "INDEXING" | "READY" | "STALE" | "DEGRADED" | "ERROR";
export type SymbolKind = "module" | "namespace" | "class" | "interface" | "type" | "function" | "method" | "constructor" | "property" | "variable" | "enum" | "test";
export type EdgeKind = "imports" | "references" | "package_dependency" | "test_for";

export interface WorkspaceIdentity {
  id: string;
  root: string;
  realRoot: string;
  gitCommonDirectory?: string;
  gitWorktreeDirectory?: string;
  repositoryFingerprint: string;
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
  root: string;
  indexPath: string;
  indexVersion: number;
  parserVersion: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  errorCount: number;
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
  searchFiles(query: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  listFiles(options?: QueryOptions): Promise<QueryPage<RepositoryFile>>;
  getFile(path: string): Promise<RepositoryFile | undefined>;
  searchText(query: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  searchSymbols(query: string, options?: QueryOptions): Promise<QueryPage<RepositorySymbol>>;
  getSymbol(id: string): Promise<RepositorySymbol | undefined>;
  findReferences(symbolIdOrName: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  findDependencies(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryEdge>>;
  findDependents(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryEdge>>;
  findRelatedTests(path: string, options?: QueryOptions): Promise<QueryPage<RepositoryMatch>>;
  findRelevantContext(task: string, options?: QueryOptions & { mentionedPaths?: string[] }): Promise<QueryPage<RepositoryMatch>>;
  startWatching(): void;
  stopWatching(): void;
  closeWorkspace(): Promise<void>;
}
