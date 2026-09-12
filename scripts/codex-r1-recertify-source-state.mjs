// Codex full-system R1 recertification of the ForgeGreen certified source state.
//
// R1 changed three material files for reasons unrelated to ForgeGreen/ForgeVerify authority:
// router capability requirements, agent-runtime approval/budget/session hardening, and
// workflow-service agent budget + plan-approval description + internal-turn origin. The FG-12F
// campaign evidence stays historically accurate for the source state it recorded; this entry
// records the drift explicitly instead of rehashing history in place.
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

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-codex-r1-runtime-hardening";

const changeNotes = {
  "packages/router/src/index.ts":
    "ForgeRouter.rank() now treats requiredCapabilities that a model record can state (text, coding, toolCalling, vision, structuredOutput, longContext) as hard requirements instead of scoring bonuses; the agent loop drives tools natively, so a route without toolCalling can never win a tool-driven coding route. ForgeGreen candidates and ForgeVerify reuse authority do not consult this ranking.",
  "packages/server/src/agent-runtime.ts":
    "Approval session grants ('Allow for Session' is now remembered per session runtime for safe/moderate risk), approval prompts name the file/command, tool_call_completed arguments honored, startTurn preserves the existing session record, turns carry an origin/label, explicit pins of non-tool routes fail closed. Verification evidence handling, ForgeGreen ledger persistence and the duplicate-action supervisor are unchanged.",
  "packages/server/src/workflow-service.ts":
    "Agent working budget per implementation/repair turn raised from 120 s to a configurable 20 min with cancellation of the turn on exhaustion (previously an orphaned agent kept running after the workflow failed); plan approval prompts list the plan's steps; internal builder/repair turns are marked origin=workflow. runVerification dispatch, the ForgeVerify observer wiring and the Candidate D cost gate are untouched.",
};

doc.recertifications.push({
  label: "Codex full-system R1 runtime hardening",
  reason:
    "Codex full-system R1 changed three material files while hardening routing, approvals, budgets and the task UI after the first live packaged autonomous tasks. None of the changes touch ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate, or ForgeVerify validity authority; the FG-12F campaign evidence remains historically accurate for the source state it recorded. This entry records the drift explicitly rather than rehashing that record.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file] ?? "Changed in Codex full-system R1.", addedToMaterialFiles: false })),
  regressionEvidence:
    "Repository regression suite from the R1 runtime candidate plus the packaged smoke (full/interrupt/recover) and the live packaged autonomous task; exact results are recorded in docs/codeforge-codex-full-system-certification-r1.*.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_CODEX_FULL_SYSTEM_R1_SOURCE_STATE",
});

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the Codex full-system R1 runtime-hardening recertification above.`;
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorId}\nnew  =${sourceStateId}`);
