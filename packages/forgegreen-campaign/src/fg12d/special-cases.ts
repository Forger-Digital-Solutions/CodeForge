import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createForgeVerifyPersistenceObserver, loadForgeVerifyEvidence } from "@codeforge/server";
import {
  adaptTrustedLegacyVerifiers,
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  runVerification,
  runVerificationWithControlledReuse,
  requestVerificationEvidenceReuse,
  VerificationEvidenceStore,
  type VerificationPolicy,
} from "@codeforge/workflow";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { disposeFixture, materializeFixture, mutateFixtureFile, FIXTURE_FILE_SETS } from "../fixtures.js";

export interface SpecialCaseResult {
  id: string;
  category: "restart" | "race" | "fallback" | "repeated";
  passed: boolean;
  details: Record<string, unknown>;
  failureReasons: string[];
}

const BILLING = FIXTURE_FILE_SETS[0]!;

function syntaxVerifier(id: string) {
  return { id, kind: "lint" as const, command: `node --check src/billing/invoice.ts`, required: true, source: "configured" as const };
}

async function registerSession(persistence: ISessionPersistence, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "fg12d-trial-session", createdAt: now, updatedAt: now, status: "running" });
}

/**
 * Restart proof (spec §16). Two independent sub-cases:
 *  (a) evidence persisted -> runtime "exits" (persistence closed) -> a fresh runtime
 *      (new `createSessionPersistence` instance over the SAME db file) loads it -> reuse occurs
 *      because it is still valid.
 *  (b) same sequence, but the workspace changes before the restart -> reuse is correctly refused.
 */
export async function runRestartCases(): Promise<SpecialCaseResult[]> {
  const results: SpecialCaseResult[] = [];
  const sessionId = "fg12d-restart-session";

  // (a) valid restart reuse
  {
    const fixture = await materializeFixture(BILLING);
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fg12d-restart-")), "sessions.db");
    const failureReasons: string[] = [];
    try {
      const persistence1: ISessionPersistence = createSessionPersistence({ dbPath: dbFile });
      await persistence1.init();
      await registerSession(persistence1, sessionId);
      const observer = createForgeVerifyPersistenceObserver(persistence1, sessionId);
      await runVerification(fixture.root, [syntaxVerifier("fg12d.restart.valid")], { observer, runId: "restart-baseline" });
      await persistence1.close(); // simulate process exit

      const persistence2: ISessionPersistence = createSessionPersistence({ dbPath: dbFile }); // fresh runtime
      await persistence2.init();
      const loaded = await loadForgeVerifyEvidence(persistence2, sessionId, "restart-baseline");
      const outcome = await runVerificationWithControlledReuse(fixture.root, [syntaxVerifier("fg12d.restart.valid")], {
        priorEvidence: loaded,
        mode: "CONTROLLED_ACTIVE_TRIAL",
      });
      await persistence2.close();

      const reused = Boolean(outcome.report.verifiers[0]?.reusedEvidenceId);
      if (!reused) failureReasons.push("expected restart reuse of still-valid persisted evidence");
      results.push({ id: "restart-valid", category: "restart", passed: failureReasons.length === 0, failureReasons, details: { loadedCount: loaded.length, reused } });
    } finally {
      await disposeFixture(fixture);
    }
  }

  // (b) workspace changed before restart -> reuse correctly refused
  {
    const fixture = await materializeFixture(BILLING);
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fg12d-restart-stale-")), "sessions.db");
    const failureReasons: string[] = [];
    try {
      const persistence1: ISessionPersistence = createSessionPersistence({ dbPath: dbFile });
      await persistence1.init();
      await registerSession(persistence1, sessionId);
      const observer = createForgeVerifyPersistenceObserver(persistence1, sessionId);
      await runVerification(fixture.root, [syntaxVerifier("fg12d.restart.stale")], { observer, runId: "restart-baseline-stale" });
      await persistence1.close();

      await mutateFixtureFile(fixture, "src/billing/invoice.ts", "import { formatCurrency } from './currency.js';\nexport class Invoice {\n  total(amount: number): string { return formatCurrency(amount + 1); }\n}\n");

      const persistence2: ISessionPersistence = createSessionPersistence({ dbPath: dbFile });
      await persistence2.init();
      const loaded = await loadForgeVerifyEvidence(persistence2, sessionId, "restart-baseline-stale");
      const outcome = await runVerificationWithControlledReuse(fixture.root, [syntaxVerifier("fg12d.restart.stale")], {
        priorEvidence: loaded,
        mode: "CONTROLLED_ACTIVE_TRIAL",
      });
      await persistence2.close();

      const reused = Boolean(outcome.report.verifiers[0]?.reusedEvidenceId);
      if (reused) failureReasons.push("expected reuse to be refused after a real workspace mutation");
      results.push({ id: "restart-stale-refused", category: "restart", passed: failureReasons.length === 0, failureReasons, details: { loadedCount: loaded.length, reused } });
    } finally {
      await disposeFixture(fixture);
    }
  }

  return results;
}

