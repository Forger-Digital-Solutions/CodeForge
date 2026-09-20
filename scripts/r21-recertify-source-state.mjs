// R21 ForgeGreen certified source-state recertification. The fg11/fg12e provenance canaries
// freeze the material ForgeGreen/ForgeVerify surface; each R21 milestone that deliberately
// changes a material file re-issues the frozen set over the reviewed content with the exact
// change list — never by silencing the canary. Usage: node scripts/r21-recertify-source-state.mjs <m2|m3|...>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const PHASES = {
  m2: {
    surface: "r21-forgeverify-recertified-v1",
    label: "R21 ForgeVerify recertification source-state reconciliation",
    constant: "R21_FORGEVERIFY_RECERTIFIED_SOURCE_STATE",
    reason:
      "R21 hardened the completion authority after an adversarial audit found four gaps: (1) durable evidence reuse trusted a record's evidenceHash by presence only, so a tampered/corrupted 'passed' record could be reused under ACTIVE_SAFE; (2) the completion gate bound ForgeVerify evidence to the live workspace state only through the FG-5 policy path, and the mission/parallel authorities received legacy results with no state identity at all; (3) a required test verifier that exited 0 while its runner reported no tests (real `node --test` on an empty tree) or reported failures behind a wrapper that swallowed the exit code was counted as a pass; (4) staged-but-restored changes were invisible to the input-state hash. Every change is fail-closed and additive: integrity is now verified (hash recomputed) at the reuse boundary, in the canonical validity rule, and in advisor narrowing; the gate rebinds evidence to the state observed at decision time on every authority path; empty collections and contradictory output are classified (blocked/failed, never passed); the index is part of the evidence identity; terminal ForgeVerify rows are immutable at the storage layer (SQLite trigger + sessions PG migration 4). ForgeGreen's own detectors, cost policy, and graduation registry are untouched; Candidate D's advisor now receives strictly fewer (only integrity-verified) candidates, which is the intended direction. Two FG-12F tests that fabricated duration history by editing elapsedMs in place were updated to re-mint records through ForgeVerify's own hash, so they exercise the same behaviour without relying on the closed weakness.",
    changes: [
      { file: "packages/workflow/src/forge-verify.ts", change: "evidence integrity (computeVerificationEvidenceHash/verifyVerificationEvidenceIntegrity), integrity required by isEvidenceCurrentlyValid and the executeVerificationPlan reuse boundary, summary carries inputStateHash and integrity rejections, index (staged) included in the input-state hash, secrets-aligned redaction before hashing.", addedToMaterialFiles: false },
      { file: "packages/workflow/src/verification-service.ts", change: "no-tests-discovered and contradictory-output classification, test-signal recognition, npm preamble stripped before parsing, report carries inputStateHash; requiredPassed/overallStatus reflect the new classes.", addedToMaterialFiles: false },
      { file: "packages/workflow/src/verification-evidence-reuse.ts", change: "narrowToStrictEvidence requires integrity.", addedToMaterialFiles: false },
      { file: "packages/workflow/src/types.ts", change: "VerifierRunResult/VerificationResult identity + classification fields; ReviewFinding gains verification_config_modified.", addedToMaterialFiles: false },
      { file: "packages/server/src/workflow-service.ts", change: "recoverInterruptedForgeVerifyAttempts exported (returns recovered ids) so the R21 chaos harness runs production restart recovery in a fresh process; no behavioural change.", addedToMaterialFiles: false },
      { file: "packages/server/src/autonomous-orchestrator.ts", change: "completion gate receives currentVerificationInputStateHash computed at decision time.", addedToMaterialFiles: false },
      { file: "packages/sessions/src/persistence.ts", change: "SQLite BEFORE UPDATE trigger making terminal ForgeVerify rows immutable at the storage layer.", addedToMaterialFiles: false },
    ],
    regressionEvidence:
      "R21 ForgeVerify recertification: workflow/sessions/terminal/server/forge-green/forgegreen-campaign suites 171 files green after the two FG-12F fixture updates (the only other failures were these two provenance canaries); new R21 suites: integrity 7/7, malicious corpus 24/24 (25 recorded cases incl. real `node --test`), stale-evidence matrix 11/11, gate binding 11/11, autonomous binding 5/5, storage immutability 3/3 (SQLite + real PostgreSQL); chaos sweeps 22 cases each on SQLite and real PostgreSQL with 0 false completions; evidence under docs/evidence/r21-intelligence-closure/01-forgeverify.",
  },
  m3: {
    surface: "r21-forgegreen-ab-corrected-v1",
    label: "R21 ForgeGreen A/B accounting correction and agent budget honesty",
    constant: "R21_FORGEGREEN_AB_CORRECTED_SOURCE_STATE",
    reason:
      "The R21 controlled ForgeGreen A/B (docs/evidence/r21-intelligence-closure/02-forgegreen) measured model-visible bytes ON >= OFF on every task where only FG-1C duplicate suppression fired: the runtime replays the full prior output to the model, so Candidate A's receipt claim of bytesAvoided (and the Phase-4 statement that replayed bytes were 'not retransmitted') was false. buildDuplicateToolReuseDecision now reports bytesAvoided undefined and records REPLAYED_TO_MODEL_BYTES transparently; the two FG-9 tests encoding the old claim were corrected. The same harness exposed a P1 in the agent runtime: stopReason was initialised to 'completed', so an agent that exhausted its model-turn budget while still calling tools was reported completed with a canned summary; the autonomous orchestrator then read an exhausted reviewer's silence as approval. Fixed fail-closed (AGENT_MODEL_TURN_LIMIT / REVIEWER_BUDGET_EXHAUSTED); the efficiency receipt is rebuilt after the last turn. A benchmark-only efficiencyControls seam was added to the runtime so the A/B has a genuine OFF arm; it defaults ON and is never user-exposed. ForgeGreen detectors, cost policy, graduation registry and every ForgeVerify seam are unchanged.",
    changes: [
      { file: "packages/server/src/agent-runtime.ts", change: "budget-exhaustion honesty (completedExplicitly), receipt rebuilt post-loop, efficiencyControls benchmark seam gating FG-1C/FG-1B only when explicitly disabled.", addedToMaterialFiles: false },
      { file: "packages/server/src/autonomous-orchestrator.ts", change: "an exhausted reviewer (blocked, no verdict and no findings) fails closed with REVIEWER_BUDGET_EXHAUSTED instead of passing review by silence.", addedToMaterialFiles: false },
      { file: "packages/forge-green/src/optimization-candidate-a.ts", change: "Candidate A no longer claims bytesAvoided for replayed outputs; replayed size recorded as a reason code.", addedToMaterialFiles: false },
    ],
    regressionEvidence:
      "server/forge-green/forgegreen-campaign/agent suites green apart from the two provenance canaries; new suites r21-forgegreen-ab (15), r21-agent-budget-honesty (6), r21-orchestrator-reviewer-exhaustion (2), r21-task-complexity (28).",
  },
};

