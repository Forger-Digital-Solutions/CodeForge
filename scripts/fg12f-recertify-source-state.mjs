import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const docPath = path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
const doc = JSON.parse(fs.readFileSync(docPath, "utf8"));

const FG12F_FILES = [
  "packages/forge-green/src/reuse-cost-policy.ts",
  "packages/workflow/src/verification-reuse-cost-gate.ts",
  "packages/workflow/src/verification-service.ts",
  "packages/workflow/src/types.ts",
  "packages/workflow/src/index.ts",
  "packages/server/src/workflow-service.ts",
  "packages/server/src/autonomous-orchestrator.ts",
  "packages/sessions/src/session-state.ts",
  "packages/sessions/src/persistence.ts",
  "packages/sessions/src/postgres-persistence.ts",
];

const materialFiles = [...new Set([...doc.materialFiles, ...FG12F_FILES])].sort((a, b) => a.localeCompare(b));
const entries = materialFiles.map((file) => ({ path: file, blobHash: execFileSync("git", ["hash-object", file], { cwd: repoRoot, encoding: "utf8" }).trim() }));
const sourceStateId = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");

const hashes = Object.fromEntries(entries.map((e) => [e.path, e.blobHash]));
const priorId = doc.sourceStateId;

doc.sourceStateId = sourceStateId;
doc.surfaceVersion = "fg12f-certified-v1";
doc.materialFiles = materialFiles;
doc.materialFileHashes = hashes;

doc.candidateD = {
  kind: "VERIFICATION_EVIDENCE_REUSE",
  status: "ACTIVE_SAFE_COST_GATED",
  executionSemantics: "Registry mode ACTIVE_SAFE narrowed by the fg12f-verification-reuse-cost-gated-1 cost policy: reuse requires canonical ForgeVerify validity AND a measured historical duration >= 250 ms (inclusive); unknown cost and below-threshold cost always run fresh; the CODEFORGE_FORGEGREEN_OPTIMIZATION ceiling (OFF/SHADOW) remains fully effective.",
  costPolicy: {
    policyVersion: "fg12f-verification-reuse-cost-gated-1",
    module: "packages/forge-green/src/reuse-cost-policy.ts",
    thresholdMs: 250,
    thresholdSemantics: "estimatedFreshMs >= costThresholdMs is eligible (inclusive)",
    unknownCostBehavior: "FRESH_VERIFY",
    historySource: "verification_evidence_elapsed_ms (prior PASSED evidence for the same verifierId+verifierVersion+definitionDigest, most-recent-5 median)",
    estimatedReuseOverheadMs: 184,
    overheadProvenance: "FG-12E p75 measured reuse overhead; used only for reported net-benefit estimates, never for the gate"
  },
  rolloutSeam: "packages/workflow/src/verification-service.ts: runVerification builds the authoritative plan, then consults the observer-provided durable prior evidence through adviseCostGatedReuse; executeVerificationPlan revalidates at the authoritative boundary. All five production callers reach it through their existing persistence-backed ForgeVerifyObserver.",
  canonicalEvidence: [
    "evidenceId",
    "workspaceContentHash",
    "policyRevision",
    "dependencyStateHash",
    "forgeVerifyConfirmedValid"
  ],
  validityAuthority: {
    source: "packages/workflow/src/forge-verify.ts: isEvidenceCurrentlyValid(evidence, current)",
    note: "summarizeVerification, the FG-12F advisor, and any external observer all call this single exported function; neither maintains an independent copy of the validity rule."
  },
  controlledTrial: {
    source: "packages/workflow/src/verification-evidence-reuse.ts",
    mode: "ReuseTrialMode: 'SHADOW' | 'CONTROLLED_ACTIVE_TRIAL' — a local type, NOT a member of OptimizationPolicyMode",
    note: "FG-12D trial harness, preserved unchanged for reproducibility; its explicit existingEvidence hand-off always wins over the FG-12F advisor path."
  }
};

