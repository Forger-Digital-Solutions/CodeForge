// CodeForge Managed-Free R2 recertification of the ForgeGreen certified source state.
//
// This phase changed two material files. packages/server/src/agent-runtime.ts gained R2
// durable execution journaling (agent_run_journal), transcript continuation on resume (continuing
// from the exact recorded conversation rather than silently re-assembling bootstrap context),
// trailing unobserved tool replay and observation reconstruction, exactly-once tool execution
// idempotency, and terminal journal state checkpoints. packages/sessions/src/session-state.ts
// added AgentRunJournalSchema and AgentRecoveryLeaseSchema to the WorkItemSchema discriminated union,
// establishing durable schema validity for agent run journals and cross-process recovery claims.
//
// Neither touches ForgeGreen optimization candidates, the verification-evidence-reuse advisor,
// the FG-12F cost gate, or ForgeVerify validity authority. Prior campaign evidence remains
// historically accurate for the source state it recorded.
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
const entries = materialFiles.map((file) => ({
  path: file,
  blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim(),
}));
const sourceStateId = createHash("sha256")
  .update(JSON.stringify(entries.map((e) => [e.path, e.blobHash])))
  .digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));

const changed = materialFiles.filter((file) => doc.materialFileHashes[file] !== hashes[file]);
if (changed.length === 0) {
  console.log("source state already matches; nothing to recertify");
  process.exit(0);
}

const expectedChangedFiles = [
  "packages/server/src/agent-runtime.ts",
  "packages/sessions/src/session-state.ts",
];
if (changed.some((file) => !expectedChangedFiles.includes(file))) {
  throw new Error(`Unexpected certified-source drift; refusing recertification: ${changed.join(", ")}`);
}

const priorId = doc.sourceStateId;
const priorSurfaceVersion = doc.surfaceVersion;
const resultingSurfaceVersion = priorSurfaceVersion;

const changeNotes = {
  "packages/server/src/agent-runtime.ts":
    "Gained R2 durable execution journaling (agent_run_journal), transcript continuation on resume (continuing from the exact recorded conversation rather than silently re-assembling bootstrap context), trailing unobserved tool replay and observation reconstruction, exactly-once tool execution idempotency, and terminal journal state checkpoints.",
  "packages/sessions/src/session-state.ts":
    "Added AgentRunJournalSchema and AgentRecoveryLeaseSchema to the WorkItemSchema discriminated union, establishing durable schema validity for agent run journals and cross-process recovery claims.",
};

doc.recertifications.push({
  label: "CodeForge Managed-Free R2 — durable worker journal and crash recovery",
  reason:
    "R2 adds durable agent-run journaling and crash recovery to AgentRuntime and SubagentManager. Interrupted workers recover continuation state honestly from durable journals and tool execution records without duplicate side effects. Bounded recovery claims prevent concurrent recovery by multiple callers. ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate and ForgeVerify validity authority are untouched; prior campaign evidence remains historically accurate for its recorded source state.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file], addedToMaterialFiles: false })),
  regressionEvidence:
    "Full Vitest suite, the new 18-case run-recovery test suite (real process boundaries, pre/post-provider crash, pre/post-tool crash, write idempotency, unobserved command replan, reviewer recovery, cancellation priority, worktree failure, duplicate lease prevention), role-routing, subagent, and ForgeVerify tests.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_MANAGED_FREE_R2_SOURCE_STATE",
});

for (const file of changed) doc.materialFileHashes[file] = hashes[file];
doc.sourceStateId = sourceStateId;

const note = doc.generationNote ?? "";
if (!note.includes("CodeForge Managed-Free R2 recertification")) {
  doc.generationNote = `${note.replace(/\.$/, "")}, and the CodeForge Managed-Free R2 recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified: ${changed.join(", ")}`);
console.log(`prior sourceStateId: ${priorId}`);
console.log(`new sourceStateId:   ${sourceStateId}`);
