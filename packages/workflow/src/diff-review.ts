import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { DiffEntry, ReviewDecision, ReviewFinding } from "./types.js";

/** A bounded pre-run snapshot. Binary content is identified and hashed but never retained as text. */
export type BeforeSnapshot =
  | { kind: "text"; content: string; size: number; hash: string }
  | { kind: "binary"; size: number; hash: string };

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
}

function computeDiff(relativePath: string, oldContent: string, newContent: string): { diff: string; truncated: boolean } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      if (o !== undefined) diffLines.push(`-${o}`);
      if (n !== undefined) diffLines.push(`+${n}`);
    }
  }
  let diff = diffLines.join("\n");
  let truncated = false;
  diff = redact(diff);
  if (Buffer.byteLength(diff, "utf-8") > 32 * 1024) {
    diff = Buffer.from(diff, "utf-8").subarray(0, 32 * 1024).toString("utf-8") + "\n[TRUNCATED diff]";
    truncated = true;
  }
  return { diff, truncated };
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

const VERIFICATION_SCRIPT_KEYS = ["test", "typecheck", "tsc", "check", "build", "lint", "pretest", "posttest"] as const;
const VERIFICATION_CONFIG_FILES = /(^|[\\/])(vitest\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|jest\.config\.json|\.mocharc(\.[a-z]+)?|pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|playwright\.config\.[cm]?[jt]s|karma\.conf\.[cm]?js|\.nycrc(\.[a-z]+)?)$/i;

/**
 * R21: the verification commands ForgeVerify runs are discovered from the repository's own
 * manifest (`package.json` scripts) and shaped by the test runner's configuration. A change that
 * edits those definitions can make verification trivially green (`"test": "echo ok"`,
 * `passWithNoTests: true`, an emptied `testMatch`) without touching a single test. Such a change
 * is not necessarily wrong, but it is never silent: it is a blocking review finding that a human
 * (or an explicit policy) must accept before the run can complete on the strength of a
 * verification it also rewrote.
 */
function verificationConfigFinding(entry: DiffEntry): ReviewFinding | undefined {
  const base = path.basename(entry.path).toLowerCase();
  if (base === "package.json") {
    const touched = VERIFICATION_SCRIPT_KEYS.filter((key) => new RegExp(`^[+-]\\s*"${key}"\\s*:`, "m").test(entry.diff));
    if (touched.length === 0 && !(entry.changeType === "deleted")) return undefined;
    return {
      code: "verification_config_modified",
      severity: "blocking",
      path: entry.path,
      message: entry.changeType === "deleted"
        ? `Verification manifest deleted: ${entry.path}`
        : `Verification script(s) ${touched.map((key) => `"${key}"`).join(", ")} changed in ${entry.path}; verification ran under a definition this change rewrote.`,
    };
  }
  if (VERIFICATION_CONFIG_FILES.test(entry.path)) {
    return {
      code: "verification_config_modified",
      severity: "blocking",
      path: entry.path,
      message: `Test-runner configuration ${entry.changeType}: ${entry.path}; verification ran under a configuration this change rewrote.`,
    };
  }
  return undefined;
}

function asSnapshot(content: string | BeforeSnapshot): BeforeSnapshot {
  if (typeof content !== "string") return content;
  return { kind: "text", content, size: Buffer.byteLength(content, "utf-8"), hash: sha256(content) };
}

const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_DIFF_MAX_BUFFER = 8 * 1024 * 1024;
const PER_FILE_DIFF_CAP = 32 * 1024;
const UNTRACKED_READ_CAP = 4 * 1024 * 1024;
const UNTRACKED_HASH_SAMPLE = 64 * 1024;