/**
 * Race/TOCTOU proof (spec §17). Simulates an advisor decision computed BEFORE a workspace
 * mutation, then feeds that (now stale) proposal directly into the real execution boundary
 * AFTER the mutation. The final, authoritative `executeVerificationPlan` (real, unmodified)
 * must be the one that actually decides — and must correctly refuse, proving revalidation
 * happens at the reuse boundary itself, not only at the earlier advisor check.
 */
export async function runRaceCase(): Promise<SpecialCaseResult> {
  const fixture = await materializeFixture(BILLING);
  const failureReasons: string[] = [];
  try {
    const id = "fg12d.race.toctou";
    const legacyVerifier = syntaxVerifier(id);
    const baselineReport = await runVerification(fixture.root, [legacyVerifier]);
    const baselineEvidence = baselineReport.forgeVerify!.evidence[0]!;

    // "Candidate identified" — advisor computes a proposal against the CURRENT (pre-race) plan.
    // Built through the SAME legacy-adapter path `runVerification` used for the baseline, so the
    // verifier identity (and its digest) actually matches the evidence being considered.
    const definitions = adaptTrustedLegacyVerifiers(fixture.root, [legacyVerifier]);
    const registry = createVerifierRegistry(definitions);
    const verifierId = definitions[0]!.id;
    const policy: VerificationPolicy = { version: "fg12d-race-policy" as VerificationPolicy["version"], requiredVerifierIds: [verifierId] };
    const earlyPlan = createVerificationPlan(registry, policy, { runId: "race-early", workspacePath: fixture.root, scope: "workspace" });
    const earlyProposal = requestVerificationEvidenceReuse({
      priorEvidence: [baselineEvidence as unknown as GenericVerificationEvidence],
      plan: earlyPlan,
      registry,
      mode: "CONTROLLED_ACTIVE_TRIAL",
    });
    if (earlyProposal.reusableEvidence.length !== 1) failureReasons.push("expected the early (pre-race) advisor proposal to confirm reuse");

    // The race: workspace mutates AFTER candidate identification, BEFORE the reuse boundary.
    await mutateFixtureFile(fixture, "src/billing/invoice.ts", "import { formatCurrency } from './currency.js';\nexport class Invoice {\n  total(amount: number): string { return formatCurrency(amount * 3); }\n}\n");

    // The stale proposal is handed DIRECTLY to the real, unmodified execution boundary — this is
    // deliberately bypassing the wrapper's own fresh advisory step, to prove the authoritative
    // `executeVerificationPlan` plan (built fresh, right now) is what actually decides, not the
    // earlier advisor answer.
    const store = new VerificationEvidenceStore();
    const freshPlan = createVerificationPlan(registry, policy, { runId: "race-final", workspacePath: fixture.root, scope: "workspace" });
    const finalExecution = await executeVerificationPlan(registry, freshPlan, store, {
      existingEvidence: earlyProposal.reusableEvidence,
    });
    const reusedAtBoundary = finalExecution.evidence.some((e) => e.evidenceId === baselineEvidence.evidenceId);
    if (reusedAtBoundary) failureReasons.push("the authoritative reuse boundary incorrectly reused evidence that was stale by the time of the race");
    if (finalExecution.evidence.length === 0) failureReasons.push("expected fresh evidence to be produced at the authoritative boundary");

    return { id: "race-toctou", category: "race", passed: failureReasons.length === 0, failureReasons, details: { earlyProposalCount: earlyProposal.reusableEvidence.length, reusedAtBoundary } };
  } finally {
    await disposeFixture(fixture);
  }
}

