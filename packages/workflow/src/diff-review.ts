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

function asSnapshot(content: string | BeforeSnapshot): BeforeSnapshot {
  if (typeof content !== "string") return content;
  return { kind: "text", content, size: Buffer.byteLength(content, "utf-8"), hash: sha256(content) };
}

function getGitDiff(workspacePath: string): string | null {
  try {
    const res = spawnSync("git", ["diff", "--no-color"], { cwd: workspacePath, encoding: "utf-8", timeout: 5000 });
    if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) {
      return redact(res.stdout.slice(0, 32 * 1024));
    }
  } catch {}
  return null;
}

function getGitStatusFiles(workspacePath: string): Array<{ path: string; status: string }> {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], { cwd: workspacePath, encoding: "utf-8", timeout: 5000 });
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
  options: { beforeSnapshots?: Map<string, string | BeforeSnapshot>; signal?: AbortSignal } = {},
): Promise<ReviewDecision> {
  if (options.signal?.aborted) throw new Error("Review aborted");

  const gitDiff = getGitDiff(workspacePath);
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
    // Detect new files not in snapshots
    for (const sf of statusFiles) {
      if (sf.status === "?" || sf.status === "A") {
        if (options.beforeSnapshots.has(sf.path)) continue;
        const full = path.join(workspacePath, sf.path);
        try {
          const after = fs.readFileSync(full);
          if (isBinary(after)) {
            diffs.push({
              path: sf.path,
              changeType: "created",
              additions: 0,
              deletions: 0,
              diff: "",
              beforeHash: sha256(""),
              afterHash: crypto.createHash("sha256").update(after).digest("hex"),
              binary: true,
              beforeSize: 0,
              afterSize: after.byteLength,
            });
            continue;
          }
          const afterContent = after.toString("utf-8");
          const computed = computeDiff(sf.path, "", afterContent);
          diffs.push({
            path: sf.path,
            changeType: "created",
            additions: afterContent.split("\n").length,
            deletions: 0,
            diff: computed.diff,
            beforeHash: sha256(""),
            afterHash: crypto.createHash("sha256").update(after).digest("hex"),
            beforeSize: 0,
            afterSize: after.byteLength,
            truncated: computed.truncated,
          });
        } catch {}
      }
    }
  } else if (gitDiff) {
    // Fallback: parse git diff into one entry
    diffs.push({
      path: statusFiles[0]?.path ?? "workspace",
      changeType: "modified",
      additions: (gitDiff.match(/^\+[^+]/gm) ?? []).length,
      deletions: (gitDiff.match(/^-[^-]/gm) ?? []).length,
      diff: gitDiff,
      beforeHash: "",
      afterHash: "",
    });
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
