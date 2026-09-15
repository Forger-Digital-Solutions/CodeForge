// CodeForge SubAgents R1 Phase 2 recertification of the ForgeGreen certified source state.
//
// This phase changed two material files. packages/server/src/agent-runtime.ts gained R1
// role-aware route resolution for agent runs (8-Bit role-scoped selection, bounded free-fleet
// failover, legacy fallback preserved when no fleet route exists) and now records route success
// per served model. packages/server/src/autonomous-orchestrator.ts now fails the run closed when
// the independent reviewer fails or is cancelled instead of vacuously passing the review, and
// converges non-terminal durable worker records after a restart. Neither touches ForgeGreen
// optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate or
// ForgeVerify validity authority. Prior campaign evidence remains historically accurate for the
// source state it recorded. Runs incrementally: each invocation recertifies the subset of these
// files that currently differs from the document.
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
const resultingSurfaceVersion = priorSurfaceVersion;

const changeNotes = {
  "packages/server/src/agent-runtime.ts":
    "Agent runs (the path SubAgent workers execute) can now resolve their route through 8-Bit's role-scoped eligibility/ranking when the caller enables role routing, so explorer/planner/coder/reviewer workers are served by qualified, healthy free routes instead of one shared fallback model; provider failures rotate within the free fleet under the existing classification/cooldown machinery with the same routeFilter and same-model alternates as the lead turn, while an explicitly selected model is never substituted. When no fleet route exists (no eligible model with a registered adapter) the previous deterministic provider-catalog fallback is preserved. Route success/failure is recorded to 8-Bit health and the shared Free Cloud health view.",
  "packages/server/src/autonomous-orchestrator.ts":
    "A review phase whose independent reviewer failed or was cancelled now fails the run closed (REVIEWER_CANCELLED/REVIEWER_FAILED) instead of vacuously passing on empty findings, and restart recovery converges durable worker records left non-terminal by a crash into an honest failed state (replan-only recovery: no worker execution is resumed).",
};

doc.recertifications.push({
  label: "CodeForge SubAgents R1 Phase 2 — role-aware routing and fail-closed review",
  reason: "R1 Phase 2 wires role-aware Managed-Free routing into the SubAgent execution path (the Managed-Free fleet objective) and closes the observed fail-open where an independent reviewer that never delivered a verdict approved the change. Routing decisions remain inside the certified free boundary: 8-Bit eligibility contracts, cooldowns, and (when wired) Free Cloud admission gates apply to every selection and every failover replacement; explicit model selections are never substituted. ForgeGreen optimization candidates, the verification-evidence-reuse advisor, the FG-12F cost gate and ForgeVerify validity authority are untouched; prior campaign evidence remains historically accurate for its recorded source state.",
  priorSourceStateId: priorId,
  priorSurfaceVersion,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion,
  changes: changed.map((file) => ({ file, change: changeNotes[file], addedToMaterialFiles: false })),
  regressionEvidence: "Full Vitest suite (2,384+ passed), the R1-focused orchestrator/subagent suites, the new role-routing suite (fleet resolution, fail-closed no-route, bounded failover rotation, exact-model no-substitution, legacy fallback), the stale-worker reconciliation test, and live Groq/Cloudflare certification plus a live R1 end-to-end run with passing real verification recorded in docs/evidence/.",
  recertifiedAt: new Date().toISOString().slice(0, 10),
  sourceStateConstant: "CODEFORGE_SUBAGENTS_R1_PHASE2_SOURCE_STATE",
});

for (const file of changed) doc.materialFileHashes[file] = hashes[file];
doc.sourceStateId = sourceStateId;

const note = doc.generationNote ?? "";
if (!note.includes("CodeForge SubAgents R1 Phase 2 recertification")) {
  doc.generationNote = `${note.replace(/\.$/, "")}, and the CodeForge SubAgents R1 Phase 2 recertification above.`;
}

fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
console.log(`recertified: ${changed.join(", ")}`);
console.log(`prior sourceStateId: ${priorId}`);
console.log(`new sourceStateId:   ${sourceStateId}`);