doc.recertifications.push({
  label: "FG-12F",
  reason: "FG-12F cost-gated production rollout of Candidate D: graduated VERIFICATION_EVIDENCE_REUSE to a cost-gated ACTIVE_SAFE execution policy and wired the advisor into the shared runVerification seam. ForgeVerify validity authority unchanged; the cost gate is advisory and fails closed (unknown cost -> fresh).",
  priorSourceStateId: priorId,
  priorSurfaceVersion: "fg12d-certified-v1",
  resultingSourceStateId: sourceStateId,
  resultingSurfaceVersion: "fg12f-certified-v1",
  changes: [
    { file: "packages/forge-green/src/reuse-cost-policy.ts", change: "New file. Versioned FG-12F cost policy (threshold 250 ms inclusive, unknown-cost -> FRESH_VERIFY, identity requirements, most-recent-5 median), estimateVerifierReuseBenefit, isVerifierReuseCostEligible.", addedToMaterialFiles: true },
    { file: "packages/forge-green/src/optimization-policy.ts", change: "GRADUATION_REGISTRY.VERIFICATION_EVIDENCE_REUSE: SHADOW -> ACTIVE_SAFE (cost-gated execution policy per the FG-12F module); ceiling machinery unchanged.", addedToMaterialFiles: false },
    { file: "packages/forge-green/src/optimization-candidates-shadow.ts", change: "detectReusableVerificationEvidence accepts an optional costGate outcome and derives an honest APPLIED/REJECTED status under ACTIVE_SAFE only; without it FG-11 semantics are preserved.", addedToMaterialFiles: false },
    { file: "packages/workflow/src/verification-reuse-cost-gate.ts", change: "New file. adviseCostGatedReuse (narrow -> canonical validity -> cost eligibility, never throws) and reconcileCostGateReceipt (actual reuse truth = reusedEvidenceId).", addedToMaterialFiles: true },
    { file: "packages/workflow/src/verification-service.ts", change: "runVerification engages the cost-gated advisor between plan construction and executeVerificationPlan when the observer provides durable prior evidence and no explicit existingEvidence was supplied; reconciled receipt attached to the report and emitted via the observer.", addedToMaterialFiles: true },
    { file: "packages/workflow/src/forge-verify.ts", change: "ForgeVerifyObserver gained optional loadPriorEvidence and costGateReceiptCreated; no existing observer is broken (both optional).", addedToMaterialFiles: false },
    { file: "packages/workflow/src/types.ts", change: "VerificationReport gained optional costGateReceipt.", addedToMaterialFiles: true },
    { file: "packages/server/src/forge-verify-persistence.ts", change: "createForgeVerifyPersistenceObserver now also implements loadPriorEvidence (loadForgeVerifyEvidence) and persists cost_gate_receipt records.", addedToMaterialFiles: true },
    { file: "packages/server/src/workflow-service.ts", change: "Inline verification observer implements loadPriorEvidence + cost-gate receipt persistence.", addedToMaterialFiles: true },
    { file: "packages/server/src/autonomous-orchestrator.ts", change: "Verification gate now passes the persistence-backed observer (same pattern as the other production callers), enabling evidence durability + cost-gated reuse for that flow.", addedToMaterialFiles: true },
    { file: "packages/sessions/src/session-state.ts", change: "Verification work-item recordType enum gained 'cost_gate_receipt'.", addedToMaterialFiles: true },
    { file: "packages/sessions/src/persistence.ts", change: "Append-only guard accepts 'cost_gate_receipt'.", addedToMaterialFiles: true },
    { file: "packages/sessions/src/postgres-persistence.ts", change: "Append-only guard accepts 'cost_gate_receipt'.", addedToMaterialFiles: true }
  ],
  regressionEvidence: "PENDING_FULL_VALIDATION",
  recertifiedAt: "2026-09-11",
  sourceStateConstant: "FG12F_ROLLOUT_SOURCE_STATE"
});

doc.generationNote = "This source-state ID is deterministically derived from the material FG-8 through FG-12F implementation surface present on the recovered lineage, including the FG-11, FG-12D, and FG-12F recertifications above. Computed by packages/forgegreen-campaign/src/source-state.ts using idAlgorithm.";

fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + "\n");
console.log("FG-12F source-state recertified:", sourceStateId);
console.log("Material files:", materialFiles.length);
