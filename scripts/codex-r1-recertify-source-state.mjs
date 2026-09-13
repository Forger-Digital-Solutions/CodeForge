// CodeForge Free Cloud R3 recertification of the ForgeGreen certified source state.
//
// The Free Cloud R2 lineage carries four reviewed material changes that post-date the existing
// certified fingerprint. They improve provider routing and terminal-state recovery; neither
// changes ForgeGreen policy, the verification-evidence-reuse advisor, or ForgeVerify validity.
// The prior FG-12F evidence remains historical evidence for its recorded source state.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));

const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = [
  "packages/router/package.json",
  "packages/server/src/agent-runtime.ts",
  "packages/server/src/workflow-service.ts",
  "packages/sessions/src/session-state.ts",
];
if (changed.length !== expectedChangedFiles.length || changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-free-cloud-r3";

const changeNotes = {
  "packages/router/src/index.ts":
    "ForgeRouter.rank() now treats requiredCapabilities that a model record can state (text, coding, toolCalling, vision, structuredOutput, longContext) as hard requirements instead of scoring bonuses; the agent loop drives tools natively, so a route without toolCalling can never win a tool-driven coding route. ForgeGreen candidates and ForgeVerify reuse authority do not consult this ranking.",
  "packages/server/src/agent-runtime.ts":
    "ForgeAuto now accepts only registry-admitted, qualified free routes; a canonical model selection can fail over to an admitted same-model alternate route before a different model, and route health is shared with the registry. ForgeGreen ledger persistence, verification-evidence reuse and ForgeVerify validity are unchanged.",
  "packages/server/src/workflow-service.ts":
    "Terminal sessions now settle non-terminal owned turns and unresolved approval records without replaying work; phase-status persistence is serialized so a late non-terminal write cannot revive a finished task. ForgeVerify dispatch, observer wiring and the Candidate D cost gate are untouched.",
  "packages/sessions/src/session-state.ts":
    "Approval work items gained terminal cancellation metadata so recovery can mark an interrupted task ended without falsely attributing a user denial. ForgeGreen policy and ForgeVerify validity are unchanged.",
  "packages/router/package.json":
    "The unused model-registry dependency was removed from the router workspace manifest as part of the Free Cloud provider-route integration. Router eligibility remains governed by ForgeZero.",
};

doc.recertifications.push({
  label: "Free Cloud R3 provider and terminal-state reconciliation",
  reason:
    "The Free Cloud R2 lineage changed four material files for provider-route integration and terminal-state recovery. None change ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate, or ForgeVerify validity authority; prior campaign evidence remains historically accurate for its recorded source state. This entry records the reviewed drift rather than rewriting historical evidence.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file] ?? "Changed in Codex full-system R1.", addedToMaterialFiles: false })),
  regressionEvidence:
    "Focused ForgeGreen source-state/provenance, desktop runtime ownership/control-plane/preload/package-security tests, and the packaged browser-security audit were rerun during the R3 reconciliation. The full suite remains a separate R3 certification gate.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_FREE_CLOUD_PLATFORM_R3_SOURCE_STATE",
});

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the Free Cloud R3 provider and terminal-state reconciliation above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorId}\nnew  =${sourceStateId}`);
