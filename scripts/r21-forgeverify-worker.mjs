// R21 ForgeVerify chaos worker (process A). Runs one real verification against a workspace,
// persisting every ForgeVerify record through the production persistence observer, and prints a
// stage marker on stdout at each lifecycle point so the parent can SIGKILL it at exactly that
// point. Usage: node scripts/r21-forgeverify-worker.mjs <backend> <dbTarget> <sessionId> <workspace>
//   backend  = sqlite | pg      dbTarget = sqlite file path | postgres connection string
import { runVerification } from "../packages/workflow/dist/index.js";
import { createForgeVerifyPersistenceObserver } from "../packages/server/dist/index.js";
import { createSessionPersistence, PostgresSessionPersistence } from "../packages/sessions/dist/index.js";
import { evaluateCompletion, createVerificationInputStateHash } from "../packages/workflow/dist/index.js";

const [backend, dbTarget, sessionId, workspace] = process.argv.slice(2);
const mark = (stage) => { process.stdout.write(`R21_MARK ${stage}\n`); };

const persistence = backend === "pg" ? new PostgresSessionPersistence({ connectionString: dbTarget }) : createSessionPersistence({ dbPath: dbTarget });
if (backend === "pg") await persistence.init();
await persistence.upsertSession({ id: sessionId, title: "r21-chaos", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
mark("WORKER_READY");

const base = createForgeVerifyPersistenceObserver(persistence, sessionId);
const observer = {
  ...base,
  planCreated: async (plan) => { await base.planCreated(plan); mark("PLAN_CREATED"); },
  attemptStarted: async (attempt) => { await base.attemptStarted(attempt); mark("ATTEMPT_STARTED"); },
  attemptTerminal: async (attempt) => { mark("TESTS_EXITED"); await base.attemptTerminal(attempt); mark("ATTEMPT_TERMINAL"); },
  evidenceCreated: async (evidence) => { await base.evidenceCreated(evidence); mark("EVIDENCE_PERSISTED"); },
};

// Give the parent a window to kill "during tests": the verifier below sleeps ~1.5 s.
const report = await runVerification(workspace, ["node test.cjs"], { runId: `${sessionId}-run`, observer });
mark("SUMMARY_READY");

mark("GATE_START");
const decision = evaluateCompletion({
  plan: { id: "p", title: "chaos", taskId: sessionId, status: "completed", createdAt: "", updatedAt: "", steps: [
    { id: "edit", description: "edit", status: "completed", kind: "edit", risk: "safe", requiresApproval: false, targetPath: "src.js" },
    { id: "verify", description: "verify", status: report.requiredPassed ? "completed" : "failed", kind: "verify", risk: "safe", requiresApproval: false },
  ] },
  verification: report,
  verificationSummary: report.forgeVerify?.summary,
  analysis: { hasFailures: report.failed > 0, summary: report.output, diagnostics: [], suggestedRepairs: [], isRepairable: false },
  review: { approved: true, issues: [], findings: [], diffs: [{ path: "src.js", changeType: "modified", additions: 1, deletions: 0, diff: "+x", beforeHash: "a", afterHash: "b" }], summary: "1 file" },
  currentVerificationInputStateHash: createVerificationInputStateHash(workspace),
});
process.stdout.write(`R21_RESULT ${JSON.stringify({ requiredPassed: report.requiredPassed, outcome: decision.outcome, blockers: decision.blockers.map((b) => b.code) })}\n`);
mark("GATE_DONE");
await persistence.close();
process.exit(0);
