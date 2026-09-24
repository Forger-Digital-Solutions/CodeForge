#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "3c5e635f4981a8e8955bef25e22c851ef13c9a32e9c0507b1569100f69f92e1e";
const priorVersion = "r27-single-user-runtime-v1";
const changes = [
  { file: "packages/agent/src/index.ts", change: "Defines TOOL_NO_EFFECT as a distinct tool error code." },
  { file: "packages/server/src/agent-runtime.ts", change: "Rejects byte-identical writes and ends repeated no-effect mutation loops as blocked; the completion gate remains unchanged." },
  { file: "packages/server/src/duplicate-suppression.ts", change: "Tracks consecutive no-effect writes and clears the streak on a successful mutation." },
  { file: "packages/server/src/workflow-service.ts", change: "Adds bounded search and final-response guidance to the implementation prompt." },
  { file: "packages/tools/src/index.ts", change: "Rejects byte-identical file writes and replacements with a distinct TOOL_NO_EFFECT error." },
  { file: "packages/workflow/src/diff-review.ts", change: "Counts replacement lines as additions and deletions in diff receipts; review and completion authority remain unchanged." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R30 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R30 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R30 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R30 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r30-release-unblocking-v1";
const reason = "Recertify six reviewed R29 material changes after reproducing the source-state drift. The prior identity and every historical campaign receipt remain intact. No completion or ForgeZero policy is relaxed.";
const entry = {
  label: "R30 reviewed R29 source reconciliation",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r30-release-unblocking/02-regression/ and focused source-state tests",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R30_REVIEWED_R29_SOURCE_STATE",
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
document.generationNote = "The current source-state ID covers the reviewed material implementation through R30. Historical campaign evidence remains bound to its recorded source-state identity.";
const temporary = `${documentPath}.r30.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
fs.renameSync(temporary, documentPath);
console.log(JSON.stringify({ priorId, sourceStateId, changed }));
