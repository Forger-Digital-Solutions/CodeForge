#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "d863c424d5d4a750a83340837e34946e124f1ebfde968273530226dd1c43f6d3";
const priorVersion = "r44-multifile-intelligence-v1";
const changes = [
  { file: "packages/agent/src/index.ts", change: "R45: deterministic read-plan scaffold, per-turn explorer forensics, direct explorer-to-coder evidence handoff, and adaptive turn budgets on the orchestrated path. No completion-policy change." },
  { file: "packages/context/src/index.ts", change: "R45: exploration-brief and deterministic packet surface kept inside the untrusted-data boundary. Presentation only; no gate policy change." },
  { file: "packages/server/src/agent-runtime.ts", change: "R45/R46: adaptive explorer budgets wired to the orchestrated path, route-window/failover journal telemetry, and role_failed reported to 8-Bit only on model-turn exhaustion (provider availability never reaches this path). No completion-policy change." },
  { file: "packages/server/src/autonomous-orchestrator.ts", change: "R45/R46: capacity+coverage-aware topology selection and the R46 mission-admission gate — run records persist before a TEMPORARILY_PARKED/NO_FREE_CAPACITY verdict returns blocked; the completion gate remains the sole path to completed." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R46 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R46 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R46 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R46 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r46-free-supply-resilience-v1";
const reason = "Recertify the reviewed R45/R46 changes: deterministic repository intelligence and handoff economics (R45), plus free-supply resilience — mission-aware admission, staged/durable qualification, 429 classification, and production-fabric live proof including one completed normal-topology mission on free-only supply (R46). ForgeZero, provider routing policy, and completion-gate authority are unchanged.";
const entry = {
  label: "R46 free-supply resilience and live production-fabric proof",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r46-free-supply-resilience/R46-LIVE-CORPUS.json and the R46 suite runs (r46-capacity-confidence 10/10, role-qualification 12/12, health-classify 17/17, route-health-authority 27/27, fabric+ledger+contention 97/97, server wiring+topology+orchestrator 65/65)",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R46_FREE_SUPPLY_RESILIENCE_SOURCE_STATE",
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
fs.writeFileSync(documentPath, JSON.stringify(document, null, 2) + "\n");
console.log(`recertified -> ${version} (${sourceStateId.slice(0, 12)}…)`);
