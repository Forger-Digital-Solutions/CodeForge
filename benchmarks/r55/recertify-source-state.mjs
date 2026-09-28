#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R55 backend-completion recertification.
 *
 * Guarded like every prior round: refuses unless the active certification is exactly the
 * R54 eight-bit-intelligence surface, the only material drift is the reviewed R55 change
 * set, and every material file is committed (blob hashes must name committed content —
 * the certified id must be reproducible from the tree, not from a dirty working copy).
 *
 * R55 expands the certified surface from 39 to 54 files: the new roster-authorization,
 * user-source, paid-family, and accounting modules are authority code — undetected drift
 * in them after certification must trip the canary exactly like the pre-existing surface.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "998609d11f148822ae0d7dbd811ded7a7b27017965d1450cc15c07548f919706";
const priorVersion = "r54-eight-bit-intelligence-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R55 recertification refused: predecessor identity changed.");
}

const addedMaterialFiles = [
  "packages/cloud-usage/package.json",
  "packages/cloud-usage/src/index.ts",
  "packages/cloud-usage/src/managed-paid.ts",
  "packages/cloud-usage/src/shillings.ts",
  "packages/model-registry/src/free-cloud-service.ts",
  "packages/paid-auto/src/expected-cost.ts",
  "packages/paid-auto/src/families.ts",
  "packages/paid-auto/src/index.ts",
  "packages/paid-auto/src/registry.ts",
  "packages/paid-auto/src/service.ts",
  "packages/server/package.json",
  "packages/server/src/forgeauto-roster.ts",
  "packages/server/src/index.ts",
  "packages/server/src/subagent-manager.ts",
  "packages/server/src/user-intelligence.ts",
];

const files = [...document.materialFiles, ...addedMaterialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R55 recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  ...addedMaterialFiles,
  "packages/agent/src/index.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/autonomous-orchestrator.ts",
  "packages/server/src/model-execution-adapter.ts",
  "packages/sessions/src/session-state.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R55 recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R55 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r55-backend-completion-v1";
const reason = "R55 completes the intelligence-source backend: ForgeAuto runs over owner-selected rosters (FREE/PAID/CUSTOM entitlements) with an optional read-only Lead; 16-Bit gains explicit paid-family lifecycle with AUTO_CURRENT/PINNED_VERSION semantics; managed-paid execution is reserve/settle accounted per owner; USER_API executes owner-scoped OpenAI-compatible endpoints with host-resolved credentials; Shilling and decision-receipt work items persist without secrets. The completion gate and ForgeGreen capacity authority are unchanged.";
const changes = [
  { file: "packages/server/src/forgeauto-roster.ts", change: "New module. Owner-scoped roster schema, entitlement/source validation, role resolution, PINNED_VERSION/AUTO_CURRENT/AUTO slots, Lead mode, bounded decision-audit payloads, durable ForgeAutoRosterStore.", addedToMaterialFiles: true },
  { file: "packages/server/src/user-intelligence.ts", change: "New module. USER_API source registry: derived provider identity, HTTPS-only endpoint policy, host-resolved credential references, qualification gates, owner-frozen adapters. USER_HOSTED/LOCAL remain non-executable schema values.", addedToMaterialFiles: true },
  { file: "packages/server/src/index.ts", change: "Composes the R55 authorities: owner-checked roster endpoint, credential resolver injection, managed-paid owner guard, family-catalog hydration before recovered turns route.", addedToMaterialFiles: true },
  { file: "packages/server/src/subagent-manager.ts", change: "Roster allowance persisted/restored on worker records; roleRouting forced when an allowance is present regardless of the R1 flag (non-R1 roster bypass closed).", addedToMaterialFiles: true },
  { file: "packages/server/src/agent-runtime.ts", change: "Roster route filtering on selection and failover, USER_API dispatch bound to owner/frozen identity, managed-paid reserve/settle/release around paid attempts, append-only decision receipts, per-attempt idempotent Shilling accounting.", addedToMaterialFiles: false },
  { file: "packages/server/src/autonomous-orchestrator.ts", change: "Optional read-only Lead child with bounded 4,000-char advice handoff; per-role roster allowance (incl. user routes) attached to every spawned worker.", addedToMaterialFiles: false },
  { file: "packages/server/src/model-execution-adapter.ts", change: "Route decision and failover events carry roster-aware evidence.", addedToMaterialFiles: false },
  { file: "packages/agent/src/index.ts", change: "Lead role definition with read-only budget; cannot write, command, review-approve, or declare completion.", addedToMaterialFiles: false },
  { file: "packages/sessions/src/session-state.ts", change: "Work-item kinds for forgeauto_roster, paid_family_catalog, user_intelligence_source, shilling_entry, managed_paid_* records, forgeauto_decision_receipt; worker records carry roster allowance.", addedToMaterialFiles: false },
  { file: "packages/cloud-usage/src/managed-paid.ts", change: "New module. Owner-scoped managed-paid allowance ledger: included allowance + hard maximum, atomic reservation, idempotent settle/release, OBSERVED/ESTIMATED confidence, over-reservation protection, MANAGED_PAID_ACCOUNTING_FAILED propagation.", addedToMaterialFiles: true },
  { file: "packages/cloud-usage/src/shillings.ts", change: "New module. Shilling ledger: raw usage units retained, conversion method/confidence, UNKNOWN never coerced to zero, per-role/task/source aggregation, verified-completion metrics gated on ForgeVerify evidence.", addedToMaterialFiles: true },
  { file: "packages/cloud-usage/src/index.ts", change: "Exports the managed-paid ledger and Shilling ledger surfaces.", addedToMaterialFiles: true },
  { file: "packages/cloud-usage/package.json", change: "Adds @codeforge/sessions dependency for durable ledger work items.", addedToMaterialFiles: true },
  { file: "packages/paid-auto/src/families.ts", change: "New module. Paid family catalog: explicit approved-successor identity, DISCOVERED/PROBATION/QUALIFIED/ACTIVE/ACTIVE_ECONOMY/SUPERSEDED/RETIRED lifecycle, promotion/demotion evidence gates, atomic all-or-nothing hydration.", addedToMaterialFiles: true },
  { file: "packages/paid-auto/src/service.ts", change: "Paid role routing consumes the family catalog for AUTO_CURRENT resolution and stays inside roster-allowed canonical IDs.", addedToMaterialFiles: true },
  { file: "packages/paid-auto/src/registry.ts", change: "Registry surfaces family/lifecycle metadata for catalog-backed routing.", addedToMaterialFiles: true },
  { file: "packages/paid-auto/src/expected-cost.ts", change: "Expected-cost evidence feeding conservative managed-paid reservations.", addedToMaterialFiles: true },
  { file: "packages/paid-auto/src/index.ts", change: "Exports the family catalog and approved-successor types.", addedToMaterialFiles: true },
  { file: "packages/model-registry/src/free-cloud-service.ts", change: "Managed-free admission feed exposed to roster resolution; ForgeZero eligibility unchanged.", addedToMaterialFiles: true },
  { file: "packages/server/package.json", change: "Adds @codeforge/cloud-usage dependency for the managed-paid and Shilling ledgers.", addedToMaterialFiles: true },
];
const entry = {
  label: "R55 backend completion source recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes,
  regressionEvidence: "docs/evidence/r55-backend-completion/R55-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R55_BACKEND_COMPLETION_SOURCE_STATE",
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
