import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openSqliteDatabase, type SQLiteDatabase } from "@codeforge/sessions";
import { detectLanguage, parseStructuredFallback, parseTypeScript, resolveImport } from "./languages.js";
import {
  REPOSITORY_INDEX_VERSION,
  REPOSITORY_PARSER_VERSION,
  asAnalysisCompleteness,
  asSymbolConfidence,
  type AnalysisCompleteness,
  type BlastRadiusEstimate,
  type CallCandidate,
  type CallGraphReport,
  type CallerCandidate,
  type CallerReport,
  type FileSummary,
  type ImpactCandidates,
  type IndexProgress,
  type IndexStatus,
  type ModuleSummary,
  type QueryOptions,
  type QueryPage,
  type RefreshResult,
  type RepositoryCompletenessReport,
  type RepositoryEdge,
  type RepositoryFile,
  type RepositoryIntelligence,
  type RepositoryIntelligenceOptions,
  type RepositoryMatch,
  type RepositorySummary,
  type RepositorySymbol,
  type ResolvedSymbolRef,
  type RuntimeObservation,
  type RuntimeObservationInput,
  type RuntimeObservationQuery,
  type RuntimeObservationRecord,
  type WorkspaceIdentity,
} from "./types.js";

interface CachedParse {
  symbols: RepositorySymbol[];
  edges: RepositoryEdge[];
  calls: Array<{ kind: string; calleeName: string; line: number; enclosingSymbolId?: string }>;
  bindings: Array<{ edgeKey: string; binding: string; importKind: string; reExport: boolean }>;
  error?: string;
}

const SHARED_CONTENT_PARSE_CACHE = new Map<string, CachedParse>();
const MAX_PARSE_CACHE_ENTRIES = 50_000;
const DEPENDENT_REPARSE_CAP = 500;
const RUNTIME_OBSERVATION_CAP = 10_000;
const DYNAMIC_CALL_KINDS = new Set(["dynamic_import", "dynamic_require", "computed_call", "eval_call"]);

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 1_000_000;
const DEFAULT_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const BINARY_EXTENSIONS = new Set([".7z", ".avi", ".bmp", ".class", ".dll", ".doc", ".docx", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".obj", ".otf", ".pdf", ".png", ".so", ".tar", ".ttf", ".wav", ".webm", ".woff", ".woff2", ".xls", ".xlsx", ".zip"]);
const GENERATED_SEGMENTS = new Set([".git", ".next", ".turbo", ".venv", "__pycache__", "build", "coverage", "dist", "node_modules", "target", "vendor"]);
const SENSITIVE_NAMES = /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;

type Row = Record<string, unknown>;

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function redactPreview(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/(\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function execGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim();
  } catch {
    return undefined;
  }
}

/** NUL-delimited Git output must not be trimmed: a leading-space status code (e.g. " M")
 * would be corrupted, silently dropping the modified flag for the most common dirty state. */
function execGitNulDelimited(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
  } catch {
    return undefined;
  }
}

function defaultCacheRoot(): string {
  const appData = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME;
  return appData ? path.join(appData, "CodeForge", "repository-indexes") : path.join(os.tmpdir(), "codeforge", "repository-indexes");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealFile(root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) return undefined;
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) return undefined;
  try {
    const real = fs.realpathSync(candidate);
    return isWithin(root, real) && fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function binaryPrefix(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.2;
}

function page<T>(items: T[], options: QueryOptions = {}): QueryPage<T> {
  const offset = Math.max(0, Number.parseInt(options.cursor ?? "0", 10) || 0);
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const selected = items.slice(offset, offset + limit);
  const nextOffset = offset + selected.length;
  return { items: selected, nextCursor: nextOffset < items.length ? String(nextOffset) : undefined, truncated: nextOffset < items.length };
}

function rowSymbol(row: Row): RepositorySymbol {
  return {
    id: String(row.id), name: String(row.name), qualifiedName: String(row.qualified_name), kind: String(row.kind) as RepositorySymbol["kind"],
    path: String(row.path), startLine: Number(row.start_line), endLine: Number(row.end_line), exported: Number(row.exported) === 1,
    signature: row.signature == null ? undefined : String(row.signature), parentId: row.parent_id == null ? undefined : String(row.parent_id),
  };
}

function rowEdge(row: Row): RepositoryEdge {
  return {
    id: String(row.id), kind: String(row.kind) as RepositoryEdge["kind"], sourcePath: String(row.source_path),
    targetPath: row.target_path == null ? undefined : String(row.target_path), sourceSymbolId: row.source_symbol_id == null ? undefined : String(row.source_symbol_id),
    targetSymbolId: row.target_symbol_id == null ? undefined : String(row.target_symbol_id), specifier: row.specifier == null ? undefined : String(row.specifier),
    confidence: String(row.confidence) as RepositoryEdge["confidence"], reason: String(row.reason),
    provenance: String(row.provenance ?? "unresolved") as RepositoryEdge["provenance"],
  };
}

function parseBindings(raw: unknown): Array<{ binding: string; importKind: string; reExport: boolean }> {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ binding?: unknown; importKind?: unknown; reExport?: unknown }>;
    return parsed.map((entry) => ({ binding: String(entry.binding), importKind: String(entry.importKind ?? "named"), reExport: entry.reExport === true }));
  } catch {
    return [];
  }
}

export class LocalRepositoryIntelligence implements RepositoryIntelligence {
  private readonly options: Required<Pick<RepositoryIntelligenceOptions, "maxFileBytes" | "maxFiles" | "batchSize" | "includeHidden">> & RepositoryIntelligenceOptions;
  private db?: SQLiteDatabase;
  private identity?: WorkspaceIdentity;
  private indexPath = "";
  private state: IndexStatus["state"] = "NOT_INDEXED";
  private writeChain: Promise<unknown> = Promise.resolve();
  private watcher?: fs.FSWatcher;
  private watchTimer?: NodeJS.Timeout;
  private pendingWatchPaths = new Set<string>();
  private lastRefresh?: RefreshResult;

  constructor(options: RepositoryIntelligenceOptions = {}) {
    this.options = { ...options, maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES, batchSize: options.batchSize ?? 250, includeHidden: options.includeHidden ?? false };
  }

  async openWorkspace(root: string): Promise<WorkspaceIdentity> {
    const resolved = path.resolve(root);
    const realRoot = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
    const gitCommonRaw = execGit(realRoot, ["rev-parse", "--git-common-dir"]);
    const gitWorktreeRaw = execGit(realRoot, ["rev-parse", "--git-dir"]);
    const gitCommonDirectory = gitCommonRaw ? path.resolve(realRoot, gitCommonRaw) : undefined;
    const gitWorktreeDirectory = gitWorktreeRaw ? path.resolve(realRoot, gitWorktreeRaw) : undefined;
    const marker = execGit(realRoot, ["rev-parse", "--show-toplevel"]) ?? this.rootMarker(realRoot);
    const repositoryFingerprint = sha256([path.normalize(marker), gitCommonDirectory ?? "non-git", this.rootMarker(realRoot)].join("\0"));
    const repositoryNamespace = sha256([gitCommonDirectory ? path.normalize(gitCommonDirectory) : path.normalize(realRoot), this.rootMarker(realRoot)].join("\0"));
    const id = sha256([path.normalize(realRoot), path.normalize(gitWorktreeDirectory ?? realRoot), repositoryFingerprint].join("\0")).slice(0, 40);
    this.identity = { id, root: resolved, realRoot, gitCommonDirectory, gitWorktreeDirectory, repositoryFingerprint, repositoryNamespace };
    const cacheRoot = path.resolve(this.options.cacheRoot ?? defaultCacheRoot());
    fs.mkdirSync(path.join(cacheRoot, id), { recursive: true });
    this.indexPath = path.join(cacheRoot, id, "repository-index.sqlite");
    this.openDatabase();
    return this.identity;
  }

  private rootMarker(root: string): string {
    const markers = ["package.json", "Cargo.toml", "go.mod", ".git"];
    return markers.filter((marker) => fs.existsSync(path.join(root, marker))).map((marker) => marker).join(",") || path.basename(root);
  }

  private openDatabase(): void {
    if (!this.identity) throw new Error("No workspace is open");
    try {
      this.db = openSqliteDatabase(this.indexPath).db;
      this.initializeSchema();
      const version = this.meta("index_version");
      if (version && Number(version) !== REPOSITORY_INDEX_VERSION) {
        this.db.close();
        fs.renameSync(this.indexPath, `${this.indexPath}.incompatible-${Date.now()}`);
        this.db = openSqliteDatabase(this.indexPath).db;
        this.initializeSchema();
      }
      this.writeMeta("index_version", String(REPOSITORY_INDEX_VERSION));
      this.writeMeta("parser_version", REPOSITORY_PARSER_VERSION);
      this.writeMeta("workspace_id", this.identity.id);
      this.writeMeta("repository_fingerprint", this.identity.repositoryFingerprint);
      if (!this.meta("generation")) this.writeMeta("generation", "1");
      if (!this.meta("graph_generation")) this.writeMeta("graph_generation", "1");
      this.state = this.meta("state") as IndexStatus["state"] || "NOT_INDEXED";
    } catch (error) {
      this.recoverCorruption(error);
    }
  }

