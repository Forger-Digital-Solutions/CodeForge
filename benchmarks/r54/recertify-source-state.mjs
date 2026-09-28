#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "d122e0cce57f80a5c81612a2fe120cc1223db585f5df9eb91dd6e751e6791593";
const priorVersion = "r53-role-intelligence-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R54 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R54 recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/server/src/agent-runtime.ts", "packages/server/src/autonomous-orchestrator.ts"];
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R54 recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R54 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r54-eight-bit-intelligence-v1";
const reason = "Observable role-progress receipts now stop repeatedly unproductive Coder execution, and the autonomous orchestrator can hand the same isolated worktree to one alternate free qualified Coder. A Reviewer without a valid verdict can be replaced once by an alternate free semantic verifier. Per-request provider usage is journaled with unknown values preserved. The completion gate and paid routing remain unchanged.";
const changes = [
  { file: "packages/server/src/agent-runtime.ts", change: "Role-progress stall detection, role-route replacement exclusion, and raw provider usage journaling.", addedToMaterialFiles: false },
  { file: "packages/server/src/autonomous-orchestrator.ts", change: "Bounded quality-driven Coder handoff and alternate semantic Reviewer routing with preserved worktree.", addedToMaterialFiles: false },
  { file: "packages/server/src/subagent-manager.ts", change: "Serial replacement children and route exclusion forwarding; outside certified 39-file surface.", addedToMaterialFiles: false },
  { file: "packages/server/src/role-progress.ts", change: "Pure observable role-progress classifier; outside certified 39-file surface.", addedToMaterialFiles: false },
];
const entry = {
  label: "R54 8-Bit intelligence source recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes,
  regressionEvidence: "docs/evidence/r54-eight-bit-intelligence/R54-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R54_EIGHT_BIT_INTELLIGENCE_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, JSON.stringify(document, null, 2) + "\n");
console.log(`recertified -> ${version} (${sourceStateId.slice(0, 12)}…)`);
console.log("changed:", JSON.stringify(changed));
