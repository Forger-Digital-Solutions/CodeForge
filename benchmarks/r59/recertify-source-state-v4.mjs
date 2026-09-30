#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "f51a171639f95dbd061736bb6c1ee47e628b13fd60c5e93abf74eb702c70bdec";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v3" || document.materialFiles.length !== 76) {
  throw new Error("R59 v4 recertification refused: unexpected r59-v3 predecessor");
}
const added = [
  "packages/model-registry/src/provider-definitions.ts",
  "packages/model-registry/test/r59-supply-recovery.test.ts",
];
const files = [...document.materialFiles, ...added].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = ["packages/model-registry/src/free-cloud-service.ts", ...added].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v4 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v4 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v4";
const reason = "R59 v4 paces provider-bound probe and qualification requests to each provider's declared free-tier RPM (Groq 30, OpenRouter :free 20; conservative floor otherwise). The packaged dogfood showed the suite self-rate-limiting — ~25 requests in ~20s tripped its own 429 mid-measurement and burned the daily budget without landing a verdict. Pacing spaces requests per provider through a claim-cursor shared by qualification lanes and capacity probes; suite deadlines abort in-flight waits as transient evidence; test providers are exempt like the capacity governor. Request counts, verdicts, budgets, ForgeZero, ForgeVerify, and completion authority are unchanged.";
const entry = {
  label: "R59 provider probe pacing recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V4_SOURCE_STATE",
};
document.materialFiles = files;
document.sourceStateId = sourceStateId;
document.surfaceVersion = version;
document.materialFileHashes = Object.fromEntries(entries.map((item) => [item.path, item.blobHash]));
document.recertifications.push(entry);
document.recertifiedAt = new Date().toISOString();
document.recertification = { phase: entry.label, reason, changedFiles: changed, priorSourceStateId: priorId, guarded: true };
fs.writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ version, sourceStateId, materialFiles: files.length, changed }));