function runGitDiff(workspacePath: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync("git", args, { cwd: workspacePath, encoding: "utf-8", timeout: GIT_DIFF_TIMEOUT_MS, windowsHide: true, maxBuffer: GIT_DIFF_MAX_BUFFER });
    return { ok: res.status === 0 && typeof res.stdout === "string", stdout: res.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Returns the raw combined diff for the workspace, or null when git cannot answer at all.
 * An empty string means git answered and the tracked state is clean. `base` covers commits the
 * change made on top of it plus staged/unstaged edits; HEAD covers staged+unstaged when no base
 * is known; the final fallback handles an unborn HEAD where both ref forms fail.
 */
function getGitDiff(workspacePath: string, base?: string): string | null {
  if (base) {
    const res = runGitDiff(workspacePath, ["diff", "--no-color", base]);
    if (res.ok) return res.stdout;
  }
  const head = runGitDiff(workspacePath, ["diff", "--no-color", "HEAD"]);
  if (head.ok) return head.stdout;
  const unstaged = runGitDiff(workspacePath, ["diff", "--no-color"]);
  const staged = runGitDiff(workspacePath, ["diff", "--no-color", "--cached"]);
  if (!unstaged.ok && !staged.ok) return null;
  return `${unstaged.stdout}\n${staged.stdout}`;
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Normalizes one side of a git path reference: strips `a/`/`b/`, unquotes, maps /dev/null to absent. */
function normalizeSide(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "/dev/null") return undefined;
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? unquoteGitPath(trimmed) : trimmed;
  return unquoted.replace(/^[ab]\//, "");
}

/**
 * Recovers old/new paths from the `diff --git a/<old> b/<new>` header — the fallback for entries
 * with no `---`/`+++` lines (binary, pure mode change). Unquoted paths may contain spaces, so the
 * boundary is found by trying each " b/" split and preferring the one where both sides agree.
 */
function headerPaths(headerLine: string): { oldPath?: string; newPath?: string } {
  const line = headerLine.trim();
  const quoted = /^("a\/(?:\\.|[^"])*") ("b\/(?:\\.|[^"])*")$/.exec(line);
  if (quoted) return { oldPath: normalizeSide(quoted[1]), newPath: normalizeSide(quoted[2]) };
  if (!line.startsWith("a/")) return {};
  const boundaries: number[] = [];
  for (let i = line.indexOf(" b/"); i !== -1; i = line.indexOf(" b/", i + 1)) boundaries.push(i);
  const equal = boundaries.find((i) => line.slice(2, i) === line.slice(i + 3));
  const split = equal ?? boundaries[0];
  if (split === undefined) return {};
  return { oldPath: normalizeSide(line.slice(0, split)), newPath: normalizeSide(line.slice(split + 1)) };
}

/**
 * Parses combined `git diff` output into per-file entries so path-scoped checks (sensitive files,
 * verification manifests) see the file they describe rather than whichever path happened to lead
 * the status listing. Each entry's stored patch is bounded independently.
 */
function parseGitDiffEntries(raw: string): DiffEntry[] {
  if (!raw.trim()) return [];
  const entries: DiffEntry[] = [];
  const blocks = raw.split(/^diff --git /m);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const text = `diff --git ${block}`;
    const header = headerPaths(text.split("\n", 1)[0] ?? "");
    const minusLine = /^--- .+$/m.exec(text)?.[0];
    const plusLine = /^\+\+\+ .+$/m.exec(text)?.[0];
    const renameFrom = /^rename from (.+)$/m.exec(text)?.[1];
    const renameTo = /^rename to (.+)$/m.exec(text)?.[1];
    const oldPath = (minusLine ? normalizeSide(minusLine.slice(4)) : undefined)
      ?? (renameFrom ? unquoteGitPath(renameFrom) : undefined)
      ?? header.oldPath;
    const newPath = (plusLine ? normalizeSide(plusLine.slice(4)) : undefined)
      ?? (renameTo ? unquoteGitPath(renameTo) : undefined)
      ?? header.newPath;
    const filePath = newPath ?? oldPath;
    if (!filePath) continue;
    const isNew = /^new file mode /m.test(text);
    const isDeleted = /^deleted file mode /m.test(text);
    const binary = /^Binary files /m.test(text) || /^GIT binary patch/m.test(text);
    const indexMatch = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(text);
    const additions = (text.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (text.match(/^-[^-]/gm) ?? []).length;
    let diff = redact(binary ? "" : text);
    let truncated = false;
    if (Buffer.byteLength(diff, "utf-8") > PER_FILE_DIFF_CAP) {
      diff = `${Buffer.from(diff, "utf-8").subarray(0, PER_FILE_DIFF_CAP).toString("utf-8")}\n[TRUNCATED diff]`;
      truncated = true;
    }
    entries.push({
      path: filePath,
      changeType: isNew ? "created" : isDeleted ? "deleted" : "modified",
      additions,
      deletions,
      diff,
      beforeHash: indexMatch?.[1] ?? "",
      afterHash: indexMatch?.[2] ?? "",
      ...(binary ? { binary: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  }
  return entries;
}

/** Fingerprint for files too large to slurp: prefix bytes plus exact size — stable identity, no 4MB+ read. */
function hashFileSample(full: string, size: number): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(full, "r");
  try {
    const buffer = Buffer.alloc(Math.min(UNTRACKED_HASH_SAMPLE, size));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  hash.update(String(size));
  return hash.digest("hex");
}

/** Builds a `created` DiffEntry for a file git does not track (untracked porcelain rows). */
function createdEntryFromDisk(workspacePath: string, relPath: string): DiffEntry | undefined {
  const full = path.join(workspacePath, relPath);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return undefined;
    if (stat.size > UNTRACKED_READ_CAP) {
      return {
        path: relPath,
        changeType: "created",
        additions: 0,
        deletions: 0,
        diff: "",
        beforeHash: sha256(""),
        afterHash: hashFileSample(full, stat.size),
        beforeSize: 0,
        afterSize: stat.size,
        truncated: true,
      };
    }
    const after = fs.readFileSync(full);
    const afterHash = crypto.createHash("sha256").update(after).digest("hex");
    if (isBinary(after)) {
      return {
        path: relPath,
        changeType: "created",
        additions: 0,
        deletions: 0,
        diff: "",
        beforeHash: sha256(""),
        afterHash,
        binary: true,
        beforeSize: 0,
        afterSize: after.byteLength,
      };
    }
    const afterContent = after.toString("utf-8");
    const computed = computeDiff(relPath, "", afterContent);
    return {
      path: relPath,
      changeType: "created",
      additions: afterContent.split("\n").length,
      deletions: 0,
      diff: computed.diff,
      beforeHash: sha256(""),
      afterHash,
      beforeSize: 0,
      afterSize: after.byteLength,
      ...(computed.truncated ? { truncated: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function getGitStatusFiles(workspacePath: string): Array<{ path: string; status: string }> {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], { cwd: workspacePath, encoding: "utf-8", timeout: 5000, windowsHide: true });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim().replace(/^"/, "").replace(/"$/, "");
        return { path: file, status };
      });
  } catch {
    return [];
  }
}

export async function reviewDiff(
  workspacePath: string,
  options: { beforeSnapshots?: Map<string, string | BeforeSnapshot>; base?: string; sinceMs?: number; signal?: AbortSignal } = {},
): Promise<ReviewDecision> {
  if (options.signal?.aborted) throw new Error("Review aborted");

  const gitDiff = getGitDiff(workspacePath, options.base);
  const statusFiles = getGitStatusFiles(workspacePath);
  const diffs: DiffEntry[] = [];

  // If we have before snapshots, compute precise diffs regardless of git status (temp workspaces may not be git repos)
  if (options.beforeSnapshots) {
    for (const [relPath, storedBefore] of options.beforeSnapshots.entries()) {
      const before = asSnapshot(storedBefore);
      const full = path.join(workspacePath, relPath);
      let after: Buffer | undefined;
      let changeType: DiffEntry["changeType"] = "modified";
      try {
        if (fs.existsSync(full)) {
          after = fs.readFileSync(full);
        } else {
          changeType = "deleted";
        }
      } catch {
        continue;
      }

      const afterIsBinary = after ? isBinary(after) : false;
      const afterHash = after ? crypto.createHash("sha256").update(after).digest("hex") : sha256("");
      const afterSize = after?.byteLength ?? 0;
      if (before.hash === afterHash) continue;

      if (before.kind === "binary" || afterIsBinary) {
        diffs.push({
          path: relPath,
          changeType,
          additions: 0,
          deletions: 0,
          diff: "",
          beforeHash: before.hash,
          afterHash,
          binary: true,
          beforeSize: before.size,
          afterSize,
        });
        continue;
      }

      const afterContent = after ? after.toString("utf-8") : "";
      const computed = computeDiff(relPath, before.content, afterContent);
      const additions = afterContent.split("\n").length - before.content.split("\n").length;
      diffs.push({
        path: relPath,
        changeType,
        additions: Math.max(0, additions),
        deletions: Math.max(0, -additions),
        diff: computed.diff,
        beforeHash: before.hash,
        afterHash,
        beforeSize: before.size,
        afterSize,
        truncated: computed.truncated,
      });
    }
    // Detect new files not in snapshots (porcelain marks untracked as "??", index-new as "A?").
    // Snapshots skip dotfiles entirely, so an untouched pre-existing untracked file is
    // indistinguishable from a created one — when sinceMs is provided, the file must have been
    // touched after the snapshot to count as part of this change.
    for (const sf of statusFiles) {
      if (sf.status === "??" || sf.status.includes("A")) {
        if (options.beforeSnapshots.has(sf.path)) continue;
        if (options.sinceMs !== undefined) {
          try {
            if (fs.statSync(path.join(workspacePath, sf.path)).mtimeMs < options.sinceMs) continue;
          } catch { continue; }
        }
        const entry = createdEntryFromDisk(workspacePath, sf.path);
        if (entry) diffs.push(entry);
      }
    }
  } else if (gitDiff !== null) {
    // Git fallback: one entry per file so path-scoped findings bind to the file they describe,
    // then created entries for untracked files, which `git diff` never reports. A change that
    // only adds untracked files still reaches review rather than collapsing into "No diffs".
    diffs.push(...parseGitDiffEntries(gitDiff));
    const seen = new Set(diffs.map((d) => d.path));
    for (const sf of statusFiles) {
      if (sf.status !== "??" && !sf.status.includes("A")) continue;
      if (seen.has(sf.path)) continue;
      const entry = createdEntryFromDisk(workspacePath, sf.path);
      if (entry) {
        diffs.push(entry);
        seen.add(entry.path);
      }
    }
  }

  const issues: string[] = [];
  const findings: ReviewFinding[] = [];
  // Basic checks
  for (const d of diffs) {
    if (d.diff.includes("[REDACTED]")) {
      // not an issue; redaction is expected
    }
    if (d.diff.length > 30 * 1024) {
      const message = `Large diff in ${d.path} (${d.diff.length} bytes) — consider splitting`;
      issues.push(message);
      findings.push({ code: "oversized_diff", severity: "advisory", path: d.path, message });
    }
    if (d.path.includes("secret") || d.path.includes(".env")) {
      const message = `Sensitive file modified: ${d.path}`;
      issues.push(message);
      findings.push({ code: "sensitive_file", severity: "blocking", path: d.path, message });
    }
    const verificationConfig = verificationConfigFinding(d);
    if (verificationConfig) {
      issues.push(verificationConfig.message);
      findings.push(verificationConfig);
    }
  }

  const approved = issues.length === 0;
  const summary = diffs.length === 0
    ? "No diffs"
    : `${diffs.length} file(s) changed, ${issues.length} issue(s) — ${approved ? "approved" : "needs attention"}`;

  return { approved, issues, findings, diffs, summary };
}

export function formatDiffSummary(diffs: DiffEntry[]): string {
  if (diffs.length === 0) return "No changes";
  return diffs.map((d) => `${d.changeType} ${d.path} (+${d.additions} -${d.deletions})\n${d.diff.slice(0, 2000)}`).join("\n\n");
}
