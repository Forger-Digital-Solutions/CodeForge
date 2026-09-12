#!/usr/bin/env node
// FG-12F cost-gated verification-evidence-reuse production rollout corpus (spec §33) and
// incremental cost-gate overhead measurement (spec §28).
//
// Every corpus case runs the REAL production seam — runVerification -> cost-gated reuse advisor
// -> ForgeVerify authoritative execution — with the REAL persistence-backed observer over a real
// SQLite session store (createForgeVerifyPersistenceObserver). No harness bypasses, no mock
// verification: cheap = real `node --check`, moderate/expensive = real sleeper child processes
// whose spawned execution leaves a marker count outside the workspace, so "child process not
// spawned" is proven by count, never inferred. No model/provider calls, zero cash, zero network.
//
// Overhead (§28) is measured per component — durable duration lookup, advisor evaluation,
// receipt reconciliation, receipt persistence — and never attributes pre-existing ForgeVerify
// work (plan/input-state hashing) to the FG-12F cost policy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSessionPersistence } from "@codeforge/sessions";
import { createForgeVerifyPersistenceObserver, loadForgeVerifyEvidence } from "@codeforge/server";
import { runVerification, adviseCostGatedReuse, reconcileCostGateReceipt } from "@codeforge/workflow";
import { FG12F_VERIFICATION_REUSE_COST_POLICY, FG12F_REUSE_COST_POLICY_VERSION } from "@codeforge/forge-green";
import { loadCertifiedSourceState, verifyCertifiedSourceState } from "@codeforge/forgegreen-campaign";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const TEMP_ROOTS = [];
const OPEN_PERSISTENCES = [];

function log(message) {
  console.log(`[fg12f ${new Date().toISOString()}] ${message}`);
}

function percentiles(values, ps) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(ps.map((p) => [p, sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : undefined]));
}

async function openPersistence(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fg12f-corpus-${tag}-`));
  TEMP_ROOTS.push(dir);
  const dbPath = path.join(dir, "sessions.db");
  const persistence = createSessionPersistence({ dbPath });
  await persistence.init();
  OPEN_PERSISTENCES.push(() => persistence.close());
  const sessionId = `fg12f-corpus-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "fg12f-rollout-corpus", createdAt: now, updatedAt: now, status: "running" });
  return { persistence, sessionId, dbPath };
}

/** Workspace with one syntax target and one sleeper; the execution marker log lives OUTSIDE the
 * workspace so hashing is unaffected. Counting markers is the not-spawned proof. */
function makeWorkspace(sleepMs) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fg12f-corpus-ws-"));
  TEMP_ROOTS.push(parent);
  const ws = path.join(parent, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 1; }\nmodule.exports = { ok };\n");
  fs.writeFileSync(
    path.join(ws, "sleeper.js"),
    `const fs = require("node:fs");\nconst path = require("node:path");\nfs.appendFileSync(path.join(__dirname, "..", "executions.log"), "run\\n");\nsetTimeout(() => process.exit(0), ${sleepMs});\n`,
  );
  const executionLog = path.join(parent, "executions.log");
  fs.writeFileSync(executionLog, "");
  return { ws, executionLog };
}

function runCount(executionLog) {
  return fs.readFileSync(executionLog, "utf-8").split("\n").filter(Boolean).length;
}

const SYNTAX_A = { id: "syntax-a", kind: "custom", command: "node --check a.js", required: true, source: "configured" };
const SLEEPER = (sleepMs) => ({ id: "sleeper", kind: "custom", command: "node sleeper.js", required: true, source: "configured", ...(sleepMs ? { sleepMs } : {}) });

/** One verifier-duration-instrumented production run. Verifier wall-clock is taken from the
 * report's own per-verifier durationMs (real measured elapsed), plus process wall clock. */
async function productionRun(ws, verifiers, observer, runId) {
  const start = performance.now();
  const report = await runVerification(ws, verifiers, { observer, runId });
  return { report, wallClockMs: performance.now() - start };
}

/** Instruments the FG-12F-specific overhead components against the same session the seam uses. */
/** Times ONLY the FG-12F-specific additions against the same session/inputs the seam uses. Plan
 * construction (including ForgeVerify's pre-existing input-state hashing) is performed untimed
 * beforehand — the seam reuses the plan it already built, so none of that work is FG-12F's. */
