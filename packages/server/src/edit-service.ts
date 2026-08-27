import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveWithinWorkspace } from "./path-security.js";
import { redactSecrets } from "@codeforge/secrets";

export interface EditResult {
  success: boolean;
  path: string;
  beforeHash: string;
  afterHash?: string;
  diff?: string;
  error?: string;
  bytesWritten?: number;
}

export interface ReplaceExactParams {
  workspacePath: string;
  relativePath: string;
  oldText: string;
  newText: string;
  expectedOccurrences?: number;
  expectedHash?: string;
}

const MAX_DIFF_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

export function computeDiff(relativePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) diffLines.push(`-${oldLine}`);
      if (newLine !== undefined) diffLines.push(`+${newLine}`);
    }
  }
  let diff = diffLines.join("\n");
  diff = redactSecrets(diff);
  if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
    diff = Buffer.from(diff, "utf-8").subarray(0, MAX_DIFF_BYTES).toString("utf-8") + "\n[TRUNCATED diff]";
  }
  return diff;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
    if (count > 10000) break;
  }
  return count;
}

export function replaceExact(params: ReplaceExactParams): EditResult {
  const { workspacePath, relativePath, oldText, newText, expectedOccurrences = 1, expectedHash } = params;

  const validation = resolveWithinWorkspace(workspacePath, relativePath);
  if (!validation.valid || !validation.resolvedPath) {
    return { success: false, path: relativePath, beforeHash: "", error: validation.error ?? "Path traversal denied" };
  }
  const resolvedPath = validation.resolvedPath;

  // Symlink escape already checked by resolveWithinWorkspace, but double-check realpath containment for write target dir
  try {
    const dirReal = (() => {
      const dir = path.dirname(resolvedPath);
      try {
        return fs.realpathSync(dir);
      } catch {
        // dir may not exist yet — check parent chain
        let cur = dir;
        for (;;) {
          try {
            return fs.realpathSync(cur);
          } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return dir;
            cur = parent;
          }
        }
      }
    })();
    // Validate dirReal inside workspace
    const wsReal = (() => {
      try { return fs.realpathSync(workspacePath); } catch { return path.resolve(workspacePath); }
    })();
    const rel = path.relative(wsReal, dirReal);
    const escapes = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
    if (escapes) {
      return { success: false, path: relativePath, beforeHash: "", error: `Path traversal denied: ${relativePath}` };
    }
  } catch {
    // ignore and continue to lexical check already done
  }

  let currentContent: string;
  let beforeHash: string;
  const fileExists = fs.existsSync(resolvedPath);
  if (!fileExists) {
    if (oldText !== "") {
      return { success: false, path: relativePath, beforeHash: sha256(""), error: `File not found: ${relativePath}` };
    }
    currentContent = "";
    beforeHash = sha256("");
    if (expectedHash && expectedHash !== beforeHash) {
      return { success: false, path: relativePath, beforeHash, error: `Stale edit: expected hash ${expectedHash.slice(0, 8)} but current is ${beforeHash.slice(0, 8)}` };
    }
    // Creation via empty oldText
    const diff = computeDiff(relativePath, "", newText);
    try {
      atomicWrite(resolvedPath, newText);
    } catch (e) {
      return { success: false, path: relativePath, beforeHash, error: `Write failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const afterHash = sha256(newText);
    return { success: true, path: relativePath, beforeHash, afterHash, diff, bytesWritten: Buffer.byteLength(newText, "utf-8") };
  }

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { success: false, path: relativePath, beforeHash: "", error: `Not a file: ${relativePath}` };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { success: false, path: relativePath, beforeHash: "", error: `File too large: ${stat.size} bytes` };
    }
  } catch (e) {
    return { success: false, path: relativePath, beforeHash: "", error: `Stat failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    currentContent = fs.readFileSync(resolvedPath, "utf-8");
  } catch (e) {
    return { success: false, path: relativePath, beforeHash: "", error: `Read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (currentContent.includes("\0")) {
    return { success: false, path: relativePath, beforeHash: sha256(currentContent), error: "Binary file not editable" };
  }
  beforeHash = sha256(currentContent);

  if (expectedHash && expectedHash !== beforeHash) {
    return {
      success: false,
      path: relativePath,
      beforeHash,
      error: `Stale edit: file changed since read. Expected ${expectedHash.slice(0, 12)} got ${beforeHash.slice(0, 12)}. Re-read and retry.`,
    };
  }

  const occurrences = countOccurrences(currentContent, oldText);
  if (occurrences === 0) {
    return { success: false, path: relativePath, beforeHash, error: `Exact replacement failed: oldText not found (${oldText.slice(0, 80)}...)` };
  }
  if (occurrences !== expectedOccurrences) {
    return {
      success: false,
      path: relativePath,
      beforeHash,
      error: `Ambiguous replacement: found ${occurrences} occurrences, expected ${expectedOccurrences}. Refine oldText to be unique.`,
    };
  }

  const newContent = currentContent.replace(oldText, newText);
  if (Buffer.byteLength(newContent, "utf-8") > MAX_FILE_BYTES) {
    return { success: false, path: relativePath, beforeHash, error: "Resulting file too large" };
  }

  const diff = computeDiff(relativePath, currentContent, newContent);

  try {
    atomicWrite(resolvedPath, newContent);
  } catch (e) {
    return { success: false, path: relativePath, beforeHash, error: `Atomic write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const afterHash = sha256(newContent);
  return { success: true, path: relativePath, beforeHash, afterHash, diff, bytesWritten: Buffer.byteLength(newContent, "utf-8") };
}

export function readFileWithHash(workspacePath: string, relativePath: string): { content: string; hash: string; bytes: number } {
  const validation = resolveWithinWorkspace(workspacePath, relativePath);
  if (!validation.valid || !validation.resolvedPath) {
    throw new Error(validation.error ?? "Path traversal denied");
  }
  const content = fs.readFileSync(validation.resolvedPath, "utf-8");
  if (content.includes("\0")) throw new Error("Binary file not readable as text");
  return { content, hash: sha256(content), bytes: Buffer.byteLength(content, "utf-8") };
}

function atomicWrite(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.cf-tmp-${crypto.randomUUID()}-${path.basename(targetPath)}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8" });
    try {
      const fd = fs.openSync(tmpPath, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* fsync best-effort */ }
    fs.renameSync(tmpPath, targetPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export function multiReplaceExact(
  workspacePath: string,
  edits: Array<{ path: string; oldText: string; newText: string; expectedOccurrences?: number; expectedHash?: string }>,
): Array<EditResult> {
  const results: EditResult[] = [];
  for (const e of edits) {
    const r = replaceExact({
      workspacePath,
      relativePath: e.path,
      oldText: e.oldText,
      newText: e.newText,
      expectedOccurrences: e.expectedOccurrences,
      expectedHash: e.expectedHash,
    });
    results.push(r);
  }
  return results;
}
