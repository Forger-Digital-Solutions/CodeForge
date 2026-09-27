#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "499bc26c2afd7784c12b9ae8e432b9add24f97ff233c4b660dfadb6f2b34ada5";
const priorVersion = "r47-16bit-first-light-v1";
const changes = [
  { file: "packages/agent/src/index.ts", change: "R48: AgentResult exposes routePoolId (physical capacity-pool provenance) and SpawnSubagentOptions accepts a reviewer independence hint so orchestrators can request a reviewer on a different pool than the implementer. No completion-policy change." },
  { file: "packages/server/src/agent-runtime.ts", change: "R48: paid-auto/auto sentinel resolves per-role through measured paid evidence (sentinel never dispatched; paid-only rotation inside the canonical roster; no free substitution); fabric QUEUED_FOR_CAPACITY gets one bounded wait + re-decision (stale reset re-decides immediately, distant reset fails closed, DENIED never waits); partial execution budgets merge over role defaults instead of NaN-ing the context gate; denial summaries carry fabric reason codes and next_available; servedPoolId tracked into the run journal. Completion gate unchanged." },
  { file: "packages/server/src/autonomous-orchestrator.ts", change: "R48: reviewer spawns inherit the implementer's served capacityPoolId as a soft independence preference so ForgeVerify review prefers a different physical pool where qualified supply exists." },
  { file: "packages/server/src/model-execution-adapter.ts", change: "R48: parallel tool-call fragments accumulate keyed by toolCallId/index instead of a single shared slot (explorer closure fix); provider-reported served-model identity surfaces on finish events; the stream error drain preserves retryable instead of flattening it away." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R48 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R48 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R48 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R48 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r48-role-aware-runtime-v1";
const reason = "Recertify the reviewed R48 changes: role-verdict qualification floor in 8-Bit routing and Free Fabric admission (QUALIFIED > PROBATION > NOT_TESTED, capability contracts per role); index-keyed parallel tool-call assembly; served-model identity through streams and receipts; measured reasoning-token headroom in qualification probes and dispatch; paid-auto/auto per-role selection over canonical measured models with paid-only failover and probation policy; ForgeVerify reviewer physical-pool independence; bounded no-false-waiting for queued capacity; partial execution budgets merged over role defaults. ForgeZero free-route eligibility, paid/free isolation, and completion-gate authority are unchanged.";
const entry = {
  label: "R48 role-aware fleet routing and no-false-waiting",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r48-role-routing/R48-LIVE-EVIDENCE.md; server suite 876 pass / 2 pre-existing baseline failures; touched packages 596 pass; paid role-routing 9/9, role-routing 18/18, fabric 36/36; live E3 paid mission completed end-to-end at $0.0087 of $0.25 cap with independent reviewer pool",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R48_ROLE_AWARE_RUNTIME_SOURCE_STATE",
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