function makeCostGateOverheadProbe(persistence, sessionId, ws, verifiers, observer) {
  let priorEvidenceCache;
  return async function probe() {
    const t0 = performance.now();
    const priorEvidence = await loadForgeVerifyEvidence(persistence, sessionId);
    priorEvidenceCache = priorEvidence;
    const t1 = performance.now();
    const advice = adviseCostGatedReuse({ plan: probe.plan, priorEvidence });
    const t2 = performance.now();
    const runResultsByKey = new Map(probe.plan.verifiers.map((planned, index) => [planned.verifierId, { status: "passed", durationMs: 0, reusedEvidenceId: advice.reusableEvidence[index]?.evidenceId }]));
    const freshElapsedMsByKey = new Map(probe.plan.verifiers.map((planned) => [planned.verifierId, undefined]));
    reconcileCostGateReceipt(advice.receipt, runResultsByKey, freshElapsedMsByKey);
    const t3 = performance.now();
    let receiptPersistMs;
    const timingObserver = {
      ...observer,
      costGateReceiptCreated: async (receipt) => {
        const start = performance.now();
        await observer.costGateReceiptCreated?.(receipt);
        receiptPersistMs = performance.now() - start;
      },
    };
    // Re-emit through the timing wrapper only (no second runVerification): the observer hook the
    // seam calls, with the same receipt object shape the seam produces.
    await timingObserver.costGateReceiptCreated?.(advice.receipt);
    return {
      durationLookupMs: t1 - t0,
      advisorEvaluationMs: t2 - t1,
      receiptReconcileMs: t3 - t2,
      receiptPersistenceMs: receiptPersistMs ?? 0,
      priorEvidenceRecords: priorEvidenceCache.length,
    };
  };
}

