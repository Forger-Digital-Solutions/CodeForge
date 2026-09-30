#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "193a34dc933b27e917b728219c1f004fc86c87a27a0aadd7280dca50b5607830";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r58-progress-aware-autonomy-v1" || document.materialFiles.length !== 68) {
  throw new Error("R59 recertification refused: unexpected R58 predecessor");
}
// R59 moved the supply-admission surface (fabric, ledger, capacity types, discovery,
// catalog refresh, provider registry) under the certified material set because this
// release changes how verified-free routes survive transient probe failures and how
// denial-time recovery re-decides admission.
const added = [
  "packages/cloud-gateway/src/provider-registry.ts",
  "packages/eight-bit/src/free-fabric.ts",
  "packages/eight-bit/src/route-ledger.ts",
  "packages/forge-zero/src/capacity-types.ts",
  "packages/model-registry/src/catalog-refresh.ts",
  "packages/model-registry/src/discovery.ts",
].sort((a, b) => a.localeCompare(b));
if (added.some((file) => document.materialFiles.includes(file))) throw new Error("R59 material addition was already certified");
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [
  ...added,
  "apps/desktop/src/main.ts",
  "packages/model-registry/src/free-cloud-service.ts",
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/index.ts",
].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v1";
const reason = "R59 preserves verified-free routes across transient catalog/allowance probe failures, attests and re-probes account-dependent providers, joins concurrent provider discovery instead of dropping it, re-qualifies cooled routes on cooldown expiry within bounded budgets, exposes the per-route exclusion ledger at /api/free-cloud/supply, and recovers supply during runtime admission denial instead of reporting false zero capacity. ForgeZero, ForgeVerify, qualification gates, and completion authority are unchanged.";
const entry = {
  label: "R59 free supply recovery recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V1_SOURCE_STATE",
};
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFiles = files;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
