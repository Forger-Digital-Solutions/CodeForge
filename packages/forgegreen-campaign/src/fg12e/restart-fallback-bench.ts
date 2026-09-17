import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createForgeVerifyPersistenceObserver, loadForgeVerifyEvidence } from "@codeforge/server";
import type { Verifier } from "@codeforge/workflow";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { createTimelineObserver, round, timed } from "./timing.js";
import { alternatingOrder, produceBaselineEvidence, runPair, type PairReceipt } from "./pair-runner.js";
import { benchVerifiers, disposeBenchWorkspace, materializeBenchWorkspace, mutateBenchWorkspace, readBenchWorkspaceFile, toVerifier } from "./workloads.js";

/**
 * FG-12E restart (spec §23) and advisor-failure fallback (spec §24) benchmarks with an EXPENSIVE
 * verifier (the bench project's real `tsc --noEmit`), plus the historical-duration probe (§19).
 */

export interface RestartBenchResult {
  id: "restart-valid-reuse" | "restart-stale-refused";
  /** `loadForgeVerifyEvidence` from a freshly re-opened SQLite persistence (durable load). */
  durableEvidenceLoadMs: number;
  loadedEvidenceCount: number;
  /** Cumulative time inside the persistence observer during the baseline (write side). */
  baselinePersistenceWriteMs: number;
  /** Cumulative time inside the persistence observer during the treatment run. */
  treatmentPersistenceWriteMs: number;
  controlPersistenceWriteMs: number;
  receipts: PairReceipt[];
  expensiveVerifierActuallySkipped: boolean;
  /** §19: the persisted evidence carries ForgeVerify's own `elapsedMs` — a real, durable,
   * historical verifier-duration signal that already exists today. */
  historicalElapsedMsFromPersistedEvidence: number[];
  freshControlElapsedMs: number[];
  passed: boolean;
  failureReasons: string[];
}

async function registerSession(persistence: ISessionPersistence, sessionId: string): Promise<void> {
  const ts = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "fg12e-restart-bench", createdAt: ts, updatedAt: ts, status: "running" });
}