  private recoverCorruption(original: unknown): void {
    try { this.db?.close(); } catch {}
    if (fs.existsSync(this.indexPath)) fs.renameSync(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`);
    try {
      this.db = openSqliteDatabase(this.indexPath).db;
      this.initializeSchema();
      this.writeMeta("index_version", String(REPOSITORY_INDEX_VERSION));
      this.writeMeta("parser_version", REPOSITORY_PARSER_VERSION);
      this.writeMeta("workspace_id", this.identity?.id ?? "unknown");
      this.writeMeta("state", "NOT_INDEXED");
      this.writeMeta("generation", "1");
      this.writeMeta("graph_generation", "1");
      this.state = "NOT_INDEXED";
    } catch (recovery) {
      throw new Error(`Repository index recovery failed after ${String(original)}: ${String(recovery)}`);
    }
  }

  private initializeSchema(): void {
    this.db!.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, language TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, hash TEXT NOT NULL, lines INTEGER NOT NULL, binary INTEGER NOT NULL, generated INTEGER NOT NULL, sensitive INTEGER NOT NULL, tracked INTEGER NOT NULL, git_status TEXT, parser_status TEXT NOT NULL, parser_error TEXT);
      CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, name TEXT NOT NULL, qualified_name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL, signature TEXT, parent_id TEXT);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name); CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
      CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, target_path TEXT, source_symbol_id TEXT, target_symbol_id TEXT, specifier TEXT, confidence TEXT NOT NULL, reason TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT 'unresolved', binding_names TEXT);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_path, kind); CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_path, kind);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, kind TEXT NOT NULL, callee_name TEXT NOT NULL, line INTEGER NOT NULL, enclosing_symbol_id TEXT);
      CREATE INDEX IF NOT EXISTS idx_calls_path ON calls(path); CREATE INDEX IF NOT EXISTS idx_calls_name ON calls(callee_name);
      CREATE TABLE IF NOT EXISTS runtime_observations (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_symbol_id TEXT, target_path TEXT, target_symbol_id TEXT, relation TEXT NOT NULL, run_id TEXT NOT NULL, observer TEXT NOT NULL, revision TEXT, observed_at TEXT NOT NULL, evidence_hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(path UNINDEXED, content, tokenize='unicode61 tokenchars _');`);
  }

  private meta(key: string): string | undefined {
    const row = this.db!.prepare("SELECT value FROM meta WHERE key=$key").get({ $key: key }) as Row | undefined;
    return row?.value == null ? undefined : String(row.value);
  }

