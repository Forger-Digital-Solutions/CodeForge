import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { RepoMap, TaskIntent } from "./types.js";

const MAX_FILE_READ_BYTES = 100 * 1024;
const MAX_FILE_READ_LINES = 400;
const MAX_FILES_SCANNED = 5000;
const MAX_MATCHES = 500;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo", "out"]);
const EXCLUDED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".gz"]);

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  try {
    const buf = fs.readFileSync(filePath);
    const slice = buf.subarray(0, 4096);
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function collectFiles(workspacePath: string): string[] {
  const results: string[] = [];
  const stack: string[] = [workspacePath];
  let scanned = 0;
  while (stack.length > 0 && scanned < MAX_FILES_SCANNED) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") {
        if (isExcludedDir(entry.name)) continue;
      }
      if (isExcludedDir(entry.name)) continue;
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
        scanned++;
        if (scanned >= MAX_FILES_SCANNED) break;
      } else if (entry.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(full);
          const stat = fs.statSync(real);
          if (stat.isDirectory()) {
            // Do not follow symlinked dirs outside workspace
            const wsReal = fs.realpathSync(workspacePath);
            const rel = path.relative(wsReal, real);
            if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
            stack.push(real);
          } else if (stat.isFile()) {
            results.push(full);
          }
        } catch {
          // ignore broken symlink
        }
      }
    }
  }
  return results;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function searchInFile(filePath: string, query: string, isRegex: boolean): Array<{ line: number; column: number; preview: string }> {
  if (isBinaryFile(filePath)) return [];
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return [];
    content = fs.readFileSync(filePath, "utf-8");
    if (content.includes("\0")) return [];
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const matches: Array<{ line: number; column: number; preview: string }> = [];
  let regex: RegExp | null = null;
  if (isRegex) {
    try {
      regex = new RegExp(query, "i");
    } catch {
      regex = null;
    }
  }
  const lowerQuery = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let idx = -1;
    if (regex) {
      const m = regex.exec(line);
      if (m) idx = m.index;
    } else {
      idx = line.toLowerCase().indexOf(lowerQuery);
    }
    if (idx !== -1) {
      const preview = line.trim().slice(0, 200);
      // redact secrets in preview lightly
      const redacted = preview.replace(/sk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]").replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]");
      matches.push({ line: i + 1, column: idx + 1, preview: redacted });
      if (matches.length >= 10) break;
    }
  }
  return matches;
}

export async function inspectRepository(
  workspacePath: string,
  intent: TaskIntent,
  options: { signal?: AbortSignal; maxMatches?: number } = {},
): Promise<RepoMap> {
  if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error(`Workspace not found: ${workspacePath}`);
  }
  if (options.signal?.aborted) throw new Error("Inspection aborted");

  const allFiles = collectFiles(workspacePath);
  const fileInfos = allFiles
    .map((full) => {
      try {
        const stat = fs.statSync(full);
        const rel = path.relative(workspacePath, full);
        const contentPreview = fs.readFileSync(full, "utf-8").split("\n");
        return { path: full, relativePath: rel, size: stat.size, lines: contentPreview.length };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ path: string; relativePath: string; size: number; lines: number }>;

  // Search using keywords from intent, plus task title tokens
  const queries = [...new Set([...intent.keywords.slice(0, 8), ...intent.title.split(/\W+/).filter((t) => t.length >= 3).map((t) => t.toLowerCase())])].slice(0, 10);
  const matches: Array<{ file: string; line: number; column: number; preview: string }> = [];
  const maxMatches = options.maxMatches ?? MAX_MATCHES;
  let truncated = false;

  for (const query of queries) {
    if (query.length < 2) continue;
    if (options.signal?.aborted) break;
    for (const file of allFiles) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      const fileMatches = searchInFile(file, query, false);
      for (const m of fileMatches) {
        const rel = path.relative(workspacePath, file);
        matches.push({ file: rel, line: m.line, column: m.column, preview: m.preview });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }

  // Read top relevant files: files with most matches first, then smallest files
  const fileMatchCounts = new Map<string, number>();
  for (const m of matches) {
    fileMatchCounts.set(m.file, (fileMatchCounts.get(m.file) ?? 0) + 1);
  }
  const sortedByRelevance = [...fileInfos].sort((a, b) => {
    const ca = fileMatchCounts.get(a.relativePath) ?? 0;
    const cb = fileMatchCounts.get(b.relativePath) ?? 0;
    if (cb !== ca) return cb - ca;
    return a.size - b.size;
  });
  const toRead = sortedByRelevance.slice(0, 10);
  const readFiles: RepoMap["readFiles"] = [];
  for (const info of toRead) {
    if (options.signal?.aborted) break;
    try {
      const raw = fs.readFileSync(info.path, "utf-8");
      if (raw.includes("\0")) continue;
      const hash = sha256(raw);
      const lines = raw.split("\n").length;
      let content = raw;
      let truncatedRead = false;
      if (lines > MAX_FILE_READ_LINES || Buffer.byteLength(raw, "utf-8") > MAX_FILE_READ_BYTES) {
        const truncatedLines = raw.split("\n").slice(0, MAX_FILE_READ_LINES).join("\n");
        const buf = Buffer.from(truncatedLines, "utf-8");
        content = buf.length > MAX_FILE_READ_BYTES ? buf.subarray(0, MAX_FILE_READ_BYTES).toString("utf-8") : truncatedLines;
        truncatedRead = true;
      }
      // light redaction for storage
      const redacted = content.replace(/sk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]");
      readFiles.push({ path: info.relativePath, content: redacted, hash, lines, truncated: truncatedRead });
    } catch {
      // skip
    }
  }

  // If no matches, ensure at least package.json / README considered
  if (readFiles.length === 0 && fileInfos.length > 0) {
    for (const cand of ["package.json", "README.md", "src/index.ts", "index.ts"]) {
      const found = fileInfos.find((f) => f.relativePath === cand || f.relativePath.endsWith("/" + cand));
      if (found) {
        try {
          const raw = fs.readFileSync(found.path, "utf-8");
          readFiles.push({ path: found.relativePath, content: raw.slice(0, 5000), hash: sha256(raw), lines: raw.split("\n").length, truncated: false });
        } catch {}
      }
    }
  }

  return {
    workspacePath,
    files: fileInfos.map((f) => ({ path: f.path, relativePath: f.relativePath, size: f.size, lines: f.lines })),
    searchedMatches: matches,
    readFiles,
  };
}

export function getWorkspaceFileTree(workspacePath: string, maxDepth = 3): unknown[] {
  function build(dir: string, depth: number): unknown[] {
    if (depth > maxDepth) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
      if (isExcludedDir(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(workspacePath, full);
      if (e.isDirectory()) {
        out.push({ name: e.name, path: rel, type: "directory", children: build(full, depth + 1) });
      } else {
        out.push({ name: e.name, path: rel, type: "file" });
      }
    }
    return out;
  }
  return build(workspacePath, 0);
}
