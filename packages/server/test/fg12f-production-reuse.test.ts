import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence, type WorkItem } from "@codeforge/sessions";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { createForgeVerifyPersistenceObserver, loadForgeVerifyEvidence } from "../src/forge-verify-persistence.js";
import { runVerification, type VerificationReport } from "@codeforge/workflow";

/**
 * FG-12F production-composition corpus (spec §20–§28): every case runs the REAL production seam —
 * `runVerification` → cost-gated reuse advisor → ForgeVerify authoritative execution — with the
 * REAL persistence-backed observer over a real SQLite session store. No harness bypasses.
 */

const cleanupDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
});

/** The verifier's execution leaves a marker OUTSIDE the workspace (a sibling of it) so hashing is
 * unaffected; counting markers is a deterministic child-process-was-not-spawned proof. */
function makeWorkspace(): { root: string; ws: string; executionLog: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fg12f-prod-"));
  cleanupDirs.push(parent);
  const ws = path.join(parent, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 1; }\nmodule.exports = { ok };\n");
  fs.writeFileSync(
    path.join(ws, "sleeper.js"),
    // The marker log lives OUTSIDE the workspace (a sibling of it) so the input-state hash is
    // unaffected; the script derives the path itself to avoid any shell-quoting variance.
    `const fs = require("node:fs");\nconst path = require("node:path");\nfs.appendFileSync(path.join(__dirname, "..", "executions.log"), "run\\n");\nsetTimeout(() => process.exit(0), 350);\n`,
  );
  const executionLog = path.join(parent, "executions.log");
  fs.writeFileSync(executionLog, "");
  return { root: parent, ws, executionLog };
}

const SLEEPER: import("@codeforge/workflow").Verifier = { id: "sleeper", kind: "custom", command: "node sleeper.js", required: true, source: "configured" };
const SYNTAX_A: import("@codeforge/workflow").Verifier = { id: "syntax-a", kind: "custom", command: "node --check a.js", required: true, source: "configured" };

async function makePersistence(tag: string): Promise<{ persistence: ISessionPersistence; dbFile: string; sessionId: string }> {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `fg12f-db-${tag}-`)), "sessions.db");
  cleanupDirs.push(path.dirname(dbFile));
  const persistence = createSessionPersistence({ dbPath: dbFile });
  await persistence.init();
  const sessionId = `fg12f-prod-${tag}-${Date.now()}`;
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "fg12f-production-session", createdAt: now, updatedAt: now, status: "running" });
  cleanups.push(() => persistence.close());
  return { persistence, dbFile, sessionId };
}

/** The sleeper verifier command is argument-free; its marker path is derived inside the script. */
function sleeperCommand(): import("@codeforge/workflow").Verifier {
  return { ...SLEEPER };
}

function runCount(executionLog: string): number {
  return fs.readFileSync(executionLog, "utf-8").split("\n").filter(Boolean).length;
}

function costGateOf(report: VerificationReport) {
  const receipt = report.costGateReceipt;
  expect(receipt, "expected a cost-gate receipt on the report").toBeDefined();
  return receipt!;
}

