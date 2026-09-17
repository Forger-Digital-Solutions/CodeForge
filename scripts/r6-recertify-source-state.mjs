// CodeForge R6 product-hardening recertification of the current ForgeGreen source surface.
//
// Guarded and append-only: this script refuses any material drift outside the reviewed list,
// computes all hashes from disk, and preserves every historical recertification entry.
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
  "packages/server/src/autonomous-orchestrator.ts",
  "packages/server/src/workflow-service.ts",
  "packages/sessions/src/persistence.ts",
  "packages/sessions/src/session-state.ts",
  "packages/workflow/src/forge-verify.ts",
  "packages/workflow/src/verification-service.ts",
]);
const unexpected = changed.filter((file) => !expectedChangedFiles.has(file));
if (unexpected.length > 0) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${unexpected.join(", ")}`);
}

const notes = {
  "packages/server/src/agent-runtime.ts": "Removed dead imports, unused provider-finish bookkeeping, and an unused legacy approval-promise bridge. ApprovalService remains the authoritative durable approval path; routing, permissions, provider execution, and completion authority are unchanged.",
  "packages/server/src/autonomous-orchestrator.ts": "Added a mandatory evidence-backed Completion Gate decision after independent review and ForgeVerify and before integration. Actual Git diff paths are authoritative; absent verification and empty effective changes fail closed.",
  "packages/server/src/workflow-service.ts": "Awaits interrupted-verifier recovery and, during shutdown, waits for active workflow promises and drains pending workspace-event persistence before the database closes.",
  "packages/sessions/src/persistence.ts": "Removed unused serializers and named the intentionally unused SQLite lock parameter; persistence behavior and schemas are unchanged.",
  "packages/sessions/src/session-state.ts": "Removed unused schema imports; work-item validation behavior is unchanged.",
  "packages/workflow/src/forge-verify.ts": "Named an intentionally unused child-process error parameter; verification status and evidence semantics are unchanged.",
  "packages/workflow/src/verification-service.ts": "Removed unused type imports; verifier discovery, execution, and sufficiency behavior are unchanged.",
};

const priorSourceStateId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-r6-product-hardening";
doc.recertifications.push({
  label: "R6 product-hardening and completion-authority recertification",
  reason: "R6 closed false-completion and shutdown-persistence races while applying zero-warning cleanup across the certified material surface. ForgeVerify remains the evidence authority and every autonomous integration path now requires the shared Completion Gate semantics.",
  priorSourceStateId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: notes[file], addedToMaterialFiles: false })),
  regressionEvidence: "R6 focused Completion Gate, autonomous, parallel, mission, shutdown, persistence, security, recovery, and verification suites passed; the repository-wide suite and production build are recorded in the R6 product-hardening evidence namespace.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_R6_PRODUCT_HARDENING_SOURCE_STATE",
});
doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.recertifiedAt = new Date().toISOString();
doc.recertification = {
  phase: "R6 product hardening",
  reason: "Completion authority, shutdown durability, and zero-warning certified-surface reconciliation",
  changedFiles: changed.map((file) => ({ path: file, summary: notes[file] })),
  priorSourceStateId,
  guarded: true,
};
if (!doc.generationNote.includes("R6 product-hardening recertification")) {
  doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the R6 product-hardening recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorSourceStateId}\nnew  =${sourceStateId}`);