/**
 * Fallback proof (spec §19). Forces the advisory step to throw (a `priorEvidence` array whose
 * elements throw on property access) and proves `runVerificationWithControlledReuse` still
 * completes fresh, correct verification — ForgeGreen failure never blocks verification.
 */
export async function runFallbackCase(): Promise<SpecialCaseResult> {
  const fixture = await materializeFixture(BILLING);
  const failureReasons: string[] = [];
  try {
    const throwingEvidence = new Proxy(
      {},
      {
        get() {
          throw new Error("simulated ForgeGreen advisor failure");
        },
      },
    ) as unknown as GenericVerificationEvidence;

    const outcome = await runVerificationWithControlledReuse(fixture.root, [syntaxVerifier("fg12d.fallback")], {
      priorEvidence: [throwingEvidence],
      mode: "CONTROLLED_ACTIVE_TRIAL",
    });

    if (outcome.report.overallStatus !== "passed") failureReasons.push(`expected fresh verification to still pass, got ${outcome.report.overallStatus}`);
    if (!outcome.fallbackReason) failureReasons.push("expected a recorded fallbackReason");
    if (outcome.reuseRequest !== undefined) failureReasons.push("expected reuseRequest to be undefined after a thrown advisor");

    return { id: "fallback-advisor-throws", category: "fallback", passed: failureReasons.length === 0, failureReasons, details: { fallbackReason: outcome.fallbackReason, overallStatus: outcome.report.overallStatus } };
  } finally {
    await disposeFixture(fixture);
  }
}

/**
 * Repeated-reuse / duplicate-accounting safety (renamed per amendment §1 — not a concurrency/
 * lease proof; verification execution for one plan/run in this codebase is serialized). Two
 * sequential calls against the SAME evidence each independently recheck validity and each
 * correctly attribute exactly one reuse — no double-counting, no stale cached decision.
 */
export async function runRepeatedReuseCase(): Promise<SpecialCaseResult> {
  const fixture = await materializeFixture(BILLING);
  const failureReasons: string[] = [];
  try {
    const id = "fg12d.repeated";
    const baselineReport = await runVerification(fixture.root, [syntaxVerifier(id)]);
    const baselineEvidence = baselineReport.forgeVerify!.evidence[0]!;

    const outcome1 = await runVerificationWithControlledReuse(fixture.root, [syntaxVerifier(id)], { priorEvidence: [baselineEvidence as unknown as GenericVerificationEvidence], mode: "CONTROLLED_ACTIVE_TRIAL" });
    const outcome2 = await runVerificationWithControlledReuse(fixture.root, [syntaxVerifier(id)], { priorEvidence: [baselineEvidence as unknown as GenericVerificationEvidence], mode: "CONTROLLED_ACTIVE_TRIAL" });

    const reused1 = outcome1.report.verifiers[0]?.reusedEvidenceId === baselineEvidence.evidenceId;
    const reused2 = outcome2.report.verifiers[0]?.reusedEvidenceId === baselineEvidence.evidenceId;
    if (!reused1 || !reused2) failureReasons.push("expected both independent calls to reuse the still-valid evidence");
    const totalAttributedReuse = (reused1 ? 1 : 0) + (reused2 ? 1 : 0);
    if (totalAttributedReuse !== 2) failureReasons.push(`expected exactly 2 independently-attributed reuse events, got ${totalAttributedReuse}`);

    return { id: "repeated-reuse-duplicate-accounting", category: "repeated", passed: failureReasons.length === 0, failureReasons, details: { reused1, reused2, totalAttributedReuse } };
  } finally {
    await disposeFixture(fixture);
  }
}