  private writeMeta(key: string, value: string): void {
    this.db!.prepare("INSERT INTO meta(key,value) VALUES($key,$value) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run({ $key: key, $value: value });
  }

  private ensureOpen(): { db: SQLiteDatabase; identity: WorkspaceIdentity } {
    if (!this.db || !this.identity) throw new Error("Open a workspace before using repository intelligence");
    return { db: this.db, identity: this.identity };
  }

  private discover(): Array<{ path: string; tracked: boolean; gitStatus?: string }> {
    const { identity } = this.ensureOpen();
    const listed = execGitNulDelimited(identity.realRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const statuses = new Map<string, string>();
    const statusRaw = execGitNulDelimited(identity.realRoot, ["status", "--porcelain=v1", "-z"]);
    if (statusRaw) {
      const parts = statusRaw.split("\0").filter(Boolean);
      for (const part of parts) statuses.set(normalizeRelative(part.slice(3)), part.slice(0, 2));
    }
    const trackedRaw = execGitNulDelimited(identity.realRoot, ["ls-files", "-z"]);
    const tracked = new Set((trackedRaw ?? "").split("\0").filter(Boolean).map(normalizeRelative));
    const gitPaths = listed?.split("\0").filter(Boolean).map(normalizeRelative) ?? [];
    const paths = gitPaths.length > 0 ? gitPaths : this.walk(identity.realRoot);
    return paths.slice(0, this.options.maxFiles).filter((relativePath) => safeRealFile(identity.realRoot, relativePath)).map((relativePath) => ({ path: relativePath, tracked: tracked.has(relativePath), gitStatus: statuses.get(relativePath) }));
  }

  private walk(root: string): string[] {
    const output: string[] = [];
    const stack = [root];
    while (stack.length && output.length < this.options.maxFiles) {
      const directory = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = normalizeRelative(path.relative(root, path.join(directory, entry.name)));
        if (entry.isDirectory()) {
          if (GENERATED_SEGMENTS.has(entry.name) || (!this.options.includeHidden && entry.name.startsWith("."))) continue;
          stack.push(path.join(directory, entry.name));
        } else if (entry.isFile()) output.push(relativePath);
      }
    }
    return output;
  }

  async indexWorkspace(signal?: AbortSignal): Promise<IndexStatus> {
    return this.serialWrite(async () => {
      const started = Date.now();
      this.state = "INDEXING";
      this.writeMeta("state", this.state);
      const discovered = this.discover();
      this.progress("discover", discovered.length, 0, 0, 0, 0, started);
      await this.refreshInternal(discovered.map((entry) => entry.path), signal, discovered, started);
      return this.status();
    });
  }

  async refresh(paths?: string[], signal?: AbortSignal): Promise<RefreshResult> {
    return this.serialWrite(async () => {
      const started = Date.now();
      const requested = paths?.map(normalizeRelative);
      let discovered: Array<{ path: string; tracked: boolean; gitStatus?: string }>;
      if (requested) {
        // Targeted refreshes still re-derive current Git state so tracked/modified
        // intelligence stays honest without rediscovering the whole workspace.
        const identity = this.identity!;
        const statuses = new Map<string, string>();
        const statusRaw = execGitNulDelimited(identity.realRoot, ["status", "--porcelain=v1", "-z"]);
        if (statusRaw) {
          for (const part of statusRaw.split("\0").filter(Boolean)) statuses.set(normalizeRelative(part.slice(3)), part.slice(0, 2));
        }
        const trackedRaw = execGitNulDelimited(identity.realRoot, ["ls-files", "-z"]);
        const trackedSet = trackedRaw ? new Set(trackedRaw.split("\0").filter(Boolean).map(normalizeRelative)) : undefined;
        discovered = requested.flatMap((relativePath) => {
          const absolute = safeRealFile(identity.realRoot, relativePath);
          if (!absolute) return [];
          const existing = this.db!.prepare("SELECT tracked,git_status FROM files WHERE path=$path").get({ $path: relativePath }) as Row | undefined;
          return [{
            path: relativePath,
            tracked: trackedSet ? trackedSet.has(relativePath) : Number(existing?.tracked) === 1,
            gitStatus: statuses.get(relativePath),
          }];
        });
      } else {
        discovered = this.discover();
      }
      return this.refreshInternal(requested, signal, discovered, started);
    });
  }

  lastRefreshMetrics(): RefreshResult | undefined {
    return this.lastRefresh;
  }

  private async serialWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private fileGraphDigest(relativePath: string): string {
    const db = this.db!;
    const symbols = db.prepare("SELECT kind,name,qualified_name,start_line,end_line,exported,signature,parent_id FROM symbols WHERE path=$path ORDER BY id").all({ $path: relativePath }) as Row[];
    const edges = db.prepare("SELECT kind,target_path,specifier,confidence,reason,provenance,binding_names FROM edges WHERE source_path=$path ORDER BY id").all({ $path: relativePath }) as Row[];
    const calls = db.prepare("SELECT kind,callee_name,line,enclosing_symbol_id FROM calls WHERE path=$path ORDER BY line,callee_name").all({ $path: relativePath }) as Row[];
    if (!symbols.length && !edges.length && !calls.length) return "";
    return sha256(stableJson({ symbols, edges, calls }));
  }

  private async refreshInternal(requested: string[] | undefined, signal: AbortSignal | undefined, discovered: Array<{ path: string; tracked: boolean; gitStatus?: string }>, started: number): Promise<RefreshResult> {
    const { db, identity } = this.ensureOpen();
    const existingRows = db.prepare("SELECT path,hash,size,mtime_ms FROM files").all() as Row[];
    const existing = new Map(existingRows.map((row) => [String(row.path), { hash: String(row.hash), size: Number(row.size), mtimeMs: Number(row.mtime_ms) }]));
    const discoveredByPath = new Map(discovered.map((entry) => [entry.path, entry]));
    const knownPaths = requested ? new Set(existing.keys()) : new Set(discovered.map((entry) => entry.path));
    if (requested) {
      for (const relativePath of requested) {
        if (discoveredByPath.has(relativePath)) knownPaths.add(relativePath);
        else knownPaths.delete(relativePath);
      }
    }
    const targets = requested ? requested : discovered.map((entry) => entry.path);
    const deleted = [...existing.keys()].filter((file) => !knownPaths.has(file) && (!requested || requested.includes(file)));
    const added: string[] = [];
    const changed: string[] = [];
    let unchanged = 0;
    let symbolsIndexed = 0;
    let edgesIndexed = 0;
    let errors = 0;
    let filesParsed = 0;
    let cacheHits = 0;
    let bytesRead = 0;
    let graphChanged = false;
    const currentHead = execGit(identity.realRoot, ["rev-parse", "HEAD"]);
    const storedHead = this.meta("head");
    const headChanged = Boolean(storedHead && currentHead && storedHead !== currentHead);

    // Content identity first: a HEAD move must not by itself discard reuse. Only the
    // cheap size/mtime shortcut is disabled after a HEAD change so every file is
    // re-hashed; files whose content hash is unchanged keep their parsed intelligence.
    const requeueSet = new Set<string>();
    const requeueDiscovery = new Map<string, { path: string; tracked: boolean; gitStatus?: string }>();
    const invalidatedDependents: string[] = [];
    let invalidatedDependentsTruncated = false;
    if (deleted.length) {
      for (const removed of deleted) {
        const dependents = db.prepare("SELECT DISTINCT source_path FROM edges WHERE target_path=$path AND kind='imports'").all({ $path: removed }) as Row[];
        for (const row of dependents) {
          const source = String(row.source_path);
          if (source === removed || !existing.has(source) || requeueSet.has(source)) continue;
          if (invalidatedDependents.length >= DEPENDENT_REPARSE_CAP) { invalidatedDependentsTruncated = true; break; }
          requeueSet.add(source);
          invalidatedDependents.push(source);
          const row0 = db.prepare("SELECT tracked,git_status FROM files WHERE path=$path").get({ $path: source }) as Row | undefined;
          requeueDiscovery.set(source, { path: source, tracked: Number(row0?.tracked) === 1, gitStatus: row0?.git_status == null ? undefined : String(row0.git_status) });
        }
      }
    }
    const worklist = [...targets];
    for (const requeued of requeueSet) if (!worklist.includes(requeued)) worklist.push(requeued);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const removed of deleted) {
        graphChanged = true;
        this.deleteFile(removed, true);
      }
      let processed = 0;
      for (const relativePath of worklist) {
        if (signal?.aborted) throw new Error("Repository indexing cancelled");
        const discovery = discoveredByPath.get(relativePath) ?? requeueDiscovery.get(relativePath);
        if (!discovery) continue;
        const absolute = safeRealFile(identity.realRoot, relativePath);
        if (!absolute) continue;
        const stat = fs.statSync(absolute);
        const previous = existing.get(relativePath);
        const forced = requeueSet.has(relativePath);
        if (!headChanged && !forced && previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) { unchanged++; processed++; continue; }
        const extension = path.extname(relativePath).toLowerCase();
        const generated = normalizeRelative(relativePath).split("/").some((segment) => GENERATED_SEGMENTS.has(segment));
        const sensitive = SENSITIVE_NAMES.test(relativePath);
        const tooLarge = stat.size > this.options.maxFileBytes;
        const prefix = Buffer.alloc(Math.min(stat.size, 8192));
        const handle = fs.openSync(absolute, "r");
        try { fs.readSync(handle, prefix, 0, prefix.length, 0); } finally { fs.closeSync(handle); }
        const binary = BINARY_EXTENSIONS.has(extension) || binaryPrefix(prefix);
        const hash = tooLarge ? sha256(Buffer.concat([prefix, Buffer.from(`:${stat.size}`)])) : sha256(fs.readFileSync(absolute));
        bytesRead += stat.size;
        if (!forced && previous?.hash === hash) {
          db.prepare("UPDATE files SET mtime_ms=$mtime,size=$size,git_status=$git WHERE path=$path").run({ $mtime: stat.mtimeMs, $size: stat.size, $git: discovery.gitStatus ?? null, $path: relativePath });
          unchanged++; processed++; continue;
        }
        if (previous) changed.push(relativePath); else added.push(relativePath);
        if (relativePath.endsWith("package.json")) graphChanged = true;
        const digestBefore = this.fileGraphDigest(relativePath);
        let content = "";
        let parserStatus: RepositoryFile["parserStatus"] = "skipped";
        let parserError: string | undefined;
        let symbols: RepositorySymbol[] = [];
        let edges: RepositoryEdge[] = [];
        let calls: CachedParse["calls"] = [];
        let bindings: CachedParse["bindings"] = [];
        const language = detectLanguage(relativePath, prefix.toString("utf8"));
        if (!binary && !tooLarge) {
          content = fs.readFileSync(absolute, "utf8");
          if (content.includes("\0")) {
            parserStatus = "skipped";
          } else {
            // Parse reuse is keyed by repository-level security namespace + content hash:
            // identical bytes reuse across worktrees of the same repository, but a hit is
            // never observable across security namespaces (separate clones or directories).
            const cacheKey = `${identity.repositoryNamespace}\0${hash}`;
            const cached = SHARED_CONTENT_PARSE_CACHE.get(cacheKey);
            if (cached) {
              cacheHits++;
              const idRemap = new Map<string, string>();
              symbols = cached.symbols.map((s) => {
                const nextId = sha256([relativePath, s.kind, s.qualifiedName, String(s.startLine)].join("\0"));
                idRemap.set(s.id, nextId);
                return { ...s, path: relativePath, id: nextId };
              });
              // Cached edges resolved their relative imports against the worktree that
              // produced them; re-resolve against the current workspace's file set so
              // identical content never restores a target that does not exist here.
              edges = cached.edges.map((e) => {
                const targetPath = e.specifier && e.specifier.startsWith(".") ? resolveImport(relativePath, e.specifier, knownPaths) : undefined;
                const dynamic = e.reason.includes("dynamic");
                return {
                  ...e,
                  sourcePath: relativePath,
                  id: sha256([e.kind, relativePath, e.specifier ?? "", dynamic ? "dynamic" : "static"].join("\0")),
                  targetPath,
                  confidence: targetPath ? (dynamic ? "medium" : "high") : "medium",
                  reason: dynamic ? (targetPath ? "resolved_dynamic_import" : "unresolved_dynamic_import") : targetPath ? "resolved_static_import" : "external_or_unresolved_import",
                  provenance: targetPath ? "import-resolved" : "unresolved",
                };
              });
              calls = cached.calls.map((c) => ({ ...c, enclosingSymbolId: c.enclosingSymbolId ? idRemap.get(c.enclosingSymbolId) : undefined }));
              bindings = cached.bindings.map((b) => ({ ...b }));
              parserError = cached.error;
              parserStatus = cached.error ? "error" : "parsed";
            } else if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(language)) {
              filesParsed++;
              const parsed = parseTypeScript(relativePath, content, knownPaths);
              symbols = parsed.symbols; edges = parsed.edges; parserError = parsed.error;
              parserStatus = parsed.error ? "error" : "parsed";
              calls = parsed.calls.map((c) => ({ kind: c.kind, calleeName: c.calleeName, line: c.line, enclosingSymbolId: c.enclosingSymbolId }));
              const byEdgeKey = new Map<string, CachedParse["bindings"]>();
              for (const imp of parsed.imports) {
                const edgeKey = `${imp.specifier}\0${imp.dynamic ? "dynamic" : "static"}`;
                const list = byEdgeKey.get(edgeKey) ?? [];
                for (const binding of imp.bindings) list.push({ edgeKey, binding: binding.name, importKind: binding.importKind, reExport: binding.reExport });
                byEdgeKey.set(edgeKey, list);
              }
              for (const [edgeKey, list] of byEdgeKey) bindings.push(...list);
            } else {
              filesParsed++;
              symbols = parseStructuredFallback(relativePath, language, content);
              parserStatus = "fallback";
            }
            if (SHARED_CONTENT_PARSE_CACHE.size < MAX_PARSE_CACHE_ENTRIES) {
              SHARED_CONTENT_PARSE_CACHE.set(cacheKey, { symbols, edges, calls, bindings, error: parserError });
            }
          }
        }
        if (parserError) errors++;
        this.deleteFile(relativePath);
        const file: RepositoryFile = { path: relativePath, language, size: stat.size, mtimeMs: stat.mtimeMs, hash, lines: content ? content.split(/\r?\n/).length : 0, binary, generated, sensitive, tracked: discovery.tracked, gitStatus: discovery.gitStatus, parserStatus, parserError };
        this.insertFile(file);
        for (const symbol of symbols) this.insertSymbol(symbol);
        for (const edge of edges) this.insertEdge(edge, bindings);
        calls.forEach((call, callIndex) => this.insertCall(relativePath, call, callIndex));
        this.insertTestEdges(file, knownPaths);
        if (!binary && !tooLarge && !sensitive) db.prepare("INSERT INTO content_fts(path,content) VALUES($path,$content)").run({ $path: relativePath, $content: content });
        symbolsIndexed += symbols.length; edgesIndexed += edges.length;
        const digestAfter = this.fileGraphDigest(relativePath);
        if (digestBefore !== digestAfter) graphChanged = true;
        processed++;
        if (processed % this.options.batchSize === 0) {
          this.progress("parse", worklist.length, processed, symbolsIndexed, edgesIndexed, errors, started);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.insertPackageEdges();
      const now = new Date().toISOString();
      const branch = execGit(identity.realRoot, ["branch", "--show-current"]);
      const head = currentHead ?? execGit(identity.realRoot, ["rev-parse", "HEAD"]);
      // Two revisions are maintained. `generation` describes indexed content: it advances
      // only when a refresh added, changed, or deleted file content. `graph_generation`
      // describes structural intelligence: it advances only when symbol/edge/call records
      // actually changed. A comments-only edit advances the first, not the second, so
      // graph-scoped cached analyses survive while content-scoped ones invalidate.
      const previousGeneration = Number(this.meta("generation")) || 0;
      const previousGraphGeneration = Number(this.meta("graph_generation")) || 0;
      const contentChanged = added.length + changed.length + deleted.length > 0;
      const nextGen = contentChanged ? previousGeneration + 1 : previousGeneration;
      const nextGraphGen = graphChanged ? previousGraphGeneration + 1 : previousGraphGeneration;
      this.writeMeta("generation", String(nextGen));
      this.writeMeta("graph_generation", String(nextGraphGen));
      this.writeMeta("branch", branch ?? ""); this.writeMeta("head", head ?? "");
      this.writeMeta("updated_at", now); if (!this.meta("created_at")) this.writeMeta("created_at", now);
      this.writeMeta("last_successful_update", now);
      this.state = errors ? "DEGRADED" : "READY";
      this.writeMeta("state", this.state);
      db.exec("COMMIT");
      this.progress("ready", worklist.length, worklist.length, symbolsIndexed, edgesIndexed, errors, started);
      const result: RefreshResult = { added, changed, deleted, unchanged, durationMs: Date.now() - started, generation: nextGen, graphGeneration: nextGraphGen, filesParsed, cacheHits, bytesRead, invalidatedDependents, invalidatedDependentsTruncated };
      this.lastRefresh = result;
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      this.state = signal?.aborted ? "STALE" : "ERROR";
      this.writeMeta("state", this.state);
      throw error;
    }
  }

  private progress(phase: IndexProgress["phase"], discovered: number, processed: number, symbols: number, edges: number, errors: number, started: number): void {
    this.options.onProgress?.({ phase, filesDiscovered: discovered, filesProcessed: processed, symbolsIndexed: symbols, edgesIndexed: edges, errors, percentage: discovered ? Math.round(processed / discovered * 100) : 100, elapsedMs: Date.now() - started });
  }

  private deleteFile(relativePath: string, removeIncoming = false): void {
    this.db!.prepare("DELETE FROM content_fts WHERE path=$path").run({ $path: relativePath });
    this.db!.prepare("DELETE FROM calls WHERE path=$path").run({ $path: relativePath });
    this.db!.prepare(removeIncoming ? "DELETE FROM edges WHERE source_path=$path OR target_path=$path" : "DELETE FROM edges WHERE source_path=$path").run({ $path: relativePath });
    this.db!.prepare("DELETE FROM symbols WHERE path=$path").run({ $path: relativePath });
    this.db!.prepare("DELETE FROM files WHERE path=$path").run({ $path: relativePath });
  }

