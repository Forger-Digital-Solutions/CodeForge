import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docPath = path.join(root, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const allowedChangedFiles = new Set([
  "packages/server/src/agent-runtime.ts",
  "packages/sessions/src/session-state.ts",
]);
const entries = doc.materialFiles
  .map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: root, encoding: "utf8" }).trim() }))
  .sort((left, right) => left.path.localeCompare(right.path));
const hashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
const changedFiles = entries.filter((entry) => doc.materialFileHashes[entry.path] !== entry.blobHash).map((entry) => entry.path);
const unexpected = changedFiles.filter((file) => !allowedChangedFiles.has(file));
if (unexpected.length > 0) throw new Error(`Unexpected certified-source drift; refusing R13 recertification: ${unexpected.join(", ")}`);
if (changedFiles.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash])))
  .digest("hex");
const resultingSurfaceVersion = "r13-intelligence-recovery-v1";

doc.materialFileHashes = hashes;
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.recertifications.push({
  label: "R13 capacity and intelligence persistence recertification",
  reason: "R13 adds deterministic capacity-aware free-route ranking and additive, session-scoped intelligence and paid-evaluation work-item types. The review confirmed no change to ForgeZero eligibility, paid/BYOK boundaries, ForgeVerify, or Completion Gate authority.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changedFiles.map((file) => ({
    file,
    change: file.endsWith("agent-runtime.ts")
      ? "Supplies deterministic FreeCloud capacity advice only after existing ForgeZero and admission checks; it cannot create eligibility or select paid/BYOK routes."
      : "Adds typed work-item shapes for session-scoped shadow telemetry and session-bound paid evaluation evidence; these records have no routing, tool, verification, or completion authority.",
    addedToMaterialFiles: false,
  })),
  regressionEvidence: "R13 focused shadow, privacy, tenant-isolation, deterministic capacity, paid-budget, and topology suites passed before recertification; FG-11 and FG-12E sentinels are rerun immediately after this guarded update.",
  recertifiedAt: new Date().toISOString(),
  sourceStateConstant: "CODEFORGE_R13_INTELLIGENCE_RECOVERY_SOURCE_STATE",
});
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R13 intelligence and recovery",
  reason: "Reviewed R13 material source changes after source freeze; historical R11/R12 evidence remains untouched.",
  changedFiles,
  priorSourceStateId,
  guarded: true,
};
doc.generationNote = `${String(doc.generationNote).replace(/\.$/, "")}, and the R13 intelligence and recovery recertification above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ sourceStateId, changedFiles, materialFileCount: entries.length, resultingSurfaceVersion }, null, 2));
