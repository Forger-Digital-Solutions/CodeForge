#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "16d40300ecc8b7c91e998239dcfd932847d13c8bf285a74e71501923ed84cc97";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r57-endurance-product-fixes-v6" || document.materialFiles.length !== 65) {
  throw new Error("R58 recertification refused: unexpected R57 predecessor");
}
const added = [
  "apps/desktop/src/main.ts",
  "packages/protocol/src/subagent-runtime.ts",
  "packages/server/src/role-progress.ts",
];
if (added.some((file) => document.materialFiles.includes(file))) throw new Error("R58 material addition was already certified");
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  ...added,
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/autonomous-orchestrator.ts",
  "packages/server/src/index.ts",
  "packages/server/src/subagent-manager.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R58 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R58 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r58-progress-aware-autonomy-v1";
const reason = "R58 promotes the real packaged subagent runtime, removes the no-op coder success path, measures distinct tool effects and route latency for bounded coder leases, and checkpoints one sequential continuation after productive lease expiry. ForgeZero, ForgeVerify, and completion authority are unchanged.";
const entry = {
  label: "R58 progress-aware autonomy recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r58-progress-aware-autonomy/R58-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R58_PROGRESS_AWARE_AUTONOMY_V1_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