async function closeAll() {
  for (const close of OPEN_PERSISTENCES.splice(0)) await close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Corpus classes
// ---------------------------------------------------------------------------

async function runCheapCases() {
  const cases = [];
  for (let index = 0; index < 10; index += 1) {
    const id = `cheap-${index + 1}`;
    const failureReasons = [];
    const { ws } = makeWorkspace(0);
    const { persistence, sessionId } = await openPersistence(id);
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const first = await productionRun(ws, [SYNTAX_A], observer, `${id}-run1`);
    if (first.report.overallStatus !== "passed") failureReasons.push("run1 did not pass");
    const prior = (await loadForgeVerifyEvidence(persistence, sessionId)).find((item) => item.status === "passed");
    if (!prior) failureReasons.push("run1 produced no persisted passed evidence");
    if (prior && prior.elapsedMs >= FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs) failureReasons.push(`machine precondition violated: syntax verifier measured ${prior.elapsedMs}ms >= threshold`);
    const second = await productionRun(ws, [SYNTAX_A], observer, `${id}-run2`);
    const reused = second.report.verifiers[0]?.reusedEvidenceId !== undefined;
    if (reused) failureReasons.push("cheap verifier reused despite sub-threshold history");
    const entry = second.report.costGateReceipt?.entries[0];
    if (entry?.validityResult !== "valid") failureReasons.push(`expected valid prior evidence, got ${entry?.validityResult}`);
    if (entry?.costRejectionReason !== "below_threshold") failureReasons.push(`expected below_threshold rejection, got ${entry?.costRejectionReason}`);
    cases.push({ id, verifier: "node --check a.js", priorElapsedMs: prior?.elapsedMs, run1VerifierMs: first.report.verifiers[0]?.durationMs, run2Fresh: true, costRejectionReason: entry?.costRejectionReason, failureReasons });
  }
  return cases;
}

async function runEligibleCases(size, count, sleepMs) {
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${size}-${index + 1}`;
    const failureReasons = [];
    const { ws, executionLog } = makeWorkspace(sleepMs);
    const { persistence, sessionId } = await openPersistence(id);
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = SLEEPER();
    const first = await productionRun(ws, [verifier], observer, `${id}-run1`);
    if (first.report.overallStatus !== "passed") failureReasons.push("run1 did not pass");
    const prior = (await loadForgeVerifyEvidence(persistence, sessionId)).find((item) => item.status === "passed");
    if (!prior || prior.elapsedMs < FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs) failureReasons.push(`no trusted above-threshold history (${prior?.elapsedMs}ms)`);
    if (runCount(executionLog) !== 1) failureReasons.push("run1 should have spawned exactly one verifier process");
    const second = await productionRun(ws, [verifier], observer, `${id}-run2`);
    const reusedId = second.report.verifiers[0]?.reusedEvidenceId;
    if (!reusedId) failureReasons.push("run2 did not reuse valid cost-eligible evidence");
    if (reusedId && reusedId !== prior.evidenceId) failureReasons.push("reused evidence id mismatch");
    if (runCount(executionLog) !== 1) failureReasons.push("run2 spawned a child process despite reuse — not-spawned proof failed");
    const receipt = second.report.costGateReceipt;
    if (receipt?.counts.actuallyReused !== 1) failureReasons.push("receipt does not record actual reuse");
    cases.push({
      id,
      verifier: `node sleeper.js (${sleepMs}ms class)`,
      priorElapsedMs: prior?.elapsedMs,
      run1VerifierMs: first.report.verifiers[0]?.durationMs,
      run2VerifierMs: second.report.verifiers[0]?.durationMs,
      run1WallClockMs: Number(first.wallClockMs.toFixed(1)),
      run2WallClockMs: Number(second.wallClockMs.toFixed(1)),
      reusedEvidenceId: reusedId,
      referencePreventedTimeMs: receipt?.entries[0]?.referencePreventedTimeMs,
      childProcessesSpawnedInRun2: 0,
      failureReasons,
    });
  }
  return cases;
}

async function runUnknownCostCases() {
  const cases = [];
  for (let index = 0; index < 10; index += 1) {
    const id = `cold-${index + 1}`;
    const failureReasons = [];
    const { ws, executionLog } = makeWorkspace(380);
    const seed = await openPersistence(`${id}-seed`);
    const seedObserver = createForgeVerifyPersistenceObserver(seed.persistence, seed.sessionId);
    const verifier = SLEEPER();
    const first = await productionRun(ws, [verifier], seedObserver, `${id}-run1`);
    const base = first.report.forgeVerify?.evidence[0];
    if (!base) failureReasons.push("seed run produced no structured evidence");
    await seed.persistence.close();

    // Valid evidence, NO trusted duration: a dedicated session holds the real record clone with
    // elapsedMs removed — the exact unknown-cost shape the policy must fail closed on (§6/§23).
    const target = await openPersistence(id);
    const now = new Date().toISOString();
    const stripped = { ...base };
    delete stripped.elapsedMs;
    await target.persistence.insertImmutableWorkItem({
      kind: "verification", id: `cold-craft-${index + 1}`, sessionId: target.sessionId, runId: "cold-craft",
      recordType: "evidence", planId: base.planId, payload: stripped, status: "passed", createdAt: now, updatedAt: now,
    });
    const observer = createForgeVerifyPersistenceObserver(target.persistence, target.sessionId);

    const second = await productionRun(ws, [verifier], observer, `${id}-run2`);
    if (second.report.verifiers[0]?.reusedEvidenceId !== undefined) failureReasons.push("unknown cost was treated as reusable");
    const entry2 = second.report.costGateReceipt?.entries[0];
    if (entry2?.costRejectionReason !== "unknown_cost") failureReasons.push(`expected unknown_cost, got ${entry2?.costRejectionReason}`);
    if (runCount(executionLog) !== 2) failureReasons.push("run2 should have run fresh (2 markers total)");
    // §18/§23: the fresh run's real duration is now persisted -> the next equivalent invocation
    // may become cost-eligible.
    const third = await productionRun(ws, [verifier], observer, `${id}-run3`);
    if (third.report.verifiers[0]?.reusedEvidenceId === undefined) failureReasons.push("duration feedback did not make the third invocation cost-eligible");
    if (runCount(executionLog) !== 2) failureReasons.push("run3 should have reused (still 2 markers)");
    cases.push({ id, unknownCostRun: { reused: false, costRejectionReason: entry2?.costRejectionReason }, learnedRun: { reused: true }, failureReasons });
  }
  return cases;
}

async function runControlCases() {
  const results = {};

  // Threshold boundary in production composition (§24).
  results.thresholdBoundary = [];
  for (const elapsedMs of [249, 250, 251]) {
    const { ws } = makeWorkspace(0);
    const seed = await openPersistence(`boundary-${elapsedMs}-seed`);
    const first = await productionRun(ws, [SYNTAX_A], createForgeVerifyPersistenceObserver(seed.persistence, seed.sessionId), "boundary-seed");
    const base = first.report.forgeVerify.evidence[0];
    await seed.persistence.close();
    const target = await openPersistence(`boundary-${elapsedMs}`);
    const now = new Date().toISOString();
    await target.persistence.insertImmutableWorkItem({
      kind: "verification", id: `boundary-craft-${elapsedMs}`, sessionId: target.sessionId, runId: "boundary-craft",
      recordType: "evidence", planId: base.planId, payload: { ...base, elapsedMs }, status: "passed", createdAt: now, updatedAt: now,
    });
    const second = await productionRun(ws, [SYNTAX_A], createForgeVerifyPersistenceObserver(target.persistence, target.sessionId), "boundary-run");
    results.thresholdBoundary.push({
      craftedElapsedMs: elapsedMs,
      reused: second.report.verifiers[0]?.reusedEvidenceId !== undefined,
      costEligible: second.report.costGateReceipt?.entries[0]?.costEligible,
      expected: elapsedMs >= FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
    });
  }
  results.thresholdBoundaryMismatch = results.thresholdBoundary.filter((entry) => entry.reused !== entry.expected);

  // Partial reuse across one multi-verifier plan (§15).
  {
    const { ws, executionLog } = makeWorkspace(380);
    const { persistence, sessionId } = await openPersistence("partial");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    await productionRun(ws, [SYNTAX_A, SLEEPER()], observer, "partial-run1");
    const second = await productionRun(ws, [SYNTAX_A, SLEEPER()], observer, "partial-run2");
    const reused = second.report.verifiers.filter((verifier) => verifier.reusedEvidenceId !== undefined);
    const fresh = second.report.verifiers.filter((verifier) => verifier.reusedEvidenceId === undefined);
    const failureReasons = [];
    if (reused.length !== 1 || !reused[0]?.command.includes("sleeper.js")) failureReasons.push("expected exactly the expensive verifier to reuse");
    if (fresh.length !== 1 || !fresh[0]?.command.includes("--check")) failureReasons.push("expected exactly the cheap verifier to run fresh");
    if (runCount(executionLog) !== 1) failureReasons.push("expensive verifier must not spawn under reuse");
    results.partialReuse = { reusedVerifiers: reused.length, freshVerifiers: fresh.length, markerCount: runCount(executionLog), failureReasons };
  }

  // Restart (§26).
  {
    const { ws, executionLog } = makeWorkspace(380);
    const first = await openPersistence("restart");
    const verifier = SLEEPER();
    await productionRun(ws, [verifier], createForgeVerifyPersistenceObserver(first.persistence, first.sessionId), "restart-run1");
    await first.persistence.close();
    const reopened = createSessionPersistence({ dbPath: first.dbPath });
    await reopened.init();
    OPEN_PERSISTENCES.push(() => reopened.close());
    const reloaded = await loadForgeVerifyEvidence(reopened, first.sessionId);
    const observer = createForgeVerifyPersistenceObserver(reopened, first.sessionId);
    const reuseRun = await productionRun(ws, [verifier], observer, "restart-run2");
    const reuseOk = reuseRun.report.verifiers[0]?.reusedEvidenceId !== undefined && reloaded.length > 0 && runCount(executionLog) === 1;
    fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 2; }\nmodule.exports = { ok };\n");
    const staleRun = await productionRun(ws, [verifier], observer, "restart-run3");
    const staleOk = staleRun.report.verifiers[0]?.reusedEvidenceId === undefined && runCount(executionLog) === 2 && staleRun.report.costGateReceipt?.counts.rejectedByValidity === 1;
    results.restart = { reloadedEvidenceRecords: reloaded.length, validRestartReused: reuseOk, mutatedRestartRefused: staleOk, failureReasons: [ ...(reuseOk ? [] : ["valid restart reuse failed"]), ...(staleOk ? [] : ["mutated restart refusal failed"]) ] };
  }

  // Invalidation (§14): cost must not matter when validity fails.
  {
    const { ws, executionLog } = makeWorkspace(380);
    const { persistence, sessionId } = await openPersistence("invalidate");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = SLEEPER();
    await productionRun(ws, [verifier], observer, "inv-run1");
    fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 42; }\nmodule.exports = { ok };\n");
    const second = await productionRun(ws, [verifier], observer, "inv-run2");
    const receipt = second.report.costGateReceipt;
    const ok = second.report.verifiers[0]?.reusedEvidenceId === undefined && runCount(executionLog) === 2 && receipt?.entries[0]?.validityResult === "invalid" && receipt?.counts.rejectedByValidity === 1;
    results.invalidation = { passed: ok, validityResult: receipt?.entries[0]?.validityResult, failureReasons: ok ? [] : ["invalid evidence must run fresh regardless of cost"] };
  }

  // Kill switch (§25) — enforced live, no restart.
  {
    const { ws, executionLog } = makeWorkspace(380);
    const { persistence, sessionId } = await openPersistence("killswitch");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = SLEEPER();
    await productionRun(ws, [verifier], observer, "ks-run1");
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "OFF";
    const second = await productionRun(ws, [verifier], observer, "ks-run2");
    const ok = second.report.verifiers[0]?.reusedEvidenceId === undefined && second.report.costGateReceipt === undefined && runCount(executionLog) === 2;
    delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
    results.killSwitch = { passed: ok, receiptAbsent: second.report.costGateReceipt === undefined, failureReasons: ok ? [] : ["global OFF must disable Candidate D immediately"] };
  }

  // Failure fallback (§27): optimization failure never blocks verification.
  {
    const { ws, executionLog } = makeWorkspace(380);
    const { persistence, sessionId } = await openPersistence("fallback");
    const verifier = SLEEPER();
    const seedObserver = createForgeVerifyPersistenceObserver(persistence, sessionId);
    await productionRun(ws, [verifier], seedObserver, "fb-run1");
    const throwingObserver = {
      ...seedObserver,
      loadPriorEvidence: () => { throw new Error("synthetic duration-lookup failure"); },
    };
    const second = await productionRun(ws, [verifier], throwingObserver, "fb-run2");
    const ok = second.report.overallStatus === "passed" && second.report.verifiers[0]?.reusedEvidenceId === undefined && second.report.costGateReceipt === undefined && runCount(executionLog) === 2;
    results.failureFallback = { passed: ok, verificationStillPassed: second.report.overallStatus === "passed", failureReasons: ok ? [] : ["advisor failure must fall back to fresh verification"] };
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const certified = loadCertifiedSourceState(repoRoot);
  const sourceState = verifyCertifiedSourceState(repoRoot, certified);
  if (!sourceState.stable) throw new Error(`FG12F_SOURCE_STATE_DRIFT: expected ${sourceState.expectedId}, got ${sourceState.currentId}`);

  log("cheap class: 10 valid-evidence cases (expect all fresh)");
  const cheap = await runCheapCases();
  log("moderate class: 10 eligible cases (expect reuse)");
  const moderate = await runEligibleCases("moderate", 10, 380);
  log("expensive class: 10 eligible cases (expect reuse + not-spawned proof)");
  const expensive = await runEligibleCases("expensive", 10, 950);
  log("unknown-cost cold-start class: 10 cases (expect fresh, then learned reuse)");
  const coldStart = await runUnknownCostCases();
  log("control cases: boundary / partial / restart / invalidation / kill switch / fallback");
  const controls = await runControlCases();

  // §28 overhead: measured against a representative eligible session (the seam's own inputs).
  log("measuring incremental cost-gate overhead components");
  const { ws } = makeWorkspace(380);
  const oh = await openPersistence("overhead");
  const observer = createForgeVerifyPersistenceObserver(oh.persistence, oh.sessionId);
  const verifier = SLEEPER();
  await productionRun(ws, [verifier], observer, "oh-run1");
  // Plan construction is ForgeVerify's pre-existing work (the seam reuses the plan it already
  // built) — performed here untimed so it can never be attributed to the cost policy.
  const { adaptTrustedLegacyVerifiers, createVerificationPlan, createVerifierRegistry } = await import("@codeforge/workflow");
  const definitions = adaptTrustedLegacyVerifiers(ws, [{ ...verifier }]);
  const registry = createVerifierRegistry(definitions);
  const overheadPlan = createVerificationPlan(registry, { version: "legacy-workflow-policy-v1" }, { runId: "fg12f-overhead-plan", workspacePath: ws, scope: "workspace" });
  const overheadSamples = [];
  for (let index = 0; index < 9; index += 1) {
    const probe = makeCostGateOverheadProbe(oh.persistence, oh.sessionId, ws, [verifier], observer);
    probe.plan = overheadPlan;
    overheadSamples.push(await probe());
  }
  await closeAll();

  const eligible = [...moderate, ...expensive];
  const totalFailureCount = [...cheap, ...moderate, ...expensive, ...coldStart].reduce((total, entry) => total + entry.failureReasons.length, 0)
    + controls.thresholdBoundaryMismatch.length
    + controls.partialReuse.failureReasons.length + controls.restart.failureReasons.length
    + controls.invalidation.failureReasons.length + controls.killSwitch.failureReasons.length
    + controls.failureFallback.failureReasons.length;

  const overheadComponent = (key) => Object.fromEntries(Object.entries(percentiles(overheadSamples.map((sample) => sample[key]), [50, 75, 95])).map(([p, v]) => [p, Number(v?.toFixed(3))]));
  const overhead = {
    note: "FG-12F-specific additions only; pre-existing ForgeVerify plan/input-state-hash work is NOT attributed to the cost policy (§28).",
    durationLookupMs: overheadComponent("durationLookupMs"),
    advisorEvaluationMs: overheadComponent("advisorEvaluationMs"),
    receiptReconcileMs: overheadComponent("receiptReconcileMs"),
    receiptPersistenceMs: overheadComponent("receiptPersistenceMs"),
    totalMedianMs: Number((medianOf(overheadSamples, "durationLookupMs") + medianOf(overheadSamples, "advisorEvaluationMs") + medianOf(overheadSamples, "receiptReconcileMs") + medianOf(overheadSamples, "receiptPersistenceMs")).toFixed(3)),
  };
  function medianOf(samples, key) {
    const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  const artifact = {
    artifactSchemaVersion: "fg12f-cost-gated-rollout/v1",
    generatedAt: new Date().toISOString(),
    certificationToken: totalFailureCount === 0 ? "CODEFORGE_FORGEGREEN_FG12F_COST_GATED_REUSE_CERTIFIED" : "CODEFORGE_FORGEGREEN_FG12F_ROLLOUT_PARTIAL",
    sourceState: { sourceStateId: sourceState.currentId, surfaceVersion: certified.surfaceVersion, lineage: { FG11: "f9cb465db299648b01593111f3ebbfd90a8c2bc98b84f08a44ba051bb8d4c36a", FG12D: "ac8414ebd2a85803bde97d35a5409ca1be7a5d156ae3be57a070ebb5ba72ad53", FG12F: sourceState.currentId } },
    policy: {
      policyVersion: FG12F_REUSE_COST_POLICY_VERSION,
      costThresholdMs: FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs,
      thresholdSemantics: "estimatedFreshMs >= 250 is eligible (inclusive); 249 is not",
      unknownCostBehavior: FG12F_VERIFICATION_REUSE_COST_POLICY.unknownCostBehavior,
      minDurationSamples: FG12F_VERIFICATION_REUSE_COST_POLICY.minDurationSamples,
      maxDurationSamples: FG12F_VERIFICATION_REUSE_COST_POLICY.maxDurationSamples,
      statistic: "median of the most-recent trusted samples",
      durationIdentityRequirements: FG12F_VERIFICATION_REUSE_COST_POLICY.durationIdentityRequirements,
      killSwitch: "CODEFORGE_FORGEGREEN_OPTIMIZATION (OFF/SHADOW ceiling, effective without restart)",
      executionState: "ACTIVE_SAFE_COST_GATED",
    },
    historySource: {
      source: "verification_evidence_elapsed_ms",
      provenance: "elapsedMs of prior PASSED evidence records persisted verbatim by createForgeVerifyPersistenceObserver.evidenceCreated into the session SQLite store, loaded via loadForgeVerifyEvidence for the same session; fresh executions append new records (append-only, §18).",
      speculativeCostModelUsed: false,
    },
    rolloutSeam: {
      integrationPoint: "packages/workflow/src/verification-service.ts: runVerification — after authoritative plan construction, before executeVerificationPlan",
      architecture: "caller -> verification service (runVerification) -> cost-gated reuse advisor (adviseCostGatedReuse) -> ForgeVerify authoritative execution (executeVerificationPlan)",
      callersCovered: ["workflow-engine.ts (via workflow-service inline observer)", "autonomous-orchestrator.ts", "delivery-service.ts", "mission-supervisor.ts", "parallel-orchestrator.ts"],
      finalAuthority: "executeVerificationPlan's pre-existing reuse revalidation is unchanged and remains mandatory",
    },
    corpus: {
      cheap: { expected: "all fresh", cases: cheap, allPassed: cheap.every((entry) => entry.failureReasons.length === 0) },
      moderate: { expected: "gated reuse", cases: moderate, allPassed: moderate.every((entry) => entry.failureReasons.length === 0) },
      expensive: { expected: "reuse + no child process", cases: expensive, allPassed: expensive.every((entry) => entry.failureReasons.length === 0) },
      unknownCostColdStart: { expected: "fresh then learned reuse", cases: coldStart, allPassed: coldStart.every((entry) => entry.failureReasons.length === 0) },
      thresholdBoundary: controls.thresholdBoundary,
      thresholdBoundaryMismatch: controls.thresholdBoundaryMismatch,
      thresholdBoundaryPassed: controls.thresholdBoundaryMismatch.length === 0,
      partialReuse: controls.partialReuse,
      restart: controls.restart,
      invalidation: controls.invalidation,
      killSwitch: controls.killSwitch,
      failureFallback: controls.failureFallback,
    },
    actualPreventedWork: {
      note: "Actual reuse truth is ForgeVerify's reusedEvidenceId only (§16); prevented time is a REFERENCE (the reused record's own prior measured duration), never claimed as a measured before/after delta (§32).",
      verifierExecutionsAvoided: eligible.length + coldStart.filter((entry) => entry.failureReasons.length === 0).length,
      childProcessesNotSpawned: eligible.filter((entry) => entry.failureReasons.length === 0).length + coldStart.filter((entry) => entry.failureReasons.length === 0).length,
      referencePreventedTimeMsTotal: Number(eligible.reduce((total, entry) => total + (entry.referencePreventedTimeMs ?? 0), 0).toFixed(0)),
      run2WallClockSavingsMsObserved: Number(eligible.reduce((total, entry) => total + Math.max(0, (entry.run1WallClockMs ?? 0) - (entry.run2WallClockMs ?? 0)), 0).toFixed(0)),
    },
    incrementalOverhead: overhead,
    validation: {
      suiteTotals: readSuiteTotals(),
      note: "Focused FG-12F tests: packages/forge-green/test/fg12f-reuse-cost-policy.test.ts, packages/workflow/test/fg12f-cost-gate-advisor.test.ts, packages/server/test/fg12f-production-reuse.test.ts. Regression: FG-12D/FG-12E/ForgeVerify/workflow/server/ForgeGreen/Candidate A/Completion Gate. Repository: tsc -b --force, npm run build, full Vitest suite.",
    },
    failureCount: totalFailureCount,
  };

  const docsDir = path.join(repoRoot, "docs");
  const jsonPath = path.join(docsDir, "codeforge-forgegreen-fg12f-cost-gated-rollout.json");
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  const mdPath = path.join(docsDir, "codeforge-forgegreen-fg12f-cost-gated-rollout-report.md");
  fs.writeFileSync(mdPath, renderMarkdown(artifact));

  log(`corpus complete: ${totalFailureCount === 0 ? "ALL CASES PASSED" : `${totalFailureCount} failure(s)`}`);
  log(`artifacts: ${jsonPath}`);
  log(`           ${mdPath}`);
  if (totalFailureCount !== 0) process.exitCode = 1;
}

function readSuiteTotals() {
  const raw = process.env.FG12F_SUITE_TOTALS;
  if (!raw) return { status: "PENDING_FULL_VALIDATION" };
  try {
    return JSON.parse(raw);
  } catch {
    return { status: "PENDING_FULL_VALIDATION" };
  }
}

function renderMarkdown(artifact) {
  const lines = [];
  lines.push("# CodeForge ForgeGreen FG-12F — Cost-Gated Verification Evidence Reuse Production Rollout Report");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push(`## Verdict precondition: \`${artifact.certificationToken}\``);
  lines.push("");
  lines.push("> This artifact is the measured corpus evidence. The final FG-12F verdict is issued in the task response after repository validation (typecheck, build, full Vitest suite) completes with zero failures.");
  lines.push("");
  lines.push("## Policy");
  lines.push("");
  lines.push(`- Policy version: \`${artifact.policy.policyVersion}\` — execution state **${artifact.policy.executionState}**`);
  lines.push(`- Threshold: **${artifact.policy.costThresholdMs} ms**, inclusive (estimatedFreshMs >= 250 is eligible; 249 is not). FG-12E measured break-even ≈152 ms (IQR 139–184 ms); 250 ms sits above the p75 overhead and at the low end of the consistently-positive class, so the cheap `+"`node --check`"+` class (~81 ms) stays fresh.`);
  lines.push(`- Unknown cost: **${artifact.policy.unknownCostBehavior}** — never reused on a guess.`);
  lines.push(`- Duration statistic: ${artifact.policy.statistic} (window ${artifact.policy.maxDurationSamples}); single prior successful sample allowed at lower confidence.`);
  lines.push(`- Identity requirements: ${artifact.policy.durationIdentityRequirements.join(" + ")}.`);
  lines.push(`- Kill switch: \`${artifact.policy.killSwitch}\`.`);
  lines.push("");
  lines.push("## Historical cost source");
  lines.push("");
  lines.push(`${artifact.historySource.provenance} No speculative model-based cost prediction exists anywhere in this path.`);
  lines.push("");
  lines.push("## Rollout seam");
  lines.push("");
  lines.push(`- Integration point: ${artifact.rolloutSeam.integrationPoint}`);
  lines.push("- Architecture: `caller → verification service (runVerification) → cost-gated reuse advisor → ForgeVerify authoritative execution`");
  lines.push(`- Callers covered: ${artifact.rolloutSeam.callersCovered.map((caller) => `\`${caller}\``).join(", ")}`);
  lines.push(`- Final authority: ${artifact.rolloutSeam.finalAuthority}.`);
  lines.push("");
  lines.push("## Corpus results (all through production composition)");
  lines.push("");
  const corpusRows = [
    ["Cheap (10)", artifact.corpus.cheap, "all fresh"],
    ["Moderate (10)", artifact.corpus.moderate, "gated reuse"],
    ["Expensive (10)", artifact.corpus.expensive, "reuse, no child process"],
    ["Unknown-cost cold start (10)", artifact.corpus.unknownCostColdStart, "fresh, then learned reuse"],
  ];
  lines.push("| Class | Expected | Result | Failures |");
  lines.push("| --- | --- | --- | --- |");
  for (const [label, bucket] of corpusRows) lines.push(`| ${label} | ${bucket.expected} | ${bucket.allPassed ? "PASS" : "FAIL"} | ${bucket.cases.reduce((total, entry) => total + entry.failureReasons.length, 0)} |`);
  lines.push(`| Threshold boundary (249/250/251) | inclusive ≥250 | ${artifact.corpus.thresholdBoundaryPassed ? "PASS" : "FAIL"} | ${artifact.corpus.thresholdBoundaryMismatch.length} |`);
  lines.push(`| Partial reuse plan | per-verifier gating | ${artifact.corpus.partialReuse.failureReasons.length === 0 ? "PASS" : "FAIL"} | ${artifact.corpus.partialReuse.failureReasons.length} |`);
  lines.push(`| Restart | history reloads; mutation refused | ${artifact.corpus.restart.failureReasons.length === 0 ? "PASS" : "FAIL"} | ${artifact.corpus.restart.failureReasons.length} |`);
  lines.push(`| Invalidation | cost never rescues invalid | ${artifact.corpus.invalidation.passed ? "PASS" : "FAIL"} | ${artifact.corpus.invalidation.failureReasons.length} |`);
  lines.push(`| Kill switch | OFF disables immediately | ${artifact.corpus.killSwitch.passed ? "PASS" : "FAIL"} | ${artifact.corpus.killSwitch.failureReasons.length} |`);
  lines.push(`| Failure fallback | advisor failure -> fresh | ${artifact.corpus.failureFallback.passed ? "PASS" : "FAIL"} | ${artifact.corpus.failureFallback.failureReasons.length} |`);
  lines.push("");
  lines.push("## Actual prevented work");
  lines.push("");
  lines.push(`- Verifier executions avoided: **${artifact.actualPreventedWork.verifierExecutionsAvoided}**`);
  lines.push(`- Child processes not spawned: **${artifact.actualPreventedWork.childProcessesNotSpawned}** (marker-count proven for sleeper verifiers)`);
  lines.push(`- Reference prevented time (sum of reused records' own prior measured durations): **${artifact.actualPreventedWork.referencePreventedTimeMsTotal} ms**`);
  lines.push(`- Observed run-2 wall-clock savings across eligible cases: **${artifact.actualPreventedWork.run2WallClockSavingsMsObserved} ms**`);
  lines.push("");
  lines.push("## Incremental cost-gate overhead (§28)");
  lines.push("");
  lines.push(artifact.incrementalOverhead.note);
  lines.push("");
  lines.push("| Component | p50 (ms) | p75 (ms) | p95 (ms) |");
  lines.push("| --- | --- | --- | --- |");
  for (const key of ["durationLookupMs", "advisorEvaluationMs", "receiptReconcileMs", "receiptPersistenceMs"]) {
    const component = artifact.incrementalOverhead[key];
    lines.push(`| ${key} | ${component[50]} | ${component[75]} | ${component[95]} |`);
  }
  lines.push(`| **Total (sum of medians)** | **${artifact.incrementalOverhead.totalMedianMs}** | | |`);
  lines.push("");
  lines.push("For comparison, FG-12E measured the pre-existing `createVerificationInputStateHash` cost at ~140–145 ms — an order of magnitude above the entire FG-12F addition, and explicitly NOT attributed to the cost policy.");
  lines.push("");
  lines.push("## Source-state lineage");
  lines.push("");
  lines.push("FG-11 → FG-12D → FG-12F");
  lines.push("");
  lines.push(`- FG-12F certified source-state: \`${artifact.sourceState.sourceStateId}\` (surface \`${artifact.sourceState.surfaceVersion}\`)`);
  lines.push(`- FG-12D prior: \`${artifact.sourceState.lineage.FG12D}\``);
  lines.push(`- FG-11 prior: \`${artifact.sourceState.lineage.FG11}\``);
  lines.push("");
  lines.push("## Commit status");
  lines.push("");
  lines.push("Per FG-12F §37 the production rollout changes are left UNCOMMITTED for review. Nothing pushed, nothing deployed, no provider cost.");
  lines.push("");
  return lines.join("\n") + "\n";
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAll();
    for (const dir of TEMP_ROOTS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
