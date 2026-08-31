import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openSqliteDatabase, type SQLiteDatabase } from "@codeforge/sessions";
import { detectLanguage, parseStructuredFallback, parseTypeScript } from "./languages.js";
import {
  REPOSITORY_INDEX_VERSION,
  REPOSITORY_PARSER_VERSION,
  type IndexProgress,
  type IndexStatus,
  type QueryOptions,
  type QueryPage,
  type RefreshResult,
  type RepositoryEdge,
  type RepositoryFile,
  type RepositoryIntelligence,
  type RepositoryIntelligenceOptions,
  type RepositoryMatch,
  type RepositorySymbol,
  type WorkspaceIdentity,
} from "./types.js";

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
  };
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
    const id = sha256([path.normalize(realRoot), path.normalize(gitWorktreeDirectory ?? realRoot), repositoryFingerprint].join("\0")).slice(0, 40);
    this.identity = { id, root: resolved, realRoot, gitCommonDirectory, gitWorktreeDirectory, repositoryFingerprint };
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
      CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, target_path TEXT, source_symbol_id TEXT, target_symbol_id TEXT, specifier TEXT, confidence TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_path, kind); CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_path, kind);
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
    const listed = execGit(identity.realRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const statuses = new Map<string, string>();
    const statusRaw = execGit(identity.realRoot, ["status", "--porcelain=v1", "-z"]);
    if (statusRaw) {
      const parts = statusRaw.split("\0").filter(Boolean);
      for (const part of parts) statuses.set(normalizeRelative(part.slice(3)), part.slice(0, 2));
    }
    const trackedRaw = execGit(identity.realRoot, ["ls-files", "-z"]);
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
      const result = await this.refreshInternal(discovered.map((entry) => entry.path), signal, discovered, started);
      void result;
      return this.status();
    });
  }

  async refresh(paths?: string[], signal?: AbortSignal): Promise<RefreshResult> {
    return this.serialWrite(async () => {
      const started = Date.now();
      const requested = paths?.map(normalizeRelative);
      const discovered = requested
        ? requested.flatMap((relativePath) => {
            const absolute = safeRealFile(this.identity!.realRoot, relativePath);
            if (!absolute) return [];
            const existing = this.db!.prepare("SELECT tracked,git_status FROM files WHERE path=$path").get({ $path: relativePath }) as Row | undefined;
            return [{ path: relativePath, tracked: Number(existing?.tracked) === 1, gitStatus: existing?.git_status == null ? undefined : String(existing.git_status) }];
          })
        : this.discover();
      return this.refreshInternal(requested, signal, discovered, started);
    });
  }

  private async serialWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
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
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const removed of deleted) this.deleteFile(removed, true);
      let processed = 0;
      for (const relativePath of targets) {
        if (signal?.aborted) throw new Error("Repository indexing cancelled");
        const discovery = discoveredByPath.get(relativePath);
        if (!discovery) continue;
        const absolute = safeRealFile(identity.realRoot, relativePath);
        if (!absolute) continue;
        const stat = fs.statSync(absolute);
        const previous = existing.get(relativePath);
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) { unchanged++; processed++; continue; }
        const extension = path.extname(relativePath).toLowerCase();
        const generated = normalizeRelative(relativePath).split("/").some((segment) => GENERATED_SEGMENTS.has(segment));
        const sensitive = SENSITIVE_NAMES.test(relativePath);
        const tooLarge = stat.size > this.options.maxFileBytes;
        const prefix = Buffer.alloc(Math.min(stat.size, 8192));
        const handle = fs.openSync(absolute, "r");
        try { fs.readSync(handle, prefix, 0, prefix.length, 0); } finally { fs.closeSync(handle); }
        const binary = BINARY_EXTENSIONS.has(extension) || binaryPrefix(prefix);
        const hash = tooLarge ? sha256(Buffer.concat([prefix, Buffer.from(`:${stat.size}`)])) : sha256(fs.readFileSync(absolute));
        if (previous?.hash === hash) {
          db.prepare("UPDATE files SET mtime_ms=$mtime,size=$size,git_status=$git WHERE path=$path").run({ $mtime: stat.mtimeMs, $size: stat.size, $git: discovery.gitStatus ?? null, $path: relativePath });
          unchanged++; processed++; continue;
        }
        if (previous) changed.push(relativePath); else added.push(relativePath);
        let content = "";
        let parserStatus: RepositoryFile["parserStatus"] = "skipped";
        let parserError: string | undefined;
        let symbols: RepositorySymbol[] = [];
        let edges: RepositoryEdge[] = [];
        const language = detectLanguage(relativePath, prefix.toString("utf8"));
        if (!binary && !tooLarge) {
          content = fs.readFileSync(absolute, "utf8");
          if (content.includes("\0")) {
            parserStatus = "skipped";
          } else if (["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(language)) {
            const parsed = parseTypeScript(relativePath, content, knownPaths);
            symbols = parsed.symbols; edges = parsed.edges; parserError = parsed.error;
            parserStatus = parsed.error ? "error" : "parsed";
          } else {
            symbols = parseStructuredFallback(relativePath, language, content);
            parserStatus = symbols.length ? "fallback" : "parsed";
          }
        }
        if (parserError) errors++;
        this.deleteFile(relativePath);
        const file: RepositoryFile = { path: relativePath, language, size: stat.size, mtimeMs: stat.mtimeMs, hash, lines: content ? content.split(/\r?\n/).length : 0, binary, generated, sensitive, tracked: discovery.tracked, gitStatus: discovery.gitStatus, parserStatus, parserError };
        this.insertFile(file);
        for (const symbol of symbols) this.insertSymbol(symbol);
        for (const edge of edges) this.insertEdge(edge);
        this.insertTestEdges(file, knownPaths);
        if (!binary && !tooLarge && !sensitive) db.prepare("INSERT INTO content_fts(path,content) VALUES($path,$content)").run({ $path: relativePath, $content: content });
        symbolsIndexed += symbols.length; edgesIndexed += edges.length;
        processed++;
        if (processed % this.options.batchSize === 0) {
          this.progress("parse", targets.length, processed, symbolsIndexed, edgesIndexed, errors, started);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      this.insertPackageEdges();
      const now = new Date().toISOString();
      const branch = execGit(identity.realRoot, ["branch", "--show-current"]);
      const head = execGit(identity.realRoot, ["rev-parse", "HEAD"]);
      this.writeMeta("branch", branch ?? ""); this.writeMeta("head", head ?? "");
      this.writeMeta("updated_at", now); if (!this.meta("created_at")) this.writeMeta("created_at", now);
      this.writeMeta("last_successful_update", now);
      this.state = errors ? "DEGRADED" : "READY";
      this.writeMeta("state", this.state);
      db.exec("COMMIT");
      this.progress("ready", targets.length, targets.length, symbolsIndexed, edgesIndexed, errors, started);
      return { added, changed, deleted, unchanged, durationMs: Date.now() - started };
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

  private insertEdge(edge: RepositoryEdge): void {
    this.db!.prepare("INSERT OR REPLACE INTO edges(id,kind,source_path,target_path,source_symbol_id,target_symbol_id,specifier,confidence,reason) VALUES($id,$kind,$source,$target,$sourceSymbol,$targetSymbol,$specifier,$confidence,$reason)").run({ $id: edge.id, $kind: edge.kind, $source: edge.sourcePath, $target: edge.targetPath ?? null, $sourceSymbol: edge.sourceSymbolId ?? null, $targetSymbol: edge.targetSymbolId ?? null, $specifier: edge.specifier ?? null, $confidence: edge.confidence, $reason: edge.reason });
  }

  private insertTestEdges(file: RepositoryFile, knownPaths: Set<string>): void {
    if (!/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^.]+$/i.test(file.path)) return;
    const base = path.posix.basename(file.path).replace(/\.(?:test|spec)(?=\.)/i, "");
    const candidates = [...knownPaths].filter((candidate) => candidate !== file.path && path.posix.basename(candidate) === base && !/(?:test|spec)\./i.test(candidate));
    for (const targetPath of candidates.slice(0, 20)) this.insertEdge({ id: sha256(`test_for\0${file.path}\0${targetPath}`), kind: "test_for", sourcePath: file.path, targetPath, confidence: "medium", reason: "test_filename_convention" });
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
        this.insertEdge({ id: sha256(`package_dependency\0${manifest.path}\0${name}`), kind: "package_dependency", sourcePath: manifest.path, targetPath, specifier: name, confidence: "high", reason: targetPath ? "workspace_package_dependency" : "package_manifest_dependency" });
      }
    }
  }

  status(): IndexStatus {
    const { db, identity } = this.ensureOpen();
    const counts = db.prepare("SELECT (SELECT count(*) FROM files) file_count,(SELECT count(*) FROM symbols) symbol_count,(SELECT count(*) FROM edges) edge_count,(SELECT count(*) FROM files WHERE parser_status='error') error_count").get() as Row;
    let sizeBytes = 0; try { sizeBytes = fs.statSync(this.indexPath).size; } catch {}
    return { state: this.state, workspaceId: identity.id, root: identity.root, indexPath: this.indexPath, indexVersion: REPOSITORY_INDEX_VERSION, parserVersion: REPOSITORY_PARSER_VERSION, fileCount: Number(counts.file_count), symbolCount: Number(counts.symbol_count), edgeCount: Number(counts.edge_count), errorCount: Number(counts.error_count), lastSuccessfulUpdate: this.meta("last_successful_update"), createdAt: this.meta("created_at"), updatedAt: this.meta("updated_at"), sizeBytes };
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
      for (const match of (await this.searchFiles(tokens.join("-"), { limit: 100 })).items) add({ ...match, score: match.score + 20, reasons: [...match.reasons, "multi_token_path_match"] });
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
