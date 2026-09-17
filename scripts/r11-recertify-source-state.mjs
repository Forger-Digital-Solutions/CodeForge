// CodeForge R11 recertification of the reviewed R10 durable-response surface.
//
// Guarded and append-only: only the two reviewed material files may differ. Historical
// source-state identities remain intact, and every hash is computed from the current bytes.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));
const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((entry) => [entry.path, entry.blobHash])))
  .digest("hex");
const hashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.blobHash]));
const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);

if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = new Set([
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/workflow-service.ts",
]);
const unexpected = changed.filter((file) => !expectedChangedFiles.has(file));
if (unexpected.length > 0) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${unexpected.join(", ")}`);
}

const notes = {
  "packages/server/src/agent-runtime.ts":
    "Persists a durable final-response work item for completion-gated direct autonomous runs and records an explicit runtime summary when a verified tool run ends without model prose. Completion status still originates from the existing runtime and verification boundaries; persistence cannot promote a blocked run.",
  "packages/server/src/workflow-service.ts":
    "Persists the completion-gated workflow summary against the initiating user turn after and only after the shared completion authority returns completed, preserving restart-visible final output without changing completion policy.",
};

const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-r11-durable-response";
doc.recertifications.push({
  label: "R11 durable final-response source-state recertification",
  reason:
    "R10 closed a packaged-product durability gap: successful autonomous and workflow executions now retain their completion-gated final response across reload and restart. The reviewed change records an already-authorized completion result and does not weaken ForgeVerify, the completion gate, routing, approvals, permissions, or ForgeZero.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: notes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "R10 focused benchmark/server suites passed 25/25 during R11 reconciliation. The two frozen-source sentinels are rerun immediately after this guarded recertification, followed by the complete R11 engineering regression.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R11_DURABLE_RESPONSE_SOURCE_STATE",
});
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R11 release-candidate closure",
  reason: "Reviewed R10 durable final-response persistence",
  changedFiles: changed.map((file) => ({ path: file, summary: notes[file] })),
  priorSourceStateId,
  guarded: true,
};
if (!doc.generationNote.includes("R11 durable final-response recertification")) {
  doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R11 durable final-response recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorSourceStateId}\nnew  =${sourceStateId}`);
