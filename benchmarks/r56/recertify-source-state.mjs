#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R56 golden-backend-freeze recertification.
 *
 * Guarded like every prior round: refuses unless the active certification is exactly the
 * R55 backend-completion surface, the only material drift is the reviewed R56 change set,
 * and every material file is committed (blob hashes must name committed content — the
 * certified id must be reproducible from the tree, not from a dirty working copy).
 *
 * R56 expands the certified surface from 54 to 60 files: the scoped-failure health,
 * capacity-governor, and run-failure modules are authority code — a model-scoped provider
 * wall leaking provider-wide and a typed provider error flattened to PROVIDER_UNAVAILABLE
 * were real live-supply defects found and fixed under live conditions; the regression
 * tests for them travel in the repo but are not part of the certified material surface
 * (tests are evidence, not authority).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "5478003269dd076f7cfe92ac4e85f87097b63b4f7b24b7b316386d7fd871a727";
const priorVersion = "r55-backend-completion-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R56 recertification refused: predecessor identity changed.");
}

const addedMaterialFiles = [
  "packages/eight-bit/src/failover.ts",
  "packages/eight-bit/src/health.ts",
  "packages/eight-bit/src/types.ts",
  "packages/providers/src/capacity-governor.ts",
  "packages/providers/src/index.ts",
  "packages/server/src/run-failure.ts",
];

const files = [...document.materialFiles, ...addedMaterialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R56 recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  ...addedMaterialFiles,
  "packages/server/src/index.ts",
  "packages/server/src/model-execution-adapter.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R56 recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R56 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r56-golden-backend-freeze-v1";
const reason = "R56 proves the R55 backend as a product under real conditions: live managed-free roster runs over Groq and OpenRouter :free lanes (real inference, real rate limits, a three-hop cross-provider failover chain, and a gate-authorized end-to-end completion on openrouter/nvidia/nemotron-3-super-120b-a12b:free), live USER_API dispatch against an owner-scoped OpenAI-compatible endpoint with fail-closed qualification, a live managed-paid probe through the budget-gated 16-Bit ledger with ACTUAL reconciliation, packaged Windows startup/interrupt/recovery smoke plus a live coding task completed inside the shipping binary, and the ForgeVerify adversarial corpus holding FALSE_COMPLETION_COUNT=0. It also fixes two live-discovered defects: model-scoped provider failures (e.g. Groq per-model TPD) now mark only the affected route — preserving sibling failover — and typed provider error codes survive normalization (INVALID_TOOL_OUTPUT stays invalid_model_output, never flattened to provider_outage) — neither change weakens fail-closed semantics.";
const changes = [
  { file: "packages/eight-bit/src/health.ts", change: "Failure marking gains explicit model/provider scope. Model-scoped reasons (per-model quota walls, model retirement, request-shaped failures) mark only the affected route; account/provider-scoped reasons (auth, account quota, outage) keep provider-wide marking. Cooldown projection follows the marked scope.", addedToMaterialFiles: true },
  { file: "packages/eight-bit/src/types.ts", change: "Route-health records carry a scope field so persisted marks rehydrate with their intended blast radius.", addedToMaterialFiles: true },
  { file: "packages/eight-bit/src/failover.ts", change: "Failover passes the classified route/model scope into health recording so a sibling route is never condemned by another model's wall.", addedToMaterialFiles: true },
  { file: "packages/providers/src/capacity-governor.ts", change: "The capacity governor supports model-scoped cooldowns (modelId on acquire/rate-limit paths); provider-scoped cooldown semantics are unchanged for account-level failures.", addedToMaterialFiles: true },
  { file: "packages/providers/src/index.ts", change: "Governor/adapter surface carries the model-scope parameter used by the runtime.", addedToMaterialFiles: true },
  { file: "packages/server/src/model-execution-adapter.ts", change: "Dispatches pass route+model scope into rate-limit reporting so the governor and health authority classify scope identically; normalizeProviderError honors the adapter's typed error code (provider-wire vocabulary mapped to runtime codes, ERROR_CODES verbatim) instead of re-deriving from message text — live fix for INVALID_TOOL_OUTPUT being flattened to PROVIDER_UNAVAILABLE.", addedToMaterialFiles: false },
  { file: "packages/server/src/run-failure.ts", change: "Failure-attribution authority gains entries for the provider-wire codes that now survive normalization verbatim (INVALID_TOOL_OUTPUT -> invalid_model_output, PAYMENT_REQUIRED -> paid_plan_required) instead of falling into the generic policy fallback.", addedToMaterialFiles: true },
  { file: "packages/server/src/index.ts", change: "Re-exports the user-intelligence surface so evidence harnesses and hosts can reach the owner-scoped source registry without deep imports.", addedToMaterialFiles: false },
];
const entry = {
  label: "R56 golden backend freeze source recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes,
  regressionEvidence: "docs/evidence/r56-golden-backend-freeze/R56-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R56_GOLDEN_BACKEND_FREEZE_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, JSON.stringify(document, null, 2) + "\n");
console.log(`recertified -> ${version} (${sourceStateId.slice(0, 12)}…)`);
console.log("changed:", JSON.stringify(changed));
console.log("material files:", files.length);
