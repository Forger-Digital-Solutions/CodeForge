#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "029807c8b24637554f788eceaf45db13edfc7e9052b0731f75eb2ae63560f30e";
const priorVersion = "r49-free-supply-closure-v1";
const changes = [
  { file: "packages/server/src/agent-runtime.ts", change: "R50: recordRoleOutcome accepts the full graded outcome vocabulary (verified_complete/converged/verification_failed/role_failed/security_blocked/budget_exhausted) with model-quality failureClass; producers wired for empty/cap-starved replies, malformed structured output, repetition loops, non-convergence, boundary blocks, budget exhaustion, and convergence; local tool rejections (unknown/malformed/escape/permission) emit boundary_violation reliability evidence; runtime role-quality delta merges with receipt advice into one ±24 admission-subordinate adjustment; failover grants a bounded +2 productive turns (FAILOVER_TURN_GRANT_CAP); a run that already recorded a dominant failure never stacks a second terminal verdict. Completion gate unchanged." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R50 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R50 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R50 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R50 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r50-runtime-quality-closure-v1";
const reason = "Recertify the reviewed R50 changes: runtime production outcomes now feed bounded, role-specific routing intelligence — graded role_outcome evidence (weighted, per-correlation deduplicated, decayed, ±16-bounded inside the authority) merges with qualification-receipt advice into one ±24 adjustment that only reorders candidates after eligibility, policy, health, safety, and capacity gates; capacity/transport failures stay in call_failure evidence and never enter the quality lane; boundary violations weigh double toward tool quarantine and emit security_blocked role evidence; failover grants ≤2 bounded productive turns; one run records one dominant verdict. ForgeZero free-route eligibility, paid/free isolation, qualification floors, reviewer independence, and completion-gate authority are unchanged.";
const entry = {
  label: "R50 runtime quality authority and adaptive role routing",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r50-runtime-quality/R50-FINAL-REPORT.md; live 8-Bit mission on managed zero-cost routes completed end-to-end (gate completed, integration integrated, verified tree == integrated tree, cross-provider-account reviewer independence, $0 paid spend) with a live before/after decide() winner flip on replayed production evidence; 27 new R50 tests (role-quality 15, replay 6, failover 3, tool-safety 3); eight-bit 330 pass / 2 skip; server 893 pass with one R50 regression found and fixed (dominant-verdict dedup) and 2 pre-existing baseline failures unchanged since d4769e8 (agent-certification-r, fg3-model-aware-budget); 16-Bit boundary family 233/233; long-horizon simulation 120/120 admissions across 3 evidence phases with transientSupplyNeverScores=true; full monorepo build clean",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R50_RUNTIME_QUALITY_SOURCE_STATE",
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
console.log("changed:", JSON.stringify(changed));