  private insertFile(file: RepositoryFile): void {
    this.db!.prepare("INSERT INTO files(path,language,size,mtime_ms,hash,lines,binary,generated,sensitive,tracked,git_status,parser_status,parser_error) VALUES($path,$language,$size,$mtime,$hash,$lines,$binary,$generated,$sensitive,$tracked,$git,$parser,$error)").run({ $path: file.path, $language: file.language, $size: file.size, $mtime: file.mtimeMs, $hash: file.hash, $lines: file.lines, $binary: file.binary ? 1 : 0, $generated: file.generated ? 1 : 0, $sensitive: file.sensitive ? 1 : 0, $tracked: file.tracked ? 1 : 0, $git: file.gitStatus ?? null, $parser: file.parserStatus, $error: file.parserError ?? null });
  }

  private insertSymbol(symbol: RepositorySymbol): void {
    this.db!.prepare("INSERT OR REPLACE INTO symbols(id,name,qualified_name,kind,path,start_line,end_line,exported,signature,parent_id) VALUES($id,$name,$qualified,$kind,$path,$start,$end,$exported,$signature,$parent)").run({ $id: symbol.id, $name: symbol.name, $qualified: symbol.qualifiedName, $kind: symbol.kind, $path: symbol.path, $start: symbol.startLine, $end: symbol.endLine, $exported: symbol.exported ? 1 : 0, $signature: symbol.signature ?? null, $parent: symbol.parentId ?? null });
  }

  private insertEdge(edge: RepositoryEdge, bindings: CachedParse["bindings"] = []): void {
    const edgeKey = `${edge.specifier ?? ""}\0${edge.reason.includes("dynamic") ? "dynamic" : "static"}`;
    const edgeBindings = edge.kind === "imports" ? bindings.filter((b) => b.edgeKey === edgeKey) : [];
    this.db!.prepare("INSERT OR REPLACE INTO edges(id,kind,source_path,target_path,source_symbol_id,target_symbol_id,specifier,confidence,reason,provenance,binding_names) VALUES($id,$kind,$source,$target,$sourceSymbol,$targetSymbol,$specifier,$confidence,$reason,$provenance,$bindings)").run({
      $id: edge.id, $kind: edge.kind, $source: edge.sourcePath, $target: edge.targetPath ?? null, $sourceSymbol: edge.sourceSymbolId ?? null, $targetSymbol: edge.targetSymbolId ?? null,
      $specifier: edge.specifier ?? null, $confidence: edge.confidence, $reason: edge.reason, $provenance: edge.provenance,
      $bindings: edgeBindings.length ? JSON.stringify(edgeBindings.map((b) => ({ binding: b.binding, importKind: b.importKind, reExport: b.reExport }))) : null,
    });
  }

  private insertCall(relativePath: string, call: { kind: string; calleeName: string; line: number; enclosingSymbolId?: string }, occurrence: number): void {
    this.db!.prepare("INSERT OR REPLACE INTO calls(id,path,kind,callee_name,line,enclosing_symbol_id) VALUES($id,$path,$kind,$name,$line,$enclosing)").run({
      $id: sha256(["call", relativePath, String(call.line), call.kind, call.calleeName, String(occurrence)].join("\0")),
      $path: relativePath, $kind: call.kind, $name: call.calleeName, $line: call.line, $enclosing: call.enclosingSymbolId ?? null,
    });
  }

