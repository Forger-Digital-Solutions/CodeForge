#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "b4170e607417a2e0876adf121c6901b084cabd151d866a8f8506dd06e8518ef4";
const priorVersion = "r57-endurance-product-fixes-v5";
const priorEntry = document.recertifications.at(-1);
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion || document.materialFiles.length !== 63 || priorEntry?.resultingSourceStateId !== priorId) {
  throw new Error("R57 v6 recertification refused: v5 predecessor identity or material set changed");
}

const addedFiles = ["packages/server/src/checkpoint-service.ts", "packages/server/src/integration-service.ts"];
for (const addedFile of addedFiles) {
  if (document.materialFiles.includes(addedFile)) throw new Error(`R57 v6 recertification refused: ${addedFile} was already material`);
}
const files = [...document.materialFiles, ...addedFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R57 v6 recertification refused: duplicate material file");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/server/src/autonomous-orchestrator.ts", "packages/server/src/checkpoint-service.ts", "packages/server/src/integration-service.ts", "packages/server/src/workspace-service.ts"].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R57 v6 recertification refused: unreviewed material drift ${JSON.stringify(changed)}`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R57 v6 recertification refused: uncommitted material source ${dirty}`);
const committedDrift = execFileSync("git", ["diff", "--name-only", "3b8ffd3d9cb369fbff36897fe22d199de52403ba", "HEAD", "--", ...files], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).sort((a, b) => a.localeCompare(b));
const expectedCommittedDrift = ["packages/server/src/autonomous-orchestrator.ts", "packages/server/src/checkpoint-service.ts", "packages/server/src/index.ts", "packages/server/src/integration-service.ts", "packages/server/src/workspace-service.ts"].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(committedDrift) !== JSON.stringify(expectedCommittedDrift)) throw new Error(`R57 v6 recertification refused: committed drift ${JSON.stringify(committedDrift)}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r57-endurance-product-fixes-v6";
const reason = "The corrected packaged self-dogfood run still failed after isolated worktree creation: the checkpoint materialization checkout inside the child worktree could not rewrite deep tracked evidence paths on Windows. The per-invocation core.longpaths opt-in moved into the shared Git helpers of workspace, checkpoint, orchestrator, and integration services so every filesystem-facing call inside a managed worktree inherits it. No completion, routing, security, or accounting authority was relaxed.";
const entry = {
  label: "R57 endurance worktree-lifecycle recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: [
    { file: "packages/server/src/checkpoint-service.ts", change: "All checkpoint Git operations (status, clean, checkout materialization, read-tree, stash) now carry the per-invocation core.longpaths opt-in so restores inside managed worktrees can rewrite deep tracked paths.", addedToMaterialFiles: true },
    { file: "packages/server/src/integration-service.ts", change: "Integration Git operations inside the isolated worktree (status, add, commit, merge target) carry the same opt-in.", addedToMaterialFiles: true },
    { file: "packages/server/src/autonomous-orchestrator.ts", change: "Run-time diff/ls-files inspection inside the managed worktree carries the same opt-in.", addedToMaterialFiles: false },
    { file: "packages/server/src/workspace-service.ts", change: "The long-path opt-in moved from the two worktree-add call sites into the shared Git helper, covering worktree removal and status as well.", addedToMaterialFiles: false },
  ],
  regressionEvidence: "docs/evidence/r57-autonomous-endurance-learning/R57-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R57_ENDURANCE_PRODUCT_FIXES_V6_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed, committedDrift }));