async function runRestart(kind: RestartBenchResult["id"], repoRoot: string, repetitions: number): Promise<RestartBenchResult> {
  const v = benchVerifiers(repoRoot);
  const expensive: Verifier = toVerifier(v.typecheck!);
  const control = materializeBenchWorkspace();
  const treatment = materializeBenchWorkspace();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg12e-restart-"));
  const dbFile = path.join(dbDir, "sessions.db");
  const sessionId = `fg12e-${kind}`;
  const runId = `fg12e-${kind}-baseline`;
  const failureReasons: string[] = [];
  let persistence2: ISessionPersistence | undefined;
  try {
    // Runtime 1: persist real evidence, then "exit" (close the handle).
    const persistence1 = createSessionPersistence({ dbPath: dbFile });
    await persistence1.init();
    await registerSession(persistence1, sessionId);
    const baselineTimeline = createTimelineObserver(createForgeVerifyPersistenceObserver(persistence1, sessionId));
    const baseline = await produceBaselineEvidence(treatment, [expensive], runId, baselineTimeline.observer);
    await persistence1.close();

    if (kind === "restart-stale-refused") {
      mutateBenchWorkspace(treatment, "src/mod-1.ts", `${readBenchWorkspaceFile(treatment, "src/mod-1.ts")}\n// fg12e restart-stale edit\n`);
    }

    // Runtime 2: fresh persistence instance over the same db file — durable load.
    persistence2 = createSessionPersistence({ dbPath: dbFile });
    await persistence2.init();
    const load = await timed(() => loadForgeVerifyEvidence(persistence2!, sessionId, runId));
    const loaded: readonly GenericVerificationEvidence[] = load.result;
    if (loaded.length !== baseline.evidence.length) failureReasons.push(`expected ${baseline.evidence.length} durable evidence records, loaded ${loaded.length}`);

    const receipts: PairReceipt[] = [];
    let treatmentPersistenceWriteMs = 0;
    let controlPersistenceWriteMs = 0;
    for (let i = 0; i < repetitions; i += 1) {
      const treatmentObserver = createTimelineObserver(createForgeVerifyPersistenceObserver(persistence2, `${sessionId}-t${i}`));
      const controlObserver = createTimelineObserver(createForgeVerifyPersistenceObserver(persistence2, `${sessionId}-c${i}`));
      await registerSession(persistence2, `${sessionId}-t${i}`);
      await registerSession(persistence2, `${sessionId}-c${i}`);
      const receipt = await runPair({
        pairIndex: i,
        scored: i > 0,
        warm: i > 0 ? "warm" : "cold",
        order: alternatingOrder(i),
        workloadId: kind,
        expectedTier: "EXPENSIVE",
        controlWorkspace: control,
        treatmentWorkspace: treatment,
        planVerifiers: [expensive],
        priorEvidence: loaded,
        expectedReusedVerifierIds: kind === "restart-valid-reuse" ? [expensive.id] : [],
        controlObserver: controlObserver.observer,
        treatmentObserver: treatmentObserver.observer,
      });
      treatmentPersistenceWriteMs += treatmentObserver.timeline.downstreamObserverMs;
      controlPersistenceWriteMs += controlObserver.timeline.downstreamObserverMs;
      receipts.push(receipt);
      if (!receipt.safety.passed) failureReasons.push(`pair ${i}: ${receipt.safety.failureReasons.join("; ")}`);
    }
    await persistence2.close();
    persistence2 = undefined;

    const scored = receipts.filter((r) => r.scored);
    const expensiveVerifierActuallySkipped = kind === "restart-valid-reuse" ? scored.every((r) => r.treatment.freshAttempts === 0 && r.actualVerifierExecutionsAvoided === 1) : scored.every((r) => r.treatment.freshAttempts === 1 && r.actualVerifierExecutionsAvoided === 0);
    if (!expensiveVerifierActuallySkipped) failureReasons.push(kind === "restart-valid-reuse" ? "expected the expensive verifier to be genuinely skipped after restart" : "expected the expensive verifier to run fresh after a real post-persist mutation");

    return {
      id: kind,
      durableEvidenceLoadMs: load.ms,
      loadedEvidenceCount: loaded.length,
      baselinePersistenceWriteMs: round(baselineTimeline.timeline.downstreamObserverMs),
      treatmentPersistenceWriteMs: round(treatmentPersistenceWriteMs / Math.max(1, repetitions)),
      controlPersistenceWriteMs: round(controlPersistenceWriteMs / Math.max(1, repetitions)),
      receipts,
      expensiveVerifierActuallySkipped,
      historicalElapsedMsFromPersistedEvidence: loaded.map((e) => Number((e as { elapsedMs?: number }).elapsedMs ?? Number.NaN)),
      freshControlElapsedMs: receipts.map((r) => r.control.verifierExecutionMs),
      passed: failureReasons.length === 0,
      failureReasons,
    };
  } finally {
    if (persistence2) await persistence2.close().catch(() => undefined);
    disposeBenchWorkspace(control);
    disposeBenchWorkspace(treatment);
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

export async function runRestartBenchmarks(repoRoot: string, repetitions = 4): Promise<RestartBenchResult[]> {
  return [await runRestart("restart-valid-reuse", repoRoot, repetitions), await runRestart("restart-stale-refused", repoRoot, repetitions)];
}

export interface FallbackBenchResult {
  id: "fallback-advisor-throws";
  receipts: PairReceipt[];
  /** Every scored treatment recorded a fallbackReason and executed the expensive verifier fresh. */
  freshVerificationAlwaysExecuted: boolean;
  fallbackReasons: string[];
  passed: boolean;
  failureReasons: string[];
}

/** Advisor failure during an expensive verification (spec §24): the prior evidence throws on any
 * property access, the wrapper swallows the advisory failure, and fresh verification runs. The
 * pair's `reuseCheckMs` is then the added fallback overhead. */
export async function runFallbackBenchmark(repoRoot: string, repetitions = 4): Promise<FallbackBenchResult> {
  const v = benchVerifiers(repoRoot);
  const expensive: Verifier = toVerifier(v.typecheck!);
  const control = materializeBenchWorkspace();
  const treatment = materializeBenchWorkspace();
  const failureReasons: string[] = [];
  try {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("simulated ForgeGreen advisor failure");
        },
      },
    ) as unknown as GenericVerificationEvidence;
    const receipts: PairReceipt[] = [];
    for (let i = 0; i < repetitions; i += 1) {
      const receipt = await runPair({
        pairIndex: i,
        scored: i > 0,
        warm: i > 0 ? "warm" : "cold",
        order: alternatingOrder(i),
        workloadId: "fallback-advisor-throws",
        expectedTier: "EXPENSIVE",
        controlWorkspace: control,
        treatmentWorkspace: treatment,
        planVerifiers: [expensive],
        priorEvidence: [throwing],
        expectedReusedVerifierIds: [],
      });
      receipts.push(receipt);
      if (!receipt.safety.passed) failureReasons.push(`pair ${i}: ${receipt.safety.failureReasons.join("; ")}`);
    }
    const scored = receipts.filter((r) => r.scored);
    const freshVerificationAlwaysExecuted = scored.every((r) => r.treatment.freshAttempts === 1 && r.treatment.fallbackReason !== undefined && r.treatment.overallStatus === "passed");
    if (!freshVerificationAlwaysExecuted) failureReasons.push("expected every treatment to record a fallbackReason and run the expensive verifier fresh");
    return { id: "fallback-advisor-throws", receipts, freshVerificationAlwaysExecuted, fallbackReasons: receipts.map((r) => r.treatment.fallbackReason ?? ""), passed: failureReasons.length === 0, failureReasons };
  } finally {
    disposeBenchWorkspace(control);
    disposeBenchWorkspace(treatment);
  }
}

