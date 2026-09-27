#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "cd2dbd78320bcce5ede07f9f56f5f79c24d77afcacc2eebf71b57f5aa8ad0fd3";
const priorVersion = "r50-runtime-quality-closure-v1";
const changes = [
  { file: "packages/server/src/agent-runtime.ts", change: "R51: demand-driven measurement of CAPACITY_UNMEASURED free supply — measureUnmeasuredFreeCapacity probes denied candidates through FreeCloudService.probeRouteCapacity (metadata quota endpoint preferred, else one bounded maxTokens:1 ping whose headers land via onResponse even on 429, 60s per-domain cooldown); wired at initial executeTurn admission (probe hold released before exact-pin resolve under the same requestId), probeCapacityWait sweeper/workflow re-evaluation, runAgentTurn admission, and both handleTurnFailure failover sites via FailoverRequest.measureCapacity with a once-guard; no measurement hook leaves an honest denial, never a fabricated capacity wait. Completion gate, paid/free isolation, and qualification floors unchanged." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R51 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R51 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R51 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R51 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r51-capacity-closure-v1";
const reason = "Recertify the reviewed R51 changes: unmeasured quota domains are now denied as CAPACITY_UNMEASURED (unverifiable, never exhausted, never parked) instead of a self-sealing permanent capacity wait; demand-driven measurement via probeRouteCapacity runs at every non-admitted decision point — initial admission, capacity-wait re-evaluation, and mid-turn failover — bounded once per path under the same reservation identity; measured exhaustion still queues with real provider resets; ForgeZero free-route eligibility, paid/free isolation, qualification floors, reviewer independence, and completion-gate authority are unchanged.";
const entry = {
  label: "R51 free-capacity closure: unmeasured supply is measured, not parked",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r51-capacity-closure/R51-FINAL-REPORT.md; three live $0 missions completed through the production stack (unmeasured 112-domain fleet recovered via demand probes; healthy run on independent pools; reviewer-scarcity failover onto the surviving route) — all ForgeAuto-eligible, verified tree == integrated tree; seeded long-horizon simulation 241 decides / 0 invariant violations; forge-zero 152, model-registry 138 (6 new probe tests), eight-bit 332/2sk, server 896/3sk with the same 2 documented baseline failures (agent-certification-r, fg3-model-aware-budget, failing since d4769e8); full monorepo build clean; Cloudflare Workers AI analytics scope re-checked — still unauthorized, neuron guard correctly stays fail-closed",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R51_CAPACITY_CLOSURE_SOURCE_STATE",
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