describe("FG-12F cold start and natural cost learning through the production seam (spec §19/§23)", () => {
  it("first invocation runs fresh and persists its real duration; the second becomes cost-eligible and reuses without spawning a child process", async () => {
    const { ws, executionLog } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("cold");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = sleeperCommand();

    const first = await runVerification(ws, [verifier], { observer, runId: "cold-1" });
    expect(first.overallStatus).toBe("passed");
    expect(first.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(first.verifiers[0]!.durationMs).toBeGreaterThan(0);
    expect(runCount(executionLog)).toBe(1);
    const firstEvidence = (await loadForgeVerifyEvidence(persistence, sessionId)).find((item) => item.status === "passed");
    expect(firstEvidence?.elapsedMs).toBeGreaterThanOrEqual(250);

    const second = await runVerification(ws, [verifier], { observer, runId: "cold-2" });
    expect(second.verifiers[0]!.reusedEvidenceId).toBe(firstEvidence!.evidenceId);
    expect(second.verifiers[0]!.durationMs).toBe(0);
    expect(runCount(executionLog)).toBe(1);
    const receipt = costGateOf(second);
    expect(receipt.executionState).toBe("ACTIVE_SAFE_COST_GATED");
    expect(receipt.counts.actuallyReused).toBe(1);
    expect(receipt.entries[0]!.priorElapsedMs).toBe(firstEvidence!.elapsedMs);
    expect(receipt.entries[0]!.actualReusedEvidenceId).toBe(firstEvidence!.evidenceId);
  }, 30_000);
});

/** Seeds a dedicated session holding crafted duration samples: clones of real, still-valid
 * evidence records with controlled elapsedMs values. Everything else about each record — hashes,
 * digests, workspace — is the real production value, so the only variable under test is the cost
 * history. This keeps threshold-class assertions deterministic regardless of machine load. */
async function craftEvidenceSession(
  tag: string,
  bases: Array<{ evidence: Record<string, unknown>; elapsedMs?: number }>,
): Promise<{ persistence: ISessionPersistence; sessionId: string }> {
  const target = await makePersistence(tag);
  const now = new Date().toISOString();
  for (const [index, base] of bases.entries()) {
    const payload = base.elapsedMs === undefined ? base.evidence : { ...base.evidence, elapsedMs: base.elapsedMs };
    await target.persistence.insertImmutableWorkItem({
      kind: "verification",
      id: `crafted-${tag}-${index}`,
      sessionId: target.sessionId,
      runId: "crafted",
      recordType: "evidence",
      planId: String(base.evidence.planId),
      payload: payload as unknown as Record<string, unknown>,
      status: "passed",
      createdAt: now,
      updatedAt: now,
    } as unknown as WorkItem);
  }
  return { persistence: target.persistence, sessionId: target.sessionId };
}

describe("FG-12F cheap verifiers stay fresh under the production threshold (spec §20)", () => {
  it("a sub-150 ms syntax verifier with perfectly valid prior evidence is cost-rejected and runs fresh", async () => {
    const { ws } = makeWorkspace();
    const seed = await makePersistence("cheap-seed");
    const first = await runVerification(ws, [SYNTAX_A], { observer: createForgeVerifyPersistenceObserver(seed.persistence, seed.sessionId), runId: "cheap-1" });
    expect(first.overallStatus).toBe("passed");
    const base = first.forgeVerify!.evidence[0]!;
    await seed.persistence.close();

    // Controlled 90 ms history (FG-12E measured the syntax class at ~81 ms) — deterministic
    // under any machine load, unlike re-reading run 1's real duration.
    const crafted = await craftEvidenceSession("cheap", [{ evidence: base as unknown as Record<string, unknown>, elapsedMs: 90 }]);
    const observer = createForgeVerifyPersistenceObserver(crafted.persistence, crafted.sessionId);

    const second = await runVerification(ws, [SYNTAX_A], { observer, runId: "cheap-2" });
    expect(second.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(second.verifiers[0]!.durationMs).toBeGreaterThan(0);
    const receipt = costGateOf(second);
    expect(receipt.entries[0]!.validityResult).toBe("valid");
    expect(receipt.entries[0]!.costRejectionReason).toBe("below_threshold");
    expect(receipt.counts.rejectedByCost).toBe(1);
    expect(receipt.decision?.status).toBe("REJECTED");
  }, 30_000);
});

describe("FG-12F threshold boundary in production composition (spec §24)", () => {
  async function boundaryCase(elapsedMs: number, tag: string): Promise<VerificationReport> {
    const { ws } = makeWorkspace();
    const seed = await makePersistence(`${tag}-seed`);
    const seedObserver = createForgeVerifyPersistenceObserver(seed.persistence, seed.sessionId);
    const first = await runVerification(ws, [SYNTAX_A], { observer: seedObserver, runId: `${tag}-seed` });
    const base = first.forgeVerify!.evidence[0]!;

    const crafted = await craftEvidenceSession(tag, [{ evidence: base as unknown as Record<string, unknown>, elapsedMs }]);
    const observer = createForgeVerifyPersistenceObserver(crafted.persistence, crafted.sessionId);
    return runVerification(ws, [SYNTAX_A], { observer, runId: `${tag}-run` });
  }

  it("a 249 ms history is below the threshold and stays fresh", async () => {
    const report = await boundaryCase(249, "b249");
    expect(report.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(costGateOf(report).entries[0]!.costRejectionReason).toBe("below_threshold");
  }, 30_000);

  it("exactly 250 ms is cost-eligible and reuses (inclusive boundary)", async () => {
    const report = await boundaryCase(250, "b250");
    expect(report.verifiers[0]!.reusedEvidenceId).toBeDefined();
    expect(costGateOf(report).entries[0]!.costEligible).toBe(true);
  }, 30_000);

  it("251 ms is cost-eligible and reuses", async () => {
    const report = await boundaryCase(251, "b251");
    expect(report.verifiers[0]!.reusedEvidenceId).toBeDefined();
  }, 30_000);
});

describe("FG-12F invalidation, kill switch, shadow ceiling, and failure fallback (spec §14/§25/§27)", () => {
  it("a changed workspace invalidates regardless of cost — validity comes first", async () => {
    const { ws, executionLog } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("invalidate");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = sleeperCommand();

    await runVerification(ws, [verifier], { observer, runId: "inv-1" });
    fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 2; }\nmodule.exports = { ok };\n");

    const second = await runVerification(ws, [verifier], { observer, runId: "inv-2" });
    expect(second.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(runCount(executionLog)).toBe(2);
    const receipt = costGateOf(second);
    expect(receipt.entries[0]!.validityResult).toBe("invalid");
    expect(receipt.entries[0]!.costEligible).toBe(false);
    expect(receipt.counts.rejectedByValidity).toBe(1);
  }, 30_000);

  it("CODEFORGE_FORGEGREEN_OPTIMIZATION=OFF disables Candidate D immediately — no receipt, fresh execution", async () => {
    const { ws, executionLog } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("killswitch");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = sleeperCommand();

    await runVerification(ws, [verifier], { observer, runId: "ks-1" });
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "OFF";
    const second = await runVerification(ws, [verifier], { observer, runId: "ks-2" });

    expect(second.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(second.costGateReceipt).toBeUndefined();
    expect(runCount(executionLog)).toBe(2);
  }, 30_000);

  it("SHADOW ceiling: proposals are observed but execution stays fresh", async () => {
    const { ws, executionLog } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("shadow");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = sleeperCommand();

    await runVerification(ws, [verifier], { observer, runId: "sh-1" });
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "SHADOW";
    const second = await runVerification(ws, [verifier], { observer, runId: "sh-2" });

    expect(second.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(runCount(executionLog)).toBe(2);
    const receipt = costGateOf(second);
    expect(receipt.executionState).toBe("SHADOW_OBSERVING");
    expect(receipt.entries[0]!.costEligible).toBe(true);
    expect(receipt.entries[0]!.proposedReuse).toBe(true);
    expect(receipt.entries[0]!.actualReusedEvidenceId).toBeUndefined();
    expect(receipt.decision?.status).toBe("PROPOSED");
  }, 30_000);

  it("a failing duration lookup falls back to fresh verification and never blocks it (spec §27)", async () => {
    const { ws, executionLog } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("fallback");
    const verifier = sleeperCommand();
    const prior = await (async () => {
      const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
      return runVerification(ws, [verifier], { observer, runId: "fb-1" });
    })();
    expect(prior.overallStatus).toBe("passed");

    const throwingObserver = {
      ...createForgeVerifyPersistenceObserver(persistence, sessionId),
      loadPriorEvidence: (): readonly GenericVerificationEvidence[] => {
        throw new Error("synthetic persistence failure");
      },
    };
    const second = await runVerification(ws, [verifier], { observer: throwingObserver, runId: "fb-2" });
    expect(second.overallStatus).toBe("passed");
    expect(second.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(second.costGateReceipt).toBeUndefined();
    expect(runCount(executionLog)).toBe(2);
  }, 30_000);
});

describe("FG-12F restart safety through the production seam (spec §26)", () => {
  it("cost history and evidence reload after a restart; a mutated workspace is refused after restart", async () => {
    const { ws, executionLog } = makeWorkspace();
    const first = await makePersistence("restart");
    const firstObserver = createForgeVerifyPersistenceObserver(first.persistence, first.sessionId);
    const verifier = sleeperCommand();

    await runVerification(ws, [verifier], { observer: firstObserver, runId: "restart-1" });
    await first.persistence.close();

    const second = createSessionPersistence({ dbPath: first.dbFile });
    await second.init();
    cleanups.push(() => second.close());
    const reloaded = await loadForgeVerifyEvidence(second, first.sessionId);
    expect(reloaded.length).toBeGreaterThan(0);
    const secondObserver = createForgeVerifyPersistenceObserver(second, first.sessionId);

    const reuseRun = await runVerification(ws, [verifier], { observer: secondObserver, runId: "restart-2" });
    expect(reuseRun.verifiers[0]!.reusedEvidenceId).toBeDefined();
    expect(runCount(executionLog)).toBe(1);

    fs.writeFileSync(path.join(ws, "a.js"), "function ok() { return 3; }\nmodule.exports = { ok };\n");
    const third = await runVerification(ws, [verifier], { observer: secondObserver, runId: "restart-3" });
    expect(third.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(runCount(executionLog)).toBe(2);
    expect(costGateOf(third).counts.rejectedByValidity).toBe(1);
  }, 40_000);
});

describe("FG-12F partial reuse across a multi-verifier plan (spec §15)", () => {
  it("one plan, two verifiers: the expensive one reuses while the cheap one runs fresh", async () => {
    const { ws, executionLog } = makeWorkspace();
    const seed = await makePersistence("partial-seed");
    const seedObserver = createForgeVerifyPersistenceObserver(seed.persistence, seed.sessionId);

    const first = await runVerification(ws, [SYNTAX_A, sleeperCommand()], { observer: seedObserver, runId: "part-1" });
    expect(runCount(executionLog)).toBe(1);
    const structured = first.forgeVerify!.evidence;
    expect(structured).toHaveLength(2);
    // Plan order runs the cheap verifier first; the second record's real duration is floored by
    // the 350 ms sleep (setTimeout cannot fire early), which self-verifies the identity below.
    const [cheapBase, expensiveBase] = structured as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect((expensiveBase as unknown as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(350);
    await seed.persistence.close();

    // Controlled cost histories: cheap forced to 90 ms, expensive left at its real measured
    // duration (>= the 350 ms sleep, immune to load). One session holds both, exactly like a
    // real session's evidence pool.
    const crafted = await craftEvidenceSession("partial", [
      { evidence: cheapBase as unknown as Record<string, unknown>, elapsedMs: 90 },
      { evidence: expensiveBase as unknown as Record<string, unknown> },
    ]);
    const observer = createForgeVerifyPersistenceObserver(crafted.persistence, crafted.sessionId);

    const second = await runVerification(ws, [SYNTAX_A, sleeperCommand()], { observer, runId: "part-2" });
    const reused = second.verifiers.filter((verifier) => verifier.reusedEvidenceId !== undefined);
    const fresh = second.verifiers.filter((verifier) => verifier.reusedEvidenceId === undefined);
    expect(reused).toHaveLength(1);
    expect(reused[0]!.command).toContain("sleeper.js");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.command).toContain("--check");
    expect(runCount(executionLog)).toBe(1);

    const receipt = costGateOf(second);
    expect(receipt.counts.actuallyReused).toBe(1);
    expect(receipt.counts.rejectedByCost).toBe(1);
    const reusedEntry = receipt.entries.find((entry) => entry.actualReusedEvidenceId !== undefined)!;
    expect(reusedEntry.outcome).toBe("reused");
    expect(reusedEntry.referencePreventedTimeMs).toBeGreaterThanOrEqual(250);
    const cheapEntry = receipt.entries.find((entry) => entry.outcome === "rejected_by_cost")!;
    expect(cheapEntry.estimatedFreshMs!).toBeLessThan(250);
  }, 40_000);
});

describe("FG-12F production receipt accounting (spec §16/§17)", () => {
  it("the reconciled receipt is persisted as an immutable cost_gate_receipt work item", async () => {
    const { ws } = makeWorkspace();
    const { persistence, sessionId } = await makePersistence("receipt");
    const observer = createForgeVerifyPersistenceObserver(persistence, sessionId);
    const verifier = sleeperCommand();

    await runVerification(ws, [verifier], { observer, runId: "rec-1" });
    await runVerification(ws, [verifier], { observer, runId: "rec-2" });

    const items = await persistence.getWorkItems(sessionId);
    const receipts = items.filter((item) => item.kind === "verification" && (item as { recordType?: string }).recordType === "cost_gate_receipt");
    expect(receipts).toHaveLength(1);
    const payload = (receipts[0] as unknown as { payload: { counts: Record<string, number>; entries: Array<{ outcome: string }>; costPolicyVersion: string } }).payload;
    expect(payload.costPolicyVersion).toBe("fg12f-verification-reuse-cost-gated-1");
    expect(payload.counts.actuallyReused).toBe(1);
    expect(payload.entries[0]!.outcome).toBe("reused");
  }, 30_000);
});
