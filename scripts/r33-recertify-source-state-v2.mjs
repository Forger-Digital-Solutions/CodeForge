#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const priorSourceStateId = "bd2f90f6ea49cb420c9e0f3021ae34bb2db055b453ef169f8e2e27f6eb864441";
const priorSurfaceVersion = "r33-free-capacity-fabric-interim-v1";
const changedFilesExpected = [
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/workflow-service.ts",
  "packages/sessions/src/session-state.ts",
];

if (doc.sourceStateId !== priorSourceStateId || doc.surfaceVersion !== priorSurfaceVersion) {
  throw new Error("R33 recertification refused: certified predecessor changed.");
}
if (!Array.isArray(doc.materialFiles) || !Array.isArray(doc.recertifications)) {
  throw new Error("R33 recertification refused: source-state document shape is invalid.");
}
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(materialFiles).size !== materialFiles.length) {
  throw new Error("R33 recertification refused: duplicate material files.");
}
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const changedFiles = entries.filter((entry) => doc.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
if (JSON.stringify(changedFiles) !== JSON.stringify(changedFilesExpected)) {
  throw new Error(`R33 recertification refused: unreviewed drift ${JSON.stringify(changedFiles)}.`);
}
const uncommittedMaterial = execFileSync("git", ["status", "--porcelain", "--", ...materialFiles], { cwd: repoRoot, encoding: "utf8" }).trim();
if (uncommittedMaterial) {
  throw new Error(`R33 recertification refused: material source has uncommitted edits: ${uncommittedMaterial}`);
}

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const surfaceVersion = "r33-free-capacity-fabric-interim-v2";
const recertifiedAt = new Date().toISOString();
const reason = "Record the reviewed R33 durable capacity-wait changes: turns park on waiting_for_free_capacity (persisted via free_capacity_wait work items including a midTurn flag in session-state), resume only on fresh fabric admission, defer workflow timeout and working budget while parked, and route reviewer admission to an independent physical pool. Completion-gate, ForgeVerify, and ForgeZero zero-billing authority are unchanged. This is an interim source identity, not final R33 release certification.";
const recertification = {
  label: "R33 durable capacity waiting and reviewer pool independence",
  reason,
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: surfaceVersion,
  changes: [
    {
      file: "packages/server/src/agent-runtime.ts",
      change: "Capacity exhaustion now parks turns in durable waiting_for_free_capacity (admission-time and mid-turn), with sweeper/probe resumption, stable reservation identity, restart recovery, and reviewer pool-independence hints. No path to completed bypasses the completion gate.",
      addedToMaterialFiles: false,
    },
    {
      file: "packages/server/src/workflow-service.ts",
      change: "waitForTurn observes the parked state, polls with fresh admission decisions, defers the workflow timeout while an owned turn waits on capacity, and forwards the implement turn's capacityPoolId as preferIndependentFromPoolId to goal review.",
      addedToMaterialFiles: false,
    },
    {
      file: "packages/sessions/src/session-state.ts",
      change: "free_capacity_wait work items persist a midTurn flag so restart recovery re-arms the sweeper and marks mid-flight waits for the no-replay resume directive.",
      addedToMaterialFiles: false,
    },
  ],
  regressionEvidence: "docs/evidence/r33-free-capacity-fabric/INTERIM-CERTIFICATION.md and load-simulation/README.md; focused server/eight-bit/forge-zero/benchmark/UI suites and the 1M production-ledger control-plane run recorded there.",
  recertifiedAt: recertifiedAt.slice(0, 10),
  sourceStateConstant: "CODEFORGE_R33_INTERIM_FREE_CAPACITY_SOURCE_STATE_V2",
};

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = surfaceVersion;
doc.materialFiles = materialFiles;
doc.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
doc.recertifications.push(recertification);
doc.recertifiedAt = recertifiedAt;
doc.recertification = { phase: recertification.label, reason, changedFiles, priorSourceStateId, guarded: true };
doc.recertificationReason = reason;
doc.generationNote = "This interim source-state ID is derived from the reviewed FG-8 through R33 material implementation surface by packages/forgegreen-campaign/src/source-state.ts. Historical R32 and interim-v1 evidence remains bound to its prior identity; this is not final R33 release certification.";

const temporaryPath = `${docPath}.r33-recertification.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, docPath);
console.log(JSON.stringify({ sourceStateId, surfaceVersion, changedFiles, materialFileCount: materialFiles.length }));
