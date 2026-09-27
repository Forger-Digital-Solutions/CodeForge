#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "9012e79edc1ae0dfd626a0eb44ab9c2ba352b739f50fa3758efd5b2e4097a709";
const priorVersion = "r48-role-aware-runtime-v1";
const changes = [
  { file: "packages/agent/src/index.ts", change: "R49: AgentResult carries the exact AgentModelSelection that served the run's final implementation attempt, so orchestrators can feed role-scoped verification evidence back to 8-Bit. No completion-policy change." },
  { file: "packages/server/src/agent-runtime.ts", change: "R49: recordRoleOutcome is the canonical free-fleet seam turning ForgeVerify outcomes into role-scoped 8-Bit evidence (paid routes ignored, qualification receipts never rewritten, eligibility never created); failover re-decisions pass the served pool as preferIndependentFromPoolId; the run journal records the final served route after failover instead of mixing the first-admitted identity with the last pool. Completion gate unchanged." },
  { file: "packages/server/src/autonomous-orchestrator.ts", change: "R49: the implementer's exact route is captured and reported to recordRoleOutcome as verification_failed on ForgeVerify rejection and verified_complete only after both the completion gate and integration accept — passing verification alone is never completion evidence." },
  { file: "packages/server/src/model-execution-adapter.ts", change: "R49: whitelisted transport cause codes ride normalized error messages as [cause=X] so 8-Bit's classifier can derive TRANSIENT_NETWORK from real transport failures; cause messages (which can carry hostnames and paths) are never persisted." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R49 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R49 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R49 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R49 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r49-free-supply-closure-v1";
const reason = "Recertify the reviewed R49 changes: refresh-wide allowance probe budget is real and shared with quota bootstrap probes; provider split request/token reset windows are tracked independently; transport cause codes preserved for transient classification; failover prefers independent managed capacity pools; OpenRouter free supply admitted via authoritative /api/v1/key account quota through the adapter's probeAccountQuota; the reservation ledger treats an observed requests window as metering (absent token windows are unmetered, zero-window routes still deny); ForgeVerify outcomes demote the exact free-role route; run journals attribute the final served route after failover. ForgeZero free-route eligibility, paid/free isolation, and completion-gate authority are unchanged.";
const entry = {
  label: "R49 free-supply closure and live mission certification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r49-free-supply/R49-FINAL-REPORT.md; four live 8-Bit missions on managed zero-cost routes: 3 completed end-to-end (gate completed, integration integrated, verified tree == integrated tree, $0 paid spend) incl. cross-account independent reviewer and real transient-capacity failovers; 1 blocked honestly on a reviewer workspace-escape tool call; forge-zero 151/151, model-registry+providers 354/354, eight-bit 309+2sk, server suite 869 pass with all 21 load-timeout failures re-isolated green standalone except 2 pre-existing baseline failures (agent-certification-r, fg3-model-aware-budget, failing at d4769e8); no-false-waiting 8/8; multiuser simulation 2136/2136 with pool-federation 0.333→1.000",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R49_FREE_SUPPLY_CLOSURE_SOURCE_STATE",
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
