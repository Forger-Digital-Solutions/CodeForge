#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "92534354261ed024d151f4a4e1a151a25336bbcb1f58406551a178d16ff532d1";
const priorVersion = "r46-free-supply-resilience-v1";
const changes = [
  { file: "packages/agent/src/index.ts", change: "R47: explicit structured-output wire contracts (Explorer contract declared up front + repeated in repair prompts), bounded deterministic Explorer summary recovery, and content-free shape diagnostics. No completion-policy change." },
  { file: "packages/server/src/agent-runtime.ts", change: "R47: role-scoped structured-output outcome telemetry wired to 8-Bit reliability/route health; paidAuto handed to the model execution adapter. Completion gate unchanged." },
  { file: "packages/server/src/model-execution-adapter.ts", change: "R47: paid-auto canonical-model branch for exact selections (runtimeModel via the paid service, fail-closed when unregistered); ForgeZero eligibility still gates every non-paid exact route. No free-route semantics change." },
];

if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R47 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R47 recertification refused: duplicate material file.");
const entries = files.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim(),
}));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = changes.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R47 recertification refused: unreviewed source drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R47 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r47-16bit-first-light-v1";
const reason = "Recertify the reviewed R47 changes: shared-runtime closure (Explorer output contract, deterministic recovery, role-scoped outcome telemetry, account-identity fail-closed, observer wiring, data-policy contract tests) plus 16-Bit first light — budget-gated paid adapter, route-priced expected-cost ranking, credential-absent direct→fallback dispatch, and one live budget-capped mission completed under the completion gate. ForgeZero free-route eligibility, provider routing policy, and completion-gate authority are unchanged.";
const entry = {
  label: "R47 shared-runtime closure and 16-Bit first light",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changes.map((change) => ({ ...change, addedToMaterialFiles: false })),
  regressionEvidence: "docs/evidence/r47-16bit/R47-16BIT-CAMPAIGN.md + R47-CLOSURE-MATRIX.md; Phase A 635 focused tests; Phase B paid-auto 50/50, server pipeline 75/75, regression sweep 152/152",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R47_16BIT_FIRST_LIGHT_SOURCE_STATE",
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