const phaseKey = process.argv[2];
const phase = PHASES[phaseKey];
if (!phase) throw new Error(`usage: node scripts/r21-recertify-source-state.mjs <${Object.keys(PHASES).join("|")}>`);
if (doc.recertifications.some((entry) => entry.sourceStateConstant === phase.constant)) throw new Error(`${phaseKey} already recertified`);

const materialFiles = [...doc.materialFiles].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");
const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
const priorId = doc.sourceStateId;
const priorSurface = doc.surfaceVersion;
const changedFiles = entries.filter((e) => doc.materialFileHashes[e.path] !== e.blobHash).map((e) => e.path);

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = phase.surface;
doc.materialFileHashes = hashes;
doc.recertifiedAt = "2026-09-20";
doc.recertifications.push({
  label: phase.label,
  reason: phase.reason,
  priorSourceStateId: priorId,
  priorSurfaceVersion: priorSurface,
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: phase.surface,
  changes: phase.changes,
  regressionEvidence: phase.regressionEvidence,
  recertifiedAt: "2026-09-20",
  sourceStateConstant: phase.constant,
});
doc.recertification = {
  phase: phase.label,
  reason: `Re-issue the frozen ForgeGreen source-state over the reviewed ${phaseKey.toUpperCase()} surface so the fg11/fg12e provenance canaries certify the current tree.`,
  changedFiles,
  priorSourceStateId: priorId,
  guarded: true,
};
doc.generationNote =
  "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface present on the recovered lineage, including the FG-11, FG-12D, and FG-12F recertifications, the R20 durable hosted-runtime reconciliation, and the R21 recertifications listed above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`${phaseKey} source-state recertified:`, sourceStateId);
console.log("Prior:", priorId, `(${priorSurface})`);
console.log("Changed files:", changedFiles);
