#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "f24481030f350a69de885b9b73f8394adb50b4c23bfc47067a3754c5be2fce19";
const priorVersion = "r52-production-scale-v1";
if (document.sourceStateId !== priorId || document.surfaceVersion !== priorVersion) {
  throw new Error("R53 recertification refused: predecessor identity changed.");
}
const files = [...document.materialFiles].sort((a, b) => a.localeCompare(b));
if (new Set(files).size !== files.length) throw new Error("R53 recertification refused: duplicate material file.");
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/agent/src/index.ts"];
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error(`R53 recertification refused: unreviewed material drift ${JSON.stringify(changed)}.`);
}
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R53 recertification refused: uncommitted material source ${dirty}`);

const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r53-role-intelligence-v1";
const reason = "Reviewer instruction now asks for a verdict once the supplied diff resolves the concrete task, avoiding unnecessary read-only exploration while retaining blocking findings and the existing structured review contract. Three distinct current role failures reopen a fresh qualification through the governed free-only queue. Role probes stop at the first upstream transient and retain the prior receipt. ForgeVerify and paid routing are unchanged.";
const changes = [
  { file: "packages/agent/src/index.ts", change: "Reviewer convergence instruction for sufficient evidence; structured verdict and blocker requirements unchanged.", addedToMaterialFiles: false },
  { file: "packages/model-registry/src/free-cloud-service.ts", change: "Current, distinct role failures trigger bounded urgent requalification; provider capacity and policy exclusions remain separate.", addedToMaterialFiles: false },
  { file: "packages/eight-bit/src/qualification/role-suite.ts", change: "Upstream transient interrupts later role probes, leaves unattempted roles untested, and makes the receipt retryable without a false quality verdict.", addedToMaterialFiles: false },
];
const entry = {
  label: "R53 role-intelligence source recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes,
  regressionEvidence: "docs/evidence/r53-role-intelligence/R53-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R53_ROLE_INTELLIGENCE_SOURCE_STATE",
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
