// CodeForge Free Cloud R5 recertification of the ForgeGreen certified source state.
//
// R5 changed two material files: packages/server/src/agent-runtime.ts, so that a turn with no
// admitted, healthy route fails closed instead of falling through to "completed" (observed in the
// packaged product after a provider-wide capacity cooldown), and
// packages/server/src/autonomous-orchestrator.ts, whose git helper gained windowsHide so the
// packaged GUI process no longer flashes a console window per git call (reported by the user).
// Neither touches ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the
// FG-12F cost gate or ForgeVerify validity authority. Prior campaign evidence remains historically
// accurate for the source state it recorded. Runs incrementally: each invocation recertifies the
// subset of these files that currently differs from the document.
//
// Guarded: any other material drift aborts without writing. Hashes are computed, never hand-edited.
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

const expectedChangedFiles = ["packages/server/src/agent-runtime.ts", "packages/server/src/autonomous-orchestrator.ts"];
if (changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = "fg12f-certified-v1-free-cloud-r5";

const changeNotes = {
  "packages/server/src/autonomous-orchestrator.ts":
    "The orchestrator's git helper passes windowsHide so the packaged GUI process does not allocate a visible console window for each git invocation. No orchestration, verification, ForgeGreen or ForgeVerify logic changed.",
  "packages/server/src/agent-runtime.ts":
    "executeTurn now fails the turn closed with an explicit 'No eligible free route' error when route resolution yields no admitted, healthy route, instead of running an empty loop and reporting 'Task completed successfully'. Route ranking, 8-Bit failover, approvals, verification-evidence handling, ForgeGreen ledger persistence and the duplicate-action supervisor are unchanged.",
};

doc.recertifications.push({
  label: changed.includes("packages/server/src/agent-runtime.ts") ? "Free Cloud R5 no-route turn fails closed" : "Free Cloud R5 hidden git console windows",
  reason: changed.includes("packages/server/src/agent-runtime.ts")
    ? "R5 observed in the packaged product that a builder turn with no eligible route (every route of the provider cooled down after one upstream 502) completed as a success without any model call; only the workflow completion gate caught it. The fix makes the runtime itself fail such a turn. It does not touch ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate, or ForgeVerify validity authority; prior campaign evidence remains historically accurate for its recorded source state."
    : "The user observed the packaged desktop flashing console windows whenever the agent's tooling invoked git; the orchestrator's git helper now passes windowsHide like every other git call in the runtime. A child-process spawn option only: ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate and ForgeVerify validity authority are untouched.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "packages/server (incl. the new no-eligible-route-turn regression), packages/workflow, packages/forge-green and packages/forgegreen-campaign suites, followed by the full R5 regression run and the packaged smoke chain; exact results are recorded in docs/codeforge-free-cloud-platform-r5.*.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_FREE_CLOUD_PLATFORM_R5_SOURCE_STATE",
});

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = resultingSurfaceVersion;
doc.materialFileHashes = hashes;
if (!doc.generationNote.endsWith('Free Cloud R5 recertification(s) above.')) {
  doc.generationNote = `${doc.generationNote.replace(/\.$/, "")}, and the Free Cloud R5 recertification(s) above.`;
}
fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified ${changed.length} changed material file(s): ${changed.join(", ")}`);
console.log(`prior=${priorId}\nnew  =${sourceStateId}`);
