import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createVerificationInputStateHash } from "@codeforge/workflow";
import { redactSecrets } from "@codeforge/secrets";

export const REVIEWER_SNAPSHOT_BYTES = 48_000;

export interface ReviewerEvidenceBinding {
  workspacePath: string;
  inputStateHash: string;
  contextHash: string;
  complete: boolean;
}

export interface ReviewerEvidenceSnapshot {
  context: string;
  binding: ReviewerEvidenceBinding;
}

const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const sensitivePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:pem|p12|pfx|key)|id_(?:rsa|ed25519))$/i;

export async function buildReviewerEvidenceSnapshot(input: {
  workspacePath: string;
  baseRevision: string;
  diff: string;
  files: readonly string[];
  verificationCommands: readonly string[];
}): Promise<ReviewerEvidenceSnapshot> {
  const workspacePath = path.resolve(input.workspacePath);
  const before = createVerificationInputStateHash(workspacePath);
  const observations: Array<{ path: string; hash?: string; content?: string; unavailable?: string }> = [];
  let complete = Buffer.byteLength(input.diff, "utf8") < REVIEWER_SNAPSHOT_BYTES && redactSecrets(input.diff) === input.diff;
  let bytes = Buffer.byteLength(input.diff, "utf8");
  const paths = [...new Set(input.files)].sort();
  if (paths.length > 256) complete = false;
  for (const relative of paths.slice(0, 256)) {
    const resolved = path.resolve(workspacePath, relative);
    const confined = path.relative(workspacePath, resolved);
    if (!confined || confined.startsWith("..") || path.isAbsolute(confined) || sensitivePath.test(relative.replaceAll("\\", "/"))) {
      complete = false;
      observations.push({ path: relative, unavailable: "excluded from inference snapshot" });
      continue;
    }
    try {
      const stat = await fs.lstat(resolved);
      const real = await fs.realpath(resolved);
      const realRelative = path.relative(workspacePath, real);
      if (!stat.isFile() || stat.isSymbolicLink() || realRelative.startsWith("..") || path.isAbsolute(realRelative) || stat.size + bytes > REVIEWER_SNAPSHOT_BYTES) {
        complete = false;
        observations.push({ path: relative, unavailable: "unsupported file or snapshot capacity exceeded" });
        continue;
      }
      const buffer = await fs.readFile(resolved);
      const content = buffer.toString("utf8");
      if (buffer.includes(0) || !Buffer.from(content, "utf8").equals(buffer) || redactSecrets(content) !== content) {
        complete = false;
        observations.push({ path: relative, unavailable: "binary or sensitive content excluded" });
        continue;
      }
      bytes += buffer.length;
      observations.push({ path: relative.replaceAll("\\", "/"), hash: digest(content), content });
    } catch {
      complete = false;
      observations.push({ path: relative, unavailable: "file unavailable" });
    }
  }
  const context = JSON.stringify({
    schema: "workspace-review-snapshot/v1",
    baseRevision: input.baseRevision,
    diff: redactSecrets(input.diff),
    files: observations,
    verification: { status: "pending", commands: input.verificationCommands, note: "ForgeVerify has not run. Test source is evidence of assertions, not test success." },
  });
  complete &&= Buffer.byteLength(context, "utf8") <= REVIEWER_SNAPSHOT_BYTES && before === createVerificationInputStateHash(workspacePath);
  return { context, binding: { workspacePath, inputStateHash: before, contextHash: digest(context), complete } };
}

export function assertReviewerEvidenceCurrent(binding: ReviewerEvidenceBinding, workspacePath: string, context?: string): void {
  if (path.resolve(workspacePath) !== path.resolve(binding.workspacePath)
    || binding.inputStateHash !== createVerificationInputStateHash(workspacePath)
    || (context !== undefined && digest(context) !== binding.contextHash)) {
    throw new Error("REVIEWER_EVIDENCE_STALE: isolated workspace no longer matches the review snapshot");
  }
}
