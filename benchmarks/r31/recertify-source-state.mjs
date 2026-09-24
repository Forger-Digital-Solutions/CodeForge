#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "162cdd36424201706f972d52aaa966484237ea13c0ddebf1496d4a2a2c0d5368";
const priorVersion = "r30-large-task-rename-v2";
const changes = [
  { file: "packages/server/src/workflow-service.ts", change: "Wires the bounded independent goal-conformance review turn into the workflow pipeline (real-runtime executor only) and forwards CompletionBlocker.evidence through the completion event and persisted run inspection. Completion-gate authority is unchanged." },
  { file: "packages/workflow/src/types.ts", change: "Adds review/goal-conformance and blocker-evidence surface types used by the review turn and event adapter. No gate policy change." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R31 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R31 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R31 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R31 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r31-release-closure-v1";
const reason = "Recertify the reviewed R31 reliability changes: an independent bounded goal-conformance review after verification closes the R30 weak-visible-checks false-success class, and completion blockers now carry evidence end to end. Loop recovery (one bounded continuation after a post-edit no-progress turn) touched non-material packages only. ForgeZero, provider routing, and completion-gate authority are unchanged.";
const entry = {
  label: "R31 goal-conformance review and blocker evidence",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r31-production-release-closure/full-regression.log and docs/evidence/r31-production-release-closure/02-large-task-reliability/r31-acceptance-taxonomy.json",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R31_GOAL_REVIEW_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = {
  phase: entry.label,
  reason,
  changedFiles: changed,
  priorSourceStateId: priorId,
  guarded: true,
};
document.recertificationReason = reason;
document.generationNote = "The current source-state ID covers the reviewed material implementation through R31. Historical campaign evidence remains bound to its recorded source-state identity.";
const temporary = `${documentPath}.r31.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
fs.renameSync(temporary, documentPath);
console.log(JSON.stringify({ priorId, sourceStateId, changed }));