  private insertTestEdges(file: RepositoryFile, knownPaths: Set<string>): void {
    if (!/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^.]+$/i.test(file.path)) return;
    const base = path.posix.basename(file.path).replace(/\.(?:test|spec)(?=\.)/i, "");
    const candidates = [...knownPaths].filter((candidate) => candidate !== file.path && path.posix.basename(candidate) === base && !/(?:test|spec)\./i.test(candidate));
    for (const targetPath of candidates.slice(0, 20)) this.insertEdge({ id: sha256(`test_for\0${file.path}\0${targetPath}`), kind: "test_for", sourcePath: file.path, targetPath, confidence: "medium", reason: "test_filename_convention", provenance: "heuristic" });
  }

  private insertPackageEdges(): void {
    const rows = this.db!.prepare("SELECT path FROM files WHERE path LIKE '%package.json'").all() as Row[];
    const manifests = new Map<string, { path: string; data: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } }>();
    for (const row of rows) {
      const sourcePath = String(row.path);
      const absolute = safeRealFile(this.identity!.realRoot, sourcePath);
      if (!absolute) continue;
      try {
        const data = JSON.parse(fs.readFileSync(absolute, "utf8")) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
        manifests.set(sourcePath, { path: sourcePath, data });
      } catch {}
    }
    const byName = new Map([...manifests.values()].filter((manifest) => manifest.data.name).map((manifest) => [manifest.data.name!, manifest.path]));
    for (const manifest of manifests.values()) {
      for (const name of Object.keys({ ...manifest.data.dependencies, ...manifest.data.devDependencies, ...manifest.data.peerDependencies })) {
        const targetPath = byName.get(name);
        this.insertEdge({ id: sha256(`package_dependency\0${manifest.path}\0${name}`), kind: "package_dependency", sourcePath: manifest.path, targetPath, specifier: name, confidence: "high", reason: targetPath ? "workspace_package_dependency" : "package_manifest_dependency", provenance: "static-direct" });
      }
    }
  }

  status(): IndexStatus {
    const { db, identity } = this.ensureOpen();
    const counts = db.prepare("SELECT (SELECT count(*) FROM files) file_count,(SELECT count(*) FROM symbols) symbol_count,(SELECT count(*) FROM edges) edge_count,(SELECT count(*) FROM files WHERE parser_status='error') error_count").get() as Row;
    let sizeBytes = 0; try { sizeBytes = fs.statSync(this.indexPath).size; } catch {}
    return {
      state: this.state,
      workspaceId: identity.id,
      root: identity.root,
      indexPath: this.indexPath,
      indexVersion: REPOSITORY_INDEX_VERSION,
      parserVersion: REPOSITORY_PARSER_VERSION,
      fileCount: Number(counts.file_count),
      symbolCount: Number(counts.symbol_count),
      edgeCount: Number(counts.edge_count),
      errorCount: Number(counts.error_count),
      generation: Number(this.meta("generation")) || 1,
      graphGeneration: Number(this.meta("graph_generation")) || 1,
      lastSuccessfulUpdate: this.meta("last_successful_update"),
      createdAt: this.meta("created_at"),
      updatedAt: this.meta("updated_at"),
      sizeBytes,
    };
  }

  async searchFiles(query: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryMatch>> {
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    const rows = this.db!.prepare("SELECT path,language,git_status FROM files").all() as Row[];
    const results = rows.map((row) => {
      const candidate = String(row.path).toLowerCase();
      const matches = terms.filter((term) => candidate.includes(term)).length;
      const exact = candidate === query.toLowerCase();
      const pathPhrase = candidate.includes(query.toLowerCase());
      const basenameMatch = path.posix.basename(candidate).includes(query.toLowerCase());
      const modified = row.git_status != null;
      return { path: String(row.path), score: (exact ? 140 : basenameMatch ? 125 : pathPhrase ? 115 : matches * 12) + (modified ? 8 : 0), reasons: [...(exact ? ["exact_path_match"] : basenameMatch ? ["filename_match"] : pathPhrase ? ["path_phrase_match"] : matches ? ["path_token_match"] : []), ...(modified ? ["git_modified"] : [])], confidence: exact || basenameMatch ? "high" as const : "medium" as const };
    }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return page(results, options);
  }

  async listFiles(options: QueryOptions = {}): Promise<QueryPage<RepositoryFile>> {
    const rows = this.db!.prepare("SELECT * FROM files ORDER BY path").all() as Row[];
    const files: RepositoryFile[] = rows.map((row) => ({
      path: String(row.path), language: String(row.language), size: Number(row.size), mtimeMs: Number(row.mtime_ms), hash: String(row.hash), lines: Number(row.lines),
      binary: Number(row.binary) === 1, generated: Number(row.generated) === 1, sensitive: Number(row.sensitive) === 1, tracked: Number(row.tracked) === 1,
      gitStatus: row.git_status == null ? undefined : String(row.git_status), parserStatus: String(row.parser_status) as RepositoryFile["parserStatus"], parserError: row.parser_error == null ? undefined : String(row.parser_error),
    })).filter((file) => !options.pathPrefix || file.path.startsWith(normalizeRelative(options.pathPrefix))).filter((file) => !options.languages?.length || options.languages.includes(file.language));
    return page(files, options);
  }

  async getFile(filePath: string): Promise<RepositoryFile | undefined> {
    const row = this.db!.prepare("SELECT * FROM files WHERE path=$path").get({ $path: normalizeRelative(filePath) }) as Row | undefined;
    if (!row) return undefined;
    return {
      path: String(row.path), language: String(row.language), size: Number(row.size), mtimeMs: Number(row.mtime_ms), hash: String(row.hash), lines: Number(row.lines),
      binary: Number(row.binary) === 1, generated: Number(row.generated) === 1, sensitive: Number(row.sensitive) === 1, tracked: Number(row.tracked) === 1,
      gitStatus: row.git_status == null ? undefined : String(row.git_status), parserStatus: String(row.parser_status) as RepositoryFile["parserStatus"], parserError: row.parser_error == null ? undefined : String(row.parser_error),
    };
  }

  async searchText(query: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryMatch>> {
    if (!query.trim()) return page([], options);
    const escaped = query.trim().split(/\s+/).map((term) => `\"${term.replace(/\"/g, "\"\"")}\"`).join(" AND ");
    let rows: Row[] = [];
    try { rows = this.db!.prepare("SELECT path, snippet(content_fts,1,'','', ' … ',24) preview, bm25(content_fts) rank FROM content_fts WHERE content_fts MATCH $query LIMIT 1000").all({ $query: escaped }) as Row[]; } catch { return page([], options); }
    const results = rows.map((row) => ({ path: String(row.path), preview: redactPreview(String(row.preview)), score: Math.max(1, 50 - Number(row.rank)), reasons: ["lexical_content_match"], confidence: "medium" as const }));
    return page(results, options);
  }

  async searchSymbols(query: string, options: QueryOptions = {}): Promise<QueryPage<RepositorySymbol>> {
    const lower = query.toLowerCase();
    const rows = this.db!.prepare("SELECT * FROM symbols WHERE lower(name) LIKE $query OR lower(qualified_name) LIKE $query LIMIT 2000").all({ $query: `%${lower}%` }) as Row[];
    const symbols = rows.map(rowSymbol).sort((a, b) => Number(b.name.toLowerCase() === lower) - Number(a.name.toLowerCase() === lower) || a.name.length - b.name.length || a.path.localeCompare(b.path));
    return page(symbols, options);
  }

  async getSymbol(id: string): Promise<RepositorySymbol | undefined> {
    const row = this.db!.prepare("SELECT * FROM symbols WHERE id=$id").get({ $id: id }) as Row | undefined;
    return row ? rowSymbol(row) : undefined;
  }

  async findDefinitions(name: string, options: QueryOptions = {}): Promise<QueryPage<RepositorySymbol>> {
    const rows = this.db!.prepare("SELECT * FROM symbols WHERE name=$name ORDER BY path, start_line LIMIT 500").all({ $name: name }) as Row[];
    return page(rows.map(rowSymbol), options);
  }

  async findReferences(symbolIdOrName: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryMatch>> {
    const symbol = await this.getSymbol(symbolIdOrName);
    const name = symbol?.name ?? symbolIdOrName;
    const text = await this.searchText(name, { ...options, limit: 1000 });
    const symbolMatches = (await this.searchSymbols(name, { limit: 1000 })).items;
    const definitions = new Map(symbolMatches.map((item) => [item.path, item]));
    return page(text.items.map((match) => ({ ...match, symbol: definitions.get(match.path), score: match.score + (definitions.has(match.path) ? 25 : 0), reasons: [...match.reasons, definitions.has(match.path) ? "same_file_symbol_definition" : "approximate_text_reference"], confidence: definitions.has(match.path) ? "high" as const : "low" as const })), options);
  }

  async findDependencies(filePath: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryEdge>> {
    const rows = this.db!.prepare("SELECT * FROM edges WHERE source_path=$path ORDER BY kind,target_path,specifier").all({ $path: normalizeRelative(filePath) }) as Row[];
    return page(rows.map(rowEdge), options);
  }

  async findDependents(filePath: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryEdge>> {
    const rows = this.db!.prepare("SELECT * FROM edges WHERE target_path=$path ORDER BY kind,source_path").all({ $path: normalizeRelative(filePath) }) as Row[];
    return page(rows.map(rowEdge), options);
  }

  async findRelatedTests(filePath: string, options: QueryOptions = {}): Promise<QueryPage<RepositoryMatch>> {
    const normalized = normalizeRelative(filePath);
    const edges = this.db!.prepare("SELECT * FROM edges WHERE (kind='test_for' AND target_path=$path) OR (kind='imports' AND target_path=$path AND (source_path LIKE '%.test.%' OR source_path LIKE '%.spec.%' OR source_path LIKE '%/test/%' OR source_path LIKE '%/tests/%'))").all({ $path: normalized }) as Row[];
    const results = edges.map(rowEdge).map((edge) => ({ path: edge.sourcePath, score: edge.kind === "imports" ? 95 : 70, reasons: [edge.reason, edge.kind === "imports" ? "test_imports_source" : "test_naming_convention"], confidence: edge.confidence }));
    return page([...new Map(results.map((result) => [result.path, result])).values()], options);
  }

  async findRelevantContext(task: string, options: QueryOptions & { mentionedPaths?: string[] } = {}): Promise<QueryPage<RepositoryMatch>> {
    const tokens = [...new Set(task.split(/[^A-Za-z0-9_./-]+/).filter((token) => token.length >= 3))].slice(0, 12);
    const scores = new Map<string, RepositoryMatch>();
    const add = (match: RepositoryMatch): void => {
      const current = scores.get(match.path);
      if (!current) scores.set(match.path, match);
      else {
        const newReasons = match.reasons.filter((reason) => !current.reasons.includes(reason));
        current.score = Math.max(current.score, match.score) + newReasons.length * 8;
        current.reasons = [...current.reasons, ...newReasons];
        if (match.symbol && !current.symbol) current.symbol = match.symbol;
      }
    };
    for (const mentioned of options.mentionedPaths ?? []) add({ path: normalizeRelative(mentioned), score: 120, reasons: ["task_explicit_path"], confidence: "high" });
    if (tokens.length > 1) {
      for (const match of (await this.searchFiles(tokens.join(" "), { limit: 100 })).items) add({ ...match, score: match.score + 20, reasons: [...match.reasons, "multi_token_path_match"] });
    }
    if (tokens.length > 1) {
      for (const match of (await this.searchText(tokens.join(" "), { limit: 100 })).items) add({ ...match, score: match.score + 80, reasons: [...match.reasons, "multi_token_match"] });
    }
    for (const token of tokens) {
      for (const symbol of (await this.searchSymbols(token, { limit: 100 })).items) {
        const exact = symbol.name.toLowerCase() === token.toLowerCase();
        const testLike = symbol.kind === "test" || /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\./i.test(symbol.path);
        add({ path: symbol.path, symbol, line: symbol.startLine, score: exact ? (testLike ? 100 : 135) : (testLike ? 50 : 65), reasons: [exact ? "exact_symbol_match" : "symbol_name_match", ...(testLike ? ["test_symbol"] : ["implementation_symbol"])], confidence: "high" });
      }
      for (const match of (await this.searchFiles(token, { limit: 50 })).items) add(match);
      for (const match of (await this.searchText(token, { limit: 50 })).items) add(match);
    }
    for (const match of [...scores.values()].slice(0, 50)) {
      for (const related of (await this.findRelatedTests(match.path, { limit: 10 })).items) add({ ...related, score: Math.min(90, related.score), reasons: [...related.reasons, "related_to_relevant_implementation"] });
    }
    const asksForTests = /\b(?:test|tests|testing|coverage|specs?)\b/i.test(task);
    const ranked = [...scores.values()].map((match) => {
      const testLike = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\./i.test(match.path);
      return testLike && !asksForTests ? { ...match, score: match.score - 35, reasons: [...match.reasons, "test_deprioritized_for_implementation_query"] } : match;
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return page(ranked, options);
  }

  async getDefinition(symbolIdOrName: string): Promise<RepositorySymbol | undefined> {
    let symbol = await this.getSymbol(symbolIdOrName);
    if (!symbol) {
      const results = await this.searchSymbols(symbolIdOrName, { limit: 10 });
      symbol = results.items.find((s) => s.name === symbolIdOrName || s.qualifiedName === symbolIdOrName) ?? results.items[0];
    }
    return symbol;
  }

  async getFileSummary(filePath: string): Promise<FileSummary | undefined> {
    const file = await this.getFile(filePath);
    if (!file) return undefined;
    const symbols = (this.db!.prepare("SELECT * FROM symbols WHERE path=$path ORDER BY start_line").all({ $path: file.path }) as Row[]).map(rowSymbol);
    const edges = (this.db!.prepare("SELECT * FROM edges WHERE source_path=$path AND kind='imports'").all({ $path: file.path }) as Row[]).map(rowEdge);
    return {
      path: file.path,
      language: file.language,
      size: file.size,
      lines: file.lines,
      hash: file.hash,
      exports: symbols.filter((s) => s.exported),
      imports: [...new Set(edges.map((e) => e.targetPath ?? e.specifier ?? "").filter(Boolean))],
      symbols,
      sensitive: file.sensitive,
      binary: file.binary,
    };
  }

  async getModuleSummary(pathPrefix: string): Promise<ModuleSummary> {
    const normPrefix = normalizeRelative(pathPrefix).replace(/\/+$/, "");
    const fileRows = this.db!.prepare("SELECT path FROM files WHERE path=$prefix OR path LIKE $prefixPattern").all({
      $prefix: normPrefix,
      $prefixPattern: `${normPrefix}/%`,
    }) as Row[];
    const files = fileRows.map((r) => String(r.path));
    const symbolRows = this.db!.prepare("SELECT * FROM symbols WHERE path=$prefix OR path LIKE $prefixPattern LIMIT 500").all({
      $prefix: normPrefix,
      $prefixPattern: `${normPrefix}/%`,
    }) as Row[];
    const symbols = symbolRows.map(rowSymbol);
    const edgeRows = this.db!.prepare("SELECT * FROM edges WHERE source_path=$prefix OR source_path LIKE $prefixPattern LIMIT 1000").all({
      $prefix: normPrefix,
      $prefixPattern: `${normPrefix}/%`,
    }) as Row[];
    const edges = edgeRows.map(rowEdge);
    const internalDeps = new Set<string>();
    const packageDeps = new Set<string>();
    for (const edge of edges) {
      if (edge.kind === "package_dependency" && edge.specifier) {
        packageDeps.add(edge.specifier);
      } else if (edge.kind === "imports" && edge.targetPath) {
        if (!edge.targetPath.startsWith(`${normPrefix}/`)) {
          internalDeps.add(edge.targetPath);
        }
      }
    }
    const relatedTests = new Set<string>();
    for (const file of files.slice(0, 50)) {
      const tests = await this.findRelatedTests(file, { limit: 10 });
      for (const t of tests.items) relatedTests.add(t.path);
    }
    return {
      prefix: normPrefix,
      files,
      symbols,
      packageDependencies: [...packageDeps],
      internalDependencies: [...internalDeps],
      relatedTests: [...relatedTests],
    };
  }

  private indexIsReady(): boolean {
    return this.state === "READY" || this.state === "DEGRADED";
  }

  /**
   * Resolve an identifier or namespaced member call to candidate definitions. All
   * candidates are returned; ambiguity is never silently collapsed to one target.
   */
  private resolveCallCandidates(calleeName: string, enclosingSymbolId: string | undefined, sourcePath: string): { candidates: ResolvedSymbolRef[]; provenance: RepositoryEdge["provenance"] } {
    const db = this.db!;
    const sameFile = (db.prepare("SELECT * FROM symbols WHERE path=$path AND name=$name LIMIT 10").all({ $path: sourcePath, $name: calleeName }) as Row[]).map(rowSymbol);
    if (sameFile.length === 1) {
      const only = sameFile[0]!;
      return { candidates: [{ symbolId: only.id, path: only.path, name: only.name }], provenance: "syntax-resolved" };
    }
    if (sameFile.length > 1) return { candidates: sameFile.map((s) => ({ symbolId: s.id, path: s.path, name: s.name })), provenance: "unresolved" };

    const containsDot = calleeName.includes(".");
    const rootName = containsDot ? calleeName.slice(0, calleeName.indexOf(".")) : undefined;
    const memberName = containsDot ? calleeName.slice(calleeName.indexOf(".") + 1) : calleeName;

    if (!containsDot && enclosingSymbolId) {
      const classCandidates = this.enclosingClassMethods(enclosingSymbolId, memberName);
      if (classCandidates.length === 1) return { candidates: classCandidates, provenance: "syntax-resolved" };
      if (classCandidates.length > 1) return { candidates: classCandidates, provenance: "unresolved" };
    }

    // Identifier calls resolve through named/default import bindings; `root.member` calls
    // resolve through a namespace import binding for the root. Re-export chains are
    // followed at most one hop, with a visited guard against re-export cycles.
    const importEdges = db.prepare("SELECT * FROM edges WHERE source_path=$path AND kind='imports' AND binding_names IS NOT NULL").all({ $path: sourcePath }) as Row[];
    const candidates: ResolvedSymbolRef[] = [];
    const visited = new Set<string>();
    let matched = false;
    const collectFromTarget = (targetPath: string, name: string, depth: number): void => {
      const key = `${targetPath}\0${name}`;
      if (depth > 1 || visited.has(key)) return;
      visited.add(key);
      const exports = db.prepare("SELECT * FROM symbols WHERE path=$path AND name=$name AND exported=1 LIMIT 10").all({ $path: targetPath, $name: name }) as Row[];
      for (const row of exports) {
        const symbol = rowSymbol(row);
        candidates.push({ symbolId: symbol.id, path: symbol.path, name: symbol.name });
      }
      if (exports.length === 0) {
        const reExports = db.prepare("SELECT * FROM edges WHERE source_path=$path AND kind='imports' AND binding_names IS NOT NULL").all({ $path: targetPath }) as Row[];
        for (const reExport of reExports) {
          const bindings = parseBindings(reExport.binding_names);
          const followed = bindings.some((b) => b.reExport && (b.binding === name || b.binding === "*"));
          if (followed && reExport.target_path) collectFromTarget(String(reExport.target_path), name, depth + 1);
        }
      }
    };
    for (const edge of importEdges) {
      const bindings = parseBindings(edge.binding_names);
      const relevant = containsDot
        ? bindings.filter((b) => !b.reExport && b.importKind === "namespace" && b.binding === rootName)
        : bindings.filter((b) => !b.reExport && (b.importKind === "named" || b.importKind === "default") && b.binding === calleeName);
      if (!relevant.length) continue;
      matched = true;
      if (edge.target_path) collectFromTarget(String(edge.target_path), containsDot ? memberName : calleeName, 0);
    }
    if (matched && candidates.length > 0) {
      const unique = [...new Map(candidates.map((c) => [c.symbolId, c])).values()];
      if (unique.length === 1) return { candidates: unique, provenance: "import-resolved" };
      return { candidates: unique, provenance: "unresolved" };
    }

    return { candidates: [], provenance: "unresolved" };
  }

  private enclosingClassMethods(enclosingSymbolId: string, memberName: string): ResolvedSymbolRef[] {
    const db = this.db!;
    const enclosingRow = db.prepare("SELECT * FROM symbols WHERE id=$id").get({ $id: enclosingSymbolId }) as Row | undefined;
    if (!enclosingRow) return [];
    let classRow = rowSymbol(enclosingRow);
    while (classRow.kind !== "class" && classRow.parentId) {
      const parentRow = db.prepare("SELECT * FROM symbols WHERE id=$id").get({ $id: classRow.parentId }) as Row | undefined;
      if (!parentRow) return [];
      classRow = rowSymbol(parentRow);
    }
    if (classRow.kind !== "class") return [];
    const members = db.prepare("SELECT * FROM symbols WHERE parent_id=$id AND name=$name AND kind IN ('method','property') LIMIT 10").all({ $id: classRow.id, $name: memberName }) as Row[];
    return members.map(rowSymbol).map((s) => ({ symbolId: s.id, path: s.path, name: s.name }));
  }

  async getCallGraph(requestedPath: string, options: QueryOptions = {}): Promise<CallGraphReport> {
    void options;
    const { db } = this.ensureOpen();
    const normalized = normalizeRelative(requestedPath);
    const file = await this.getFile(normalized);
    if (!file) {
      return { path: normalized, callees: [], unresolvedCalls: 0, ambiguousCalls: 0, dynamicConstructs: [], completeness: asAnalysisCompleteness("UNKNOWN", ["file_not_indexed"]) };
    }
    if (file.parserStatus !== "parsed") {
      return { path: normalized, callees: [], unresolvedCalls: 0, ambiguousCalls: 0, dynamicConstructs: [], completeness: asAnalysisCompleteness("UNKNOWN", [`parser_status:${file.parserStatus}`]) };
    }
    const rows = db.prepare("SELECT * FROM calls WHERE path=$path ORDER BY line, callee_name LIMIT 2000").all({ $path: normalized }) as Row[];
    const callees: CallCandidate[] = [];
    const dynamicConstructs: CallGraphReport["dynamicConstructs"] = [];
    for (const row of rows) {
      const kind = String(row.kind);
      const calleeName = String(row.callee_name);
      const line = Number(row.line);
      const enclosing = row.enclosing_symbol_id == null ? undefined : String(row.enclosing_symbol_id);
      if (DYNAMIC_CALL_KINDS.has(kind)) {
        dynamicConstructs.push({ kind: kind as CallGraphReport["dynamicConstructs"][number]["kind"], line });
        continue;
      }
      const resolution = this.resolveCallCandidates(calleeName, enclosing, normalized);
      callees.push({ calleeName, line, enclosingSymbolId: enclosing, kind: kind as CallCandidate["kind"], resolvedTo: resolution.candidates, provenance: resolution.candidates.length ? resolution.provenance : "unresolved", ambiguous: resolution.candidates.length > 1 });
    }
    const unresolvedCalls = callees.filter((c) => c.resolvedTo.length === 0).length;
    const ambiguousCalls = callees.filter((c) => c.ambiguous).length;
    const completeness = this.callAnalysisCompleteness(normalized, {
      unresolved: unresolvedCalls,
      ambiguous: ambiguousCalls,
      dynamic: dynamicConstructs.length,
      extraReasons: [],
    });
    return { path: normalized, callees, unresolvedCalls, ambiguousCalls, dynamicConstructs, completeness };
  }

  async findCallers(symbolIdOrName: string, options: QueryOptions & { maxCallerFiles?: number } = {}): Promise<CallerReport> {
    const { db } = this.ensureOpen();
    const maxCallerFiles = Math.min(500, Math.max(1, options.maxCallerFiles ?? 200));
    let symbol = await this.getSymbol(symbolIdOrName);
    let definitionCandidates: RepositorySymbol[];
    if (symbol) {
      definitionCandidates = [symbol];
    } else {
      const definitions = await this.findDefinitions(symbolIdOrName, { limit: 20 });
      definitionCandidates = definitions.items.filter((s) => s.name === symbolIdOrName);
      symbol = definitionCandidates[0];
    }
    if (!symbol) {
      return { symbol: { id: symbolIdOrName, name: symbolIdOrName, qualifiedName: symbolIdOrName, kind: "function", path: "", startLine: 0, endLine: 0, exported: false }, ambiguous: false, definitionCandidates: [], callers: [], truncated: false, completeness: asAnalysisCompleteness("UNKNOWN", ["symbol_not_found"]) };
    }
    const ambiguous = definitionCandidates.length > 1;
    const targetPaths = [...new Set(definitionCandidates.map((s) => s.path))];
    const targetName = symbol.name;

    // Caller discovery walks direct importers of the defining file and, through barrel
    // files that only re-export it, their importers as well. Bounded and cycle-safe.
    const callerFiles = new Set<string>(targetPaths);
    const visitedNodes = new Set<string>(targetPaths);
    const queue = [...targetPaths];
    while (queue.length > 0 && callerFiles.size < maxCallerFiles * 2) {
      const current = queue.shift()!;
      const importers = db.prepare("SELECT DISTINCT source_path, binding_names FROM edges WHERE target_path=$path AND kind='imports' LIMIT $limit").all({ $path: current, $limit: maxCallerFiles }) as Row[];
      for (const row of importers) {
        const source = String(row.source_path);
        if (visitedNodes.has(source)) continue;
        visitedNodes.add(source);
        callerFiles.add(source);
        const bindings = parseBindings(row.binding_names);
        const isReExportEdge = bindings.length > 0 && bindings.every((b) => b.reExport);
        if (isReExportEdge) queue.push(source);
      }
    }
    const boundedFiles = [...callerFiles].slice(0, maxCallerFiles);
    const callers: CallerCandidate[] = [];
    let truncated = callerFiles.size > maxCallerFiles;
    let heuristicCount = 0;
    const targetPlaceholders = targetPaths.map((_, index) => `$tp${index}`).join(",");
    const targetParams: Record<string, string> = {};
    targetPaths.forEach((p, index) => { targetParams[`$tp${index}`] = p; });
    for (const callerPath of boundedFiles) {
      const callRows = db.prepare("SELECT * FROM calls WHERE path=$path AND (callee_name=$name OR callee_name LIKE $member) ORDER BY line LIMIT 500").all({ $path: callerPath, $name: targetName, $member: `%.${targetName}` }) as Row[];
      for (const row of callRows) {
        const kind = String(row.kind);
        if (DYNAMIC_CALL_KINDS.has(kind)) continue;
        const calleeName = String(row.callee_name);
        const line = Number(row.line);
        const enclosing = row.enclosing_symbol_id == null ? undefined : String(row.enclosing_symbol_id);
        const resolution = this.resolveCallCandidates(calleeName, enclosing, callerPath);
        const targetsThisSymbol = resolution.candidates.some((c) => targetPaths.includes(c.path) && (c.name === targetName));
        if (!targetsThisSymbol && resolution.candidates.length > 0) continue;
        const importsTarget = db.prepare(`SELECT 1 AS hit FROM edges WHERE source_path=$path AND kind='imports' AND target_path IN (${targetPlaceholders}) LIMIT 1`).get({ $path: callerPath, ...targetParams }) as Row | undefined;
        let provenance: RepositoryEdge["provenance"];
        if (callerPath === symbol.path && resolution.provenance === "syntax-resolved") provenance = "syntax-resolved";
        else if (resolution.provenance === "import-resolved") provenance = "import-resolved";
        else if (callerPath === symbol.path) provenance = "syntax-resolved";
        else if (importsTarget) provenance = "unresolved";
        else { provenance = "heuristic"; heuristicCount++; }
        callers.push({ callerPath, callerSymbolId: enclosing, line, targetName, provenance, ambiguous: resolution.candidates.length > 1 || (resolution.candidates.length === 0 && !importsTarget) });
      }
      if (callers.length >= MAX_QUERY_LIMIT) { truncated = true; break; }
    }
    const completenessReasons: string[] = [];
    if (ambiguous) completenessReasons.push("ambiguous_symbol_name");
    if (heuristicCount > 0) completenessReasons.push(`heuristic_callers:${heuristicCount}`);
    if (truncated) completenessReasons.push("caller_scan_truncated");
    const unresolvedCallers = callers.filter((c) => c.provenance === "unresolved").length;
    if (unresolvedCallers > 0) completenessReasons.push(`unresolved_callers:${unresolvedCallers}`);
    const completeness = this.callAnalysisCompleteness(symbol.path, { unresolved: unresolvedCallers, ambiguous: ambiguous ? 1 : 0, dynamic: 0, extraReasons: completenessReasons, scanPaths: boundedFiles });
    return { symbol, ambiguous, definitionCandidates: definitionCandidates.map((s) => ({ symbolId: s.id, path: s.path, name: s.name })), callers: callers.slice(0, MAX_QUERY_LIMIT), truncated, completeness };
  }

  /**
   * Completeness is categorical and structural. COMPLETE requires the analyzed file(s) to be
   * fully parsed with no unresolved calls, no ambiguity, and no dynamic constructs.
   * Anything else is PARTIAL with explicit reasons; an unusable index is UNKNOWN.
   */
  private callAnalysisCompleteness(primaryPath: string, input: { unresolved: number; ambiguous: number; dynamic: number; extraReasons: string[]; scanPaths?: string[] }): AnalysisCompleteness {
    const reasons: string[] = [...input.extraReasons];
    if (!this.indexIsReady()) return asAnalysisCompleteness("UNKNOWN", [`index_state:${this.state}`]);
    const db = this.db!;
    const scanPaths = input.scanPaths ?? [primaryPath];
    let fallback = 0;
    let errors = 0;
    for (const scanPath of scanPaths) {
      const file = db.prepare("SELECT parser_status FROM files WHERE path=$path").get({ $path: scanPath }) as Row | undefined;
      if (!file) continue;
      const status = String(file.parser_status);
      if (status === "fallback") fallback++;
      if (status === "error") errors++;
    }
    if (fallback > 0) reasons.push(`fallback_parse_files:${fallback}`);
    if (errors > 0) reasons.push(`parse_error_files:${errors}`);
    if (input.unresolved > 0) reasons.push(`unresolved_calls:${input.unresolved}`);
    if (input.ambiguous > 0) reasons.push(`ambiguous_calls:${input.ambiguous}`);
    if (input.dynamic > 0) reasons.push(`dynamic_constructs:${input.dynamic}`);
    if (reasons.length === 0) {
      const pathPlaceholders = scanPaths.map((_, index) => `$sp${index}`).join(",");
      const scanParams: Record<string, string> = {};
      scanPaths.forEach((p, index) => { scanParams[`$sp${index}`] = p; });
      const unresolvedImports = db.prepare(`SELECT count(*) cnt FROM edges WHERE source_path IN (${pathPlaceholders}) AND kind='imports' AND target_path IS NULL AND specifier LIKE './%'`).get(scanParams) as Row | undefined;
      if (unresolvedImports && Number(unresolvedImports.cnt) > 0) reasons.push(`unresolved_relative_imports:${Number(unresolvedImports.cnt)}`);
    }
    return reasons.length === 0 ? asAnalysisCompleteness("COMPLETE", []) : asAnalysisCompleteness("PARTIAL", reasons);
  }

  async getCompleteness(): Promise<RepositoryCompletenessReport> {
    const { db } = this.ensureOpen();
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM files) AS total,
      (SELECT COUNT(*) FROM files WHERE parser_status IN ('parsed','fallback','error')) AS analyzable,
      (SELECT COUNT(*) FROM files WHERE parser_status='parsed') AS parsed,
      (SELECT COUNT(*) FROM files WHERE parser_status='fallback') AS fallback,
      (SELECT COUNT(*) FROM files WHERE parser_status='skipped') AS skipped,
      (SELECT COUNT(*) FROM files WHERE parser_status='error') AS errors,
      (SELECT COUNT(*) FROM edges WHERE kind='imports' AND target_path IS NULL AND specifier LIKE './%') AS unresolved_relative,
      (SELECT COUNT(*) FROM calls WHERE kind IN ('dynamic_import','dynamic_require','computed_call','eval_call')) AS dynamic`).get() as Row;
    const reasons: string[] = [];
    let level: RepositoryCompletenessReport["completeness"]["level"];
    if (!this.indexIsReady()) {
      level = "UNKNOWN";
      reasons.push(`index_state:${this.state}`);
    } else if (Number(counts.total) === 0) {
      level = "UNKNOWN";
      reasons.push("no_indexed_files");
    } else if (Number(counts.fallback) === 0 && Number(counts.errors) === 0 && Number(counts.unresolved_relative) === 0 && Number(counts.dynamic) === 0 && Number(counts.skipped) === 0) {
      level = "COMPLETE";
    } else {
      level = "PARTIAL";
      if (Number(counts.fallback) > 0) reasons.push(`fallback_parse_files:${Number(counts.fallback)}`);
      if (Number(counts.errors) > 0) reasons.push(`parse_error_files:${Number(counts.errors)}`);
      if (Number(counts.skipped) > 0) reasons.push(`unanalyzed_files:${Number(counts.skipped)}`);
      if (Number(counts.unresolved_relative) > 0) reasons.push(`unresolved_relative_imports:${Number(counts.unresolved_relative)}`);
      if (Number(counts.dynamic) > 0) reasons.push(`dynamic_constructs:${Number(counts.dynamic)}`);
    }
    return {
      indexState: this.state,
      analyzableFiles: Number(counts.analyzable),
      parsedFiles: Number(counts.parsed),
      fallbackFiles: Number(counts.fallback),
      skippedFiles: Number(counts.skipped),
      errorFiles: Number(counts.errors),
      unresolvedRelativeImportEdges: Number(counts.unresolved_relative),
      dynamicConstructRecords: Number(counts.dynamic),
      completeness: asAnalysisCompleteness(level, reasons),
    };
  }

  async recordRuntimeObservation(observation: RuntimeObservationInput): Promise<RuntimeObservation> {
    const { db } = this.ensureOpen();
    if (!observation.sourcePath || !observation.relation || !observation.scope?.runId || !observation.scope?.observer || !observation.evidenceHash) {
      throw new Error("Runtime observation requires sourcePath, relation, scope.runId, scope.observer, and evidenceHash");
    }
    const observedAt = observation.scope.observedAt || new Date().toISOString();
    const id = sha256(["runtime_observation", observation.sourcePath, observation.targetPath ?? "", observation.relation, observation.scope.runId, observation.scope.observer, observation.evidenceHash].join("\0"));
    db.prepare("INSERT OR REPLACE INTO runtime_observations(id,source_path,source_symbol_id,target_path,target_symbol_id,relation,run_id,observer,revision,observed_at,evidence_hash) VALUES($id,$source,$sourceSymbol,$target,$targetSymbol,$relation,$runId,$observer,$revision,$observedAt,$evidence)").run({
      $id: id, $source: normalizeRelative(observation.sourcePath), $sourceSymbol: observation.sourceSymbolId ?? null, $target: observation.targetPath == null ? null : normalizeRelative(observation.targetPath), $targetSymbol: observation.targetSymbolId ?? null,
      $relation: observation.relation.slice(0, 120), $runId: observation.scope.runId, $observer: observation.scope.observer.slice(0, 120), $revision: observation.scope.revision?.slice(0, 200) ?? null, $observedAt: observedAt, $evidence: observation.evidenceHash,
    });
    const total = db.prepare("SELECT COUNT(*) AS n FROM runtime_observations").get() as Row;
    if (Number(total.n) > RUNTIME_OBSERVATION_CAP) {
      db.prepare("DELETE FROM runtime_observations WHERE id IN (SELECT id FROM runtime_observations ORDER BY observed_at ASC LIMIT $overflow)").run({ $overflow: Number(total.n) - RUNTIME_OBSERVATION_CAP });
    }
    return {
      id,
      sourcePath: normalizeRelative(observation.sourcePath),
      sourceSymbolId: observation.sourceSymbolId,
      targetPath: observation.targetPath == null ? undefined : normalizeRelative(observation.targetPath),
      targetSymbolId: observation.targetSymbolId,
      relation: observation.relation,
      scope: { runId: observation.scope.runId, observer: observation.scope.observer, revision: observation.scope.revision, observedAt },
      evidenceHash: observation.evidenceHash,
      provenance: "runtime-observed",
    };
  }

  async listRuntimeObservations(options: RuntimeObservationQuery = {}): Promise<QueryPage<RuntimeObservationRecord>> {
    const { db } = this.ensureOpen();
    const rows = db.prepare("SELECT * FROM runtime_observations ORDER BY observed_at DESC, id LIMIT 5000").all() as Row[];
    const records: RuntimeObservationRecord[] = rows.map((row) => ({
      id: String(row.id),
      sourcePath: String(row.source_path),
      sourceSymbolId: row.source_symbol_id == null ? undefined : String(row.source_symbol_id),
      targetPath: row.target_path == null ? undefined : String(row.target_path),
      targetSymbolId: row.target_symbol_id == null ? undefined : String(row.target_symbol_id),
      relation: String(row.relation),
      scope: { runId: String(row.run_id), observer: String(row.observer), revision: row.revision == null ? undefined : String(row.revision), observedAt: String(row.observed_at) },
      evidenceHash: String(row.evidence_hash),
      provenance: "runtime-observed",
      sameRun: options.sameRunAs != null && String(row.run_id) === options.sameRunAs,
    }));
    return page(records, options);
  }

  async getImpactCandidates(
    changedPaths: string[],
    options: QueryOptions & { maxDepth?: number } = {},
  ): Promise<ImpactCandidates> {
    const maxDepth = Math.min(10, Math.max(1, options.maxDepth ?? 3));
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const visited = new Set<string>();
    const dependents = new Set<string>();
    const tests = new Set<string>();
    const evidence: Array<{ path: string; reason: string; depth: number }> = [];
    let truncated = false;
    let unresolvedEdges = 0;
    let maxDepthReached = 0;

    const normalizedChanged = changedPaths.map(normalizeRelative);
    let currentLevel = [...normalizedChanged];
    for (const p of currentLevel) visited.add(p);

    for (let depth = 1; depth <= maxDepth; depth++) {
      if (currentLevel.length === 0) break;
      maxDepthReached = depth;
      const nextLevel = new Set<string>();
      for (const targetPath of currentLevel) {
        const rows = this.db!.prepare(
          "SELECT source_path, kind, reason FROM edges WHERE target_path=$path LIMIT 150",
        ).all({ $path: targetPath }) as Row[];

        if (rows.length >= 150) truncated = true;

        for (const row of rows) {
          const sourcePath = String(row.source_path);
          const kind = String(row.kind);
          const isTest = kind === "test_for" || /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\./i.test(sourcePath);

          if (isTest) {
            tests.add(sourcePath);
            evidence.push({ path: sourcePath, reason: `test_of_depth_${depth}_dependency`, depth });
          } else {
            dependents.add(sourcePath);
            evidence.push({ path: sourcePath, reason: `dependent_depth_${depth}`, depth });
            if (!visited.has(sourcePath)) {
              visited.add(sourcePath);
              if (nextLevel.size < limit) {
                nextLevel.add(sourcePath);
              } else {
                truncated = true;
              }
            }
          }
        }

        const unresolved = this.db!.prepare(
          "SELECT count(*) cnt FROM edges WHERE source_path=$path AND target_path IS NULL",
        ).get({ $path: targetPath }) as Row | undefined;
        if (unresolved) unresolvedEdges += Number(unresolved.cnt);
      }

      currentLevel = [...nextLevel];
    }

    const completeness = this.impactCompleteness(normalizedChanged, [...dependents], { unresolvedEdges, truncated });
    return {
      changedPaths: normalizedChanged,
      candidateDependents: [...dependents].slice(0, limit),
      candidateTests: [...tests].slice(0, limit),
      maxDepthReached,
      truncated: truncated || dependents.size > limit || tests.size > limit,
      unresolvedEdges,
      completeness,
      evidence: evidence.slice(0, limit * 2),
    };
  }

  private impactCompleteness(changedPaths: string[], dependents: string[], input: { unresolvedEdges: number; truncated: boolean }): AnalysisCompleteness {
    if (!this.indexIsReady()) return asAnalysisCompleteness("UNKNOWN", [`index_state:${this.state}`]);
    const reasons: string[] = [];
    if (input.truncated) reasons.push("traversal_truncated");
    if (input.unresolvedEdges > 0) reasons.push(`unresolved_edges:${input.unresolvedEdges}`);
    const scanPaths = [...new Set([...changedPaths, ...dependents])].slice(0, MAX_QUERY_LIMIT);
    if (scanPaths.length) {
      const statusPlaceholders = scanPaths.map((_, index) => `$st${index}`).join(",");
      const statusParams: Record<string, string> = {};
      scanPaths.forEach((p, index) => { statusParams[`$st${index}`] = p; });
      const rows = this.db!.prepare(`SELECT parser_status, COUNT(*) cnt FROM files WHERE path IN (${statusPlaceholders}) GROUP BY parser_status`).all(statusParams) as Row[];
      for (const row of rows) {
        const status = String(row.parser_status);
        const count = Number(row.cnt);
        if (status === "fallback") reasons.push(`fallback_parse_files:${count}`);
        if (status === "error") reasons.push(`parse_error_files:${count}`);
      }
      const dynamicRows = this.db!.prepare(`SELECT COUNT(*) cnt FROM calls WHERE kind IN ('dynamic_import','dynamic_require','computed_call','eval_call') AND path IN (${statusPlaceholders})`).get(statusParams) as Row | undefined;
      if (dynamicRows && Number(dynamicRows.cnt) > 0) reasons.push(`dynamic_constructs:${Number(dynamicRows.cnt)}`);
    }
    return reasons.length === 0 ? asAnalysisCompleteness("COMPLETE", []) : asAnalysisCompleteness("PARTIAL", reasons);
  }

  async estimateBlastRadius(
    changedPaths: string[],
    options: QueryOptions & { maxDepth?: number } = {},
  ): Promise<BlastRadiusEstimate> {
    const candidates = await this.getImpactCandidates(changedPaths, options);
    const total = candidates.candidateDependents.length + candidates.candidateTests.length;
    const confidence = asSymbolConfidence(
      candidates.unresolvedEdges > 5 || candidates.truncated ? "low" : total > 20 ? "medium" : "high",
    );
    return {
      targetPath: candidates.changedPaths[0] ?? "",
      candidateDependents: candidates.candidateDependents,
      candidateTests: candidates.candidateTests,
      depth: candidates.maxDepthReached,
      truncated: candidates.truncated,
      unresolvedEdges: candidates.unresolvedEdges,
      confidence,
      completeness: candidates.completeness,
      reasons: [
        `found ${candidates.candidateDependents.length} dependents and ${candidates.candidateTests.length} tests`,
        candidates.truncated ? "blast_radius_truncated_at_limit" : "blast_radius_within_bounds",
        candidates.unresolvedEdges > 0 ? `${candidates.unresolvedEdges}_unresolved_edges` : "all_edges_resolved",
      ],
    } as BlastRadiusEstimate;
  }

  async getRepositorySummary(): Promise<RepositorySummary> {
    const status = this.status();
    const packageRows = this.db!.prepare("SELECT DISTINCT specifier FROM edges WHERE kind='package_dependency' AND specifier IS NOT NULL").all() as Row[];
    const packages = packageRows.map((r) => String(r.specifier));
    const langRows = this.db!.prepare("SELECT language, count(*) cnt FROM files GROUP BY language").all() as Row[];
    const languages: Record<string, number> = {};
    for (const r of langRows) languages[String(r.language)] = Number(r.cnt);
    const entryRows = this.db!.prepare("SELECT path FROM files WHERE path LIKE '%index.ts' OR path LIKE '%main.ts' OR path LIKE '%index.js' OR path LIKE '%main.js'").all() as Row[];
    const entryPoints = entryRows.map((r) => String(r.path));
    const testRows = this.db!.prepare("SELECT DISTINCT source_path FROM edges WHERE kind='test_for' OR source_path LIKE '%.test.%' LIMIT 100").all() as Row[];
    const testLayout = testRows.map((r) => String(r.source_path));
    return {
      root: status.root,
      fileCount: status.fileCount,
      symbolCount: status.symbolCount,
      edgeCount: status.edgeCount,
      packages,
      languages,
      entryPoints,
      testLayout,
      indexState: status.state,
      generation: status.generation,
      graphGeneration: status.graphGeneration,
    };
  }

  startWatching(): void {
    if (!this.identity || !this.db) return;
    const { identity } = this.ensureOpen();
    this.stopWatching();
    try {
      if (!fs.existsSync(identity.realRoot)) return;
      this.watcher = fs.watch(identity.realRoot, { recursive: true }, (_event, fileName) => {
        if (!this.identity || !this.db) return;
        const relativePath = typeof fileName === "string" ? normalizeRelative(fileName) : "";
        if (relativePath && (relativePath === ".git" || relativePath.startsWith(".git/"))) return;
        if (relativePath) this.pendingWatchPaths.add(relativePath);
        else this.pendingWatchPaths.add("*");
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          if (!this.identity || !this.db) return;
          const paths = [...this.pendingWatchPaths];
          this.pendingWatchPaths.clear();
          const refreshPaths = paths.includes("*") || paths.length > 1_000 ? undefined : paths;
          void this.refresh(refreshPaths).catch(() => {
            if (this.state !== "ERROR") this.state = "STALE";
          });
        }, 300);
      });
      this.watcher.on("error", () => { if (this.state !== "ERROR") this.state = "STALE"; });
    } catch {
      this.state = this.state === "READY" ? "DEGRADED" : this.state;
    }
  }

  stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.pendingWatchPaths.clear();
    this.watcher?.close();
    this.watcher = undefined;
  }

  async closeWorkspace(): Promise<void> {
    this.stopWatching();
    await this.writeChain;
    this.db?.close(); this.db = undefined; this.identity = undefined; this.state = "NOT_INDEXED";
  }
}

export function createRepositoryIntelligence(options: RepositoryIntelligenceOptions = {}): RepositoryIntelligence {
  return new LocalRepositoryIntelligence(options);
}
