import fs from "node:fs";
import path from "node:path";
import { resolveWithinWorkspace } from "./path-security.js";
import { redactSecrets } from "@codeforge/secrets";

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  preview: string;
}

export interface SearchOptions {
  query: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxFiles?: number;
  maxMatches?: number;
  maxBytes?: number;
  timeoutMs?: number;
  includeHidden?: boolean;
  workspacePath: string;
  signal?: AbortSignal;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  reason?: string;
  filesScanned: number;
  totalMatches: number;
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "out",
  ".turbo",
  ".parcel-cache",
  "target",
  "bin",
  "obj",
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_MATCHES = 500;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

function isBinaryLike(content: string): boolean {
  return content.includes("\0");
}

export async function searchWorkspace(options: SearchOptions): Promise<SearchResult> {
  const {
    query,
    regex = false,
    caseSensitive = false,
    maxFiles = DEFAULT_MAX_FILES,
    maxMatches = DEFAULT_MAX_MATCHES,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    workspacePath,
    signal,
  } = options;

  if (!workspacePath) {
    throw new Error("No workspace path configured");
  }
  if (!query) {
    throw new Error("Search query required");
  }
  if (Buffer.byteLength(query, "utf-8") > 4096) {
    throw new Error("Query too long");
  }

  let pattern: RegExp;
  try {
    if (regex) {
      pattern = new RegExp(query, caseSensitive ? "g" : "gi");
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, caseSensitive ? "g" : "gi");
    }
  } catch (e) {
    throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let totalMatches = 0;
  let truncated = false;
  let reason: string | undefined;

  const deadline = Date.now() + timeoutMs;
  const collectedBytes = { value: 0 };
  let sliceStartedAt = Date.now();
  let scopedFile: string | undefined;
  let searchRoot = workspacePath;
  if (options.path !== undefined) {
    if (typeof options.path !== "string") throw new Error("path must be a string");
    const scope = resolveWithinWorkspace(workspacePath, options.path);
    if (!scope.valid || !scope.resolvedPath) throw new Error(scope.error ?? "Path traversal denied");
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(scope.resolvedPath); }
    catch (error) { throw new Error(`Search path unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (stat.isDirectory()) searchRoot = scope.resolvedPath;
    else if (stat.isFile()) {
      scopedFile = scope.resolvedPath;
      searchRoot = path.dirname(scopedFile);
    } else throw new Error("Search path unavailable: expected a regular file or directory");
  }

  const yieldSlice = async (): Promise<void> => {
    if (Date.now() - sliceStartedAt < 30) return;
    await new Promise<void>(resolve => setImmediate(resolve));
    sliceStartedAt = Date.now();
  };

  function shouldAbort(): boolean {
    if (signal?.aborted) return true;
    if (Date.now() > deadline) return true;
    return false;
  }

  async function walk(dir: string): Promise<void> {
    if (shouldAbort()) {
      truncated = true;
      reason = signal?.aborted ? "cancelled" : "timeout";
      return;
    }
    if (filesScanned >= maxFiles || matches.length >= maxMatches || collectedBytes.value >= maxBytes) {
      truncated = true;
      reason = "limit exceeded";
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      await yieldSlice();
      if (shouldAbort() || matches.length >= maxMatches || collectedBytes.value >= maxBytes) {
        truncated = true;
        if (shouldAbort()) reason = signal?.aborted ? "cancelled" : "timeout";
        else reason = "limit exceeded";
        return;
      }
      if (!options.includeHidden && entry.name.startsWith(".") && entry.name !== ".gitignore") {
        if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
        // skip hidden files/dirs generally
        if (entry.name.startsWith(".")) continue;
      }
      if (DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (scopedFile && fullPath !== scopedFile) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        filesScanned++;
        if (filesScanned > maxFiles) {
          truncated = true;
          reason = "max files exceeded";
          return;
        }
        let content: string;
        try {
          content = await fs.promises.readFile(fullPath, { encoding: "utf-8", signal });
        } catch {
          continue;
        }
        if (isBinaryLike(content)) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (i % 64 === 0) await yieldSlice();
          if (shouldAbort() || matches.length >= maxMatches || collectedBytes.value >= maxBytes) {
            truncated = true;
            if (shouldAbort()) reason = signal?.aborted ? "cancelled" : "timeout";
            else reason = "limit exceeded";
            return;
          }
          const line = lines[i] ?? "";
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          // For non-regex, find all occurrences per line manually to avoid infinite loop on empty
          while ((m = pattern.exec(line)) !== null) {
            totalMatches++;
            if (matches.length < maxMatches) {
              const col = m.index;
              const rawText = m[0];
              const previewStart = Math.max(0, col - 40);
              const previewEnd = Math.min(line.length, col + rawText.length + 40);
              const previewRaw = line.slice(previewStart, previewEnd);
              const redactedPreview = redactSecrets(previewRaw);
              const redactedText = redactSecrets(rawText);
              const rel = path.relative(workspacePath, fullPath).split(path.sep).join("/");
              const bytes = Buffer.byteLength(redactedPreview, "utf-8");
              if (collectedBytes.value + bytes > maxBytes) {
                truncated = true;
                reason = "max bytes exceeded";
                return;
              }
              collectedBytes.value += bytes;
              matches.push({
                file: rel,
                line: i + 1,
                column: col + 1,
                text: redactedText.slice(0, 500),
                preview: redactedPreview.slice(0, 500),
              });
              if (matches.length >= maxMatches) {
                truncated = true;
                reason = "max matches exceeded";
                break;
              }
            }
            if (m[0].length === 0) pattern.lastIndex++;
            // Avoid unbounded per-line matches for pathological regex
            if (totalMatches > maxMatches * 2) break;
          }
        }
      }
    }
  }

  // Validate workspace exists and is directory
  try {
    const wsStat = await fs.promises.stat(workspacePath);
    if (!wsStat.isDirectory()) throw new Error("Workspace not a directory");
  } catch (e) {
    throw new Error(`Workspace unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  await walk(searchRoot);

  if (Date.now() > deadline && !reason) {
    truncated = true;
    reason = "timeout";
  }
  if (signal?.aborted && !reason) {
    truncated = true;
    reason = "cancelled";
  }

  return { matches, truncated, reason, filesScanned, totalMatches };
}

export function validateSearchPath(workspacePath: string, requestedPath: string | undefined): void {
  if (!requestedPath) return;
  const res = resolveWithinWorkspace(workspacePath, requestedPath);
  if (!res.valid) {
    throw new Error(res.error ?? "Path traversal denied");
  }
}
