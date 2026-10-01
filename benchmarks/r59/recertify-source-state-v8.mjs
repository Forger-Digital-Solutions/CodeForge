#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const documentPath = path.join(root, "docs/codeforge-forgegreen-certified-source-state.json");
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
const priorId = "f570564c7ca18b9dc3eae96c7eafb9e3d4e3724c7f39b7ed4db0e96e1207d13c";
if (document.sourceStateId !== priorId || document.surfaceVersion !== "r59-free-supply-recovery-v7" || document.materialFiles.length !== 80) {
  throw new Error("R59 v8 recertification refused: unexpected r59-v7 predecessor");
}
// R59 v8: the queued-verdict reset-horizon fix touches the reservation ledger — the fair
// admission authority. Its source and the chaos suite that pins it join the material set.
const added = [
  "packages/forge-zero/src/capacity-reservations.ts",
  "packages/forge-zero/test/capacity-transition-chaos.test.ts",
];
const files = [...new Set([...document.materialFiles, ...added])].sort((a, b) => a.localeCompare(b));
const entries = files.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }));
const changed = entries.filter((entry) => document.materialFileHashes?.[entry.path] !== entry.blobHash).map((entry) => entry.path);
const expected = [...added, "packages/server/src/agent-runtime.ts"].sort((a, b) => a.localeCompare(b));
if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`R59 v8 recertification refused: unreviewed drift ${JSON.stringify(changed)}`);
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw new Error(`R59 v8 recertification refused: uncommitted material source ${dirty}`);
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash]))).digest("hex");
const version = "r59-free-supply-recovery-v8";
const reason = "R59 v8 closes the two admission-evidence defects the v7 packaged run exposed: groq::openai/gpt-oss-120b reached QUALIFIED/HEALTHY/executable yet the coder's admission denied QUEUED with USER_QUOTA_EXHAUSTED and no recovery horizon. (1) CapacityReservationLedger.nextReset consulted pools.get()?.windows ?? route.windows — an empty-window per-user pool row (a connection with no stamped userConnectedFree declares no pool quota dimensions) is not nullish, so the route's real window resets were swallowed and every queued verdict surfaced nextAvailableAt=undefined; the deny path already falls back to route windows, and the reset lookup now mirrors that non-empty-pool-wins rule so honest capacity waits report when supply returns. (2) summarizeDenialCandidates sliced the fabric report's first 32 rows — all policy-excluded catalog noise — while the ranked rows that actually decided the denial (CAPACITY_DENIED on the qualified route) are appended last and never reached the failure summary; non-excluded candidates now order first. No admission, quota, qualification, billing, or completion policy changed — the denial was truthful (the suite's own token spend exhausted the window); these fixes make the evidence say so instead of looking like zero capacity.";
const entry = {
  label: "R59 queued-reset horizon recertification",
  reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: document.surfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: version,
  changes: changed.map((file) => ({ file, addedToMaterialFiles: added.includes(file) })),
  regressionEvidence: "docs/evidence/r59-supply-recovery/R59-FINAL-REPORT.md",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R59_FREE_SUPPLY_RECOVERY_V8_SOURCE_STATE",
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
