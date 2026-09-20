// R21 ForgeVerify chaos gate (process C — the "restart"). A fresh process with no memory of the
// worker: it runs the production restart recovery, reloads the durable ForgeVerify records, and
// asks the completion authority whether the workspace may be called done. It also exercises the
// ForgeGreen ACTIVE_SAFE reuse path (`existingEvidence` from the durable store) so a restart can
// only reuse evidence that is genuinely valid for the live workspace.
// Usage: node scripts/r21-forgeverify-gate.mjs <backend> <dbTarget> <sessionId> <workspace> [--mutate]
import fs from "node:fs";
import path from "node:path";
import { createSessionPersistence, PostgresSessionPersistence } from "../packages/sessions/dist/index.js";
import { recoverInterruptedForgeVerifyAttempts, loadForgeVerifyEvidence, evaluateAutonomousCompletion } from "../packages/server/dist/index.js";
import {
  adaptTrustedLegacyVerifiers, createVerifierRegistry, createVerificationInputStateHash, summarizeVerification, verifyVerificationEvidenceIntegrity,
  evaluateCompletion, executeVerificationPlan, VerificationEvidenceStore,
} from "../packages/workflow/dist/index.js";

const [backend, dbTarget, sessionId, workspace, ...flags] = process.argv.slice(2);
const mutate = flags.includes("--mutate");
const persistence = backend === "pg" ? new PostgresSessionPersistence({ connectionString: dbTarget }) : createSessionPersistence({ dbPath: dbTarget });
if (backend === "pg") await persistence.init();

// 1. Production restart recovery: running attempts become `interrupted`.
const interrupted = await recoverInterruptedForgeVerifyAttempts(persistence, sessionId);

// 2. Reload what the dead worker left behind.
const items = await persistence.getWorkItems(sessionId);
const plans = items.filter((item) => item.kind === "verification" && item.recordType === "plan").map((item) => item.payload);
const attempts = items.filter((item) => item.kind === "verification" && item.recordType === "attempt");
const evidence = await loadForgeVerifyEvidence(persistence, sessionId);
const integrityFailures = evidence.filter((record) => !verifyVerificationEvidenceIntegrity(record)).length;

if (mutate) fs.writeFileSync(path.join(workspace, "src.js"), `module.exports = { value: ${Date.now()} };\n`);

// 3. Rebuild the authoritative plan/registry for this workspace exactly as production does and
//    summarize the durable evidence against the LIVE state.
const registry = createVerifierRegistry(adaptTrustedLegacyVerifiers(workspace, [{ id: "verifier-1-test", kind: "test", command: "node test.cjs", required: true, source: "configured" }]));
const plan = plans[0];
const currentHash = createVerificationInputStateHash(workspace);
let summary = null;
if (plan) summary = summarizeVerification(plan, registry, evidence.filter((record) => verifyVerificationEvidenceIntegrity(record)), currentHash);

// 4. The completion authority, two ways: (a) the structured gate over the reloaded summary;
//    (b) the autonomous authority over legacy results derived from durable evidence.
const structured = evaluateCompletion({
  plan: { id: "p", title: "chaos", taskId: sessionId, status: "completed", createdAt: "", updatedAt: "", steps: [
    { id: "edit", description: "edit", status: "completed", kind: "edit", risk: "safe", requiresApproval: false, targetPath: "src.js" },
    { id: "verify", description: "verify", status: summary?.verificationComplete ? "completed" : "failed", kind: "verify", risk: "safe", requiresApproval: false },
  ] },
  verification: plan ? { passed: summary?.satisfiedCount ?? 0, failed: 0, skipped: 0, durationMs: 0, output: "", exitCode: summary?.verificationComplete ? 0 : 1, command: "node test.cjs", failures: [], verifiers: [], requiredPassed: Boolean(summary?.verificationComplete), hasFailures: false, advisories: [], overallStatus: summary?.verificationComplete ? "passed" : "failed", summary: "", forgeVerify: { plan, attempts: [], evidence, summary } }
    : { passed: 0, failed: 0, skipped: 0, durationMs: 0, output: "no plan persisted", exitCode: 0, command: "", failures: [], notConfigured: true },
  ...(summary ? { verificationSummary: summary } : {}),
  analysis: { hasFailures: false, summary: "", diagnostics: [], suggestedRepairs: [], isRepairable: false },
  review: { approved: true, issues: [], findings: [], diffs: [{ path: "src.js", changeType: "modified", additions: 1, deletions: 0, diff: "+x", beforeHash: "a", afterHash: "b" }], summary: "1 file" },
  currentVerificationInputStateHash: currentHash,
});
const legacy = evaluateAutonomousCompletion({
  runId: sessionId, title: "chaos", changedFiles: ["src.js"], diff: "+x", reviewPassed: true, workspacePath: workspace,
  verification: evidence.map((record) => ({ passed: record.status === "passed" ? 1 : 0, failed: record.status === "passed" ? 0 : 1, skipped: 0, durationMs: record.elapsedMs ?? 0, output: record.outputExcerpt ?? "", exitCode: record.exitCode ?? 1, command: "node test.cjs", failures: [], inputStateHash: record.inputStateHash })),
});

// 5. The reuse path a restarted run would take: only genuinely valid durable evidence is reused.
let reuse = null;
if (plan) {
  const fresh = await executeVerificationPlan(registry, { ...plan, inputStateHash: currentHash, planId: `${plan.planId}-restart` }, new VerificationEvidenceStore(), { existingEvidence: evidence });
  reuse = { reusedEvidenceIds: fresh.evidence.filter((record) => evidence.some((prior) => prior.evidenceId === record.evidenceId)).map((record) => record.evidenceId), freshExecutions: fresh.evidence.filter((record) => !evidence.some((prior) => prior.evidenceId === record.evidenceId)).length, verificationComplete: fresh.summary.verificationComplete };
}

process.stdout.write(`R21_GATE ${JSON.stringify({
  interruptedAttempts: interrupted.length,
  plansPersisted: plans.length,
  attemptsPersisted: attempts.length,
  attemptStatuses: attempts.map((item) => item.status),
  evidencePersisted: evidence.length,
  evidenceStatuses: evidence.map((record) => record.status),
  integrityFailures,
  summaryComplete: summary?.verificationComplete ?? null,
  summaryReasons: summary?.reasons ?? null,
  structuredOutcome: structured.outcome,
  structuredBlockers: structured.blockers.map((blocker) => blocker.code),
  legacyOutcome: legacy.outcome,
  legacyBlockers: legacy.blockers.map((blocker) => blocker.code),
  reuse,
  mutatedAfterVerification: mutate,
})}\n`);
await persistence.close();
process.exit(0);
