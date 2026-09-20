import fs from "node:fs";
import path from "node:path";

/**
 * R21 campaign evidence sink. When `R21_EVIDENCE_DIR` is set, each call appends one JSON line
 * to `<dir>/<name>.jsonl` so a campaign run of the suite leaves machine-readable evidence
 * behind. Without the variable it is a no-op, so ordinary test runs never write outside the
 * repository's temp directories.
 */
export function recordR21Evidence(name: string, record: Record<string, unknown>): void {
  const dir = process.env.R21_EVIDENCE_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.jsonl`), `${JSON.stringify({ recordedAt: new Date().toISOString(), ...record })}\n`);
  } catch {
    // Evidence capture must never fail a test.
  }
}
