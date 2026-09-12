import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { adviseCostGatedReuse, reconcileCostGateReceipt } from "../src/verification-reuse-cost-gate.js";
import {
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  VerificationEvidenceStore,
  type VerificationEvidence,
  type VerifierDefinition,
  type VerifierId,
  type VerificationPolicyVersion,
  type VerifierVersion,
} from "../src/forge-verify.js";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg12f-advisor-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.js"), "function ok() { return 1; }\nmodule.exports = { ok };\n");
  fs.writeFileSync(path.join(dir, "b.js"), "function heavy() { return 2; }\nmodule.exports = { heavy };\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function syntaxVerifier(id: string, relFile: string): VerifierDefinition {
  return {
    id: id as VerifierId,
    version: "1" as VerifierVersion,
    name: `syntax:${relFile}`,
    category: "lint",
    description: "test",
    execution: { executable: process.execPath, args: ["--check", relFile] },
    defaultRequirement: "required",
    timeoutMs: 15_000,
    maxAttempts: 1,
    supportedScopes: ["workspace"],
  };
}

function planFor(dir: string, definitions: VerifierDefinition[]) {
  const registry = createVerifierRegistry(definitions);
  const plan = createVerificationPlan(registry, { version: "v1" as VerificationPolicyVersion, requiredVerifierIds: definitions.map((definition) => definition.id) }, { runId: "fg12f-check", workspacePath: dir, scope: "workspace" });
  return { registry, plan };
}

async function produceRealEvidence(dir: string, definitions: VerifierDefinition[]): Promise<VerificationEvidence[]> {
  const { registry, plan } = planFor(dir, definitions);
  const store = new VerificationEvidenceStore();
  const result = await executeVerificationPlan(registry, plan, store);
  return [...result.evidence];
}

describe("FG-12F adviseCostGatedReuse — validity before cost, unknown cost fails closed (spec §6/§13)", () => {
  it("valid evidence with no trusted duration history stays fresh (unknown_cost)", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.advisor.unknown", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: undefined } as unknown as GenericVerificationEvidence] });
    expect(advice.reusableEvidence).toEqual([]);
    const entry = advice.receipt.entries[0]!;
    expect(entry.validityResult).toBe("valid");
    expect(entry.costRejectionReason).toBe("unknown_cost");
    expect(entry.costHistorySource).toBe("unavailable");
    expect(entry.outcome).toBe("rejected_by_cost");
    expect(advice.receipt.counts.rejectedByCost).toBe(1);
    expect(advice.receipt.decision?.status).toBe("REJECTED");
  });

  it("cost is never consulted for invalid evidence — validity is decided first (spec §13/§14)", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.advisor.invalid", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    fs.writeFileSync(path.join(dir, "a.js"), "function ok() { return 42; }\nmodule.exports = { ok };\n");
    const { plan } = planFor(dir, definitions);
    // Even an absurdly expensive history cannot rescue evidence ForgeVerify holds invalid.
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: 60_000 } as unknown as GenericVerificationEvidence] });
    expect(advice.reusableEvidence).toEqual([]);
    const entry = advice.receipt.entries[0]!;
    expect(entry.validityResult).toBe("invalid");
    expect(entry.costEligible).toBe(false);
    expect(entry.outcome).toBe("rejected_by_validity");
    expect(advice.receipt.counts.rejectedByValidity).toBe(1);
  });

  it("evidence absent for a planned verifier records no_prior_evidence and runs fresh", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.advisor.cold", "a.js")];
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [] });
    expect(advice.reusableEvidence).toEqual([]);
    expect(advice.receipt.entries[0]!.validityResult).toBe("no_prior_evidence");
    expect(advice.receipt.entries[0]!.outcome).toBe("fresh_executed");
    expect(advice.receipt.decision?.status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
  });
});

describe("FG-12F adviseCostGatedReuse — threshold boundary through the advisor (spec §24)", () => {
  async function advisorOutcomeForElapsed(dir: string, id: string, elapsedMs: number) {
    const definitions = [syntaxVerifier(id, "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    return adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs } as unknown as GenericVerificationEvidence] });
  }

  it("249 ms stays fresh; exactly 250 ms is eligible; 251 ms is eligible", async () => {
    const below = await advisorOutcomeForElapsed(fixture(), "fg12f.boundary.below", 249);
    expect(below.reusableEvidence).toEqual([]);
    expect(below.receipt.entries[0]!.costRejectionReason).toBe("below_threshold");

    const exact = await advisorOutcomeForElapsed(fixture(), "fg12f.boundary.exact", 250);
    expect(exact.reusableEvidence.length).toBe(1);
    expect(exact.receipt.entries[0]!.costEligible).toBe(true);
    expect(exact.receipt.configuredThresholdMs).toBe(250);

    const above = await advisorOutcomeForElapsed(fixture(), "fg12f.boundary.above", 251);
    expect(above.reusableEvidence.length).toBe(1);
  });

  it("a cost-eligible proposal under ACTIVE_SAFE carries the FG-12F receipt identity", async () => {
    const above = await advisorOutcomeForElapsed(fixture(), "fg12f.receipt.identity", 900);
    expect(above.receipt.receiptSchemaVersion).toBe("fg12f-cost-gate-receipt-1");
    expect(above.receipt.costPolicyVersion).toBe("fg12f-verification-reuse-cost-gated-1");
    expect(above.receipt.executionState).toBe("ACTIVE_SAFE_COST_GATED");
    expect(above.receipt.entries[0]!.priorElapsedMs).toBe(900);
    expect(above.receipt.entries[0]!.estimatedFreshMs).toBe(900);
    expect(above.receipt.entries[0]!.costConfidence).toBe("SINGLE_SAMPLE");
    expect(above.receipt.decision?.status).toBe("APPLIED");
  });
});

describe("FG-12F partial reuse — per-verifier evaluation, never whole-plan (spec §15)", () => {
  it("one plan with a cheap and an expensive verifier: expensive proposed, cheap held fresh", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.partial.cheap", "a.js"), syntaxVerifier("fg12f.partial.expensive", "b.js")];
    const evidence = await produceRealEvidence(dir, definitions);
    const cheap = evidence.find((item) => item.verifierId === "fg12f.partial.cheap")!;
    const expensive = evidence.find((item) => item.verifierId === "fg12f.partial.expensive")!;
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({
      plan,
      priorEvidence: [
        { ...cheap, elapsedMs: 80 } as unknown as GenericVerificationEvidence,
        { ...expensive, elapsedMs: 2_500 } as unknown as GenericVerificationEvidence,
      ],
    });
    expect(advice.reusableEvidence.map((item) => item.verifierId)).toEqual(["fg12f.partial.expensive"]);
    const cheapEntry = advice.receipt.entries.find((entry) => entry.verifierId === "fg12f.partial.cheap")!;
    const expensiveEntry = advice.receipt.entries.find((entry) => entry.verifierId === "fg12f.partial.expensive")!;
    expect(cheapEntry.outcome).toBe("rejected_by_cost");
    expect(cheapEntry.estimatedFreshMs).toBe(80);
    expect(expensiveEntry.outcome).toBe("reused");
    expect(expensiveEntry.referencePreventedTimeMs).toBeUndefined();
    expect(advice.receipt.counts.proposed).toBe(1);
    expect(advice.receipt.counts.rejectedByCost).toBe(1);
  });
});

describe("FG-12F policy states and failure fallback (spec §10/§27)", () => {
  it("SHADOW ceiling: proposals recorded for observability, execution untouched", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.shadow.observe", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "SHADOW";
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: 900 } as unknown as GenericVerificationEvidence] });
    expect(advice.receipt.executionState).toBe("SHADOW_OBSERVING");
    expect(advice.reusableEvidence).toEqual([]);
    expect(advice.receipt.entries[0]!.costEligible).toBe(true);
    expect(advice.receipt.entries[0]!.outcome).toBe("observed_only");
    expect(advice.receipt.decision?.status).toBe("PROPOSED");
  });

  it("OFF: the advisor disables immediately with no proposals and no decision (spec §10)", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.off.disabled", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "OFF";
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: 900 } as unknown as GenericVerificationEvidence] });
    expect(advice.receipt.executionState).toBe("DISABLED_OFF");
    expect(advice.reusableEvidence).toEqual([]);
    expect(advice.receipt.decision).toBeUndefined();
  });

  it("an advisor-internal failure degrades to a fallback receipt with an empty reusable set (spec §27)", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.fallback.throwing", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    const hostileEvidence = { ...evidence, elapsedMs: 900 };
    Object.defineProperty(hostileEvidence, "verifierId", { get() { throw new Error("synthetic advisor failure"); } });
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [hostileEvidence as unknown as GenericVerificationEvidence] });
    expect(advice.reusableEvidence).toEqual([]);
    expect(advice.receipt.fallbackReason).toContain("synthetic advisor failure");
    expect(advice.receipt.entries).toEqual([]);
  });
});

describe("FG-12F reconcileCostGateReceipt — actual reuse truth comes only from reusedEvidenceId (spec §16)", () => {
  it("a proposal the authoritative boundary accepted records reuse with its reference prevented time", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.reconcile.accepted", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: 1_200 } as unknown as GenericVerificationEvidence] });
    const receipt = reconcileCostGateReceipt(
      advice.receipt,
      new Map([["fg12f.reconcile.accepted", { reusedEvidenceId: evidence.evidenceId, status: "passed", durationMs: 0 }]]),
      new Map([["fg12f.reconcile.accepted", evidence.elapsedMs]]),
    );
    expect(receipt.entries[0]!.outcome).toBe("reused");
    expect(receipt.entries[0]!.actualReusedEvidenceId).toBe(evidence.evidenceId);
    expect(receipt.entries[0]!.actualFreshElapsedMs).toBeUndefined();
    expect(receipt.entries[0]!.referencePreventedTimeMs).toBe(1_200);
    expect(receipt.counts.actuallyReused).toBe(1);
  });

  it("a proposal the authoritative boundary declined (e.g. TOCTOU) is recorded as rejected_by_final_authoritative_boundary, never as reuse", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.reconcile.declined", "a.js")];
    const evidence = (await produceRealEvidence(dir, definitions))[0]!;
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [{ ...evidence, elapsedMs: 1_200 } as unknown as GenericVerificationEvidence] });
    const receipt = reconcileCostGateReceipt(
      advice.receipt,
      new Map([["fg12f.reconcile.declined", { status: "passed", durationMs: 950 }]]),
      new Map([["fg12f.reconcile.declined", 950]]),
    );
    expect(receipt.entries[0]!.outcome).toBe("rejected_by_final_authoritative_boundary");
    expect(receipt.entries[0]!.actualFreshElapsedMs).toBe(950);
    expect(receipt.counts.rejectedByFinalAuthoritativeBoundary).toBe(1);
    expect(receipt.counts.actuallyReused).toBe(0);
  });

  it("fresh executions record their real status and duration for future cost decisions (spec §18)", async () => {
    const dir = fixture();
    const definitions = [syntaxVerifier("fg12f.reconcile.fresh", "a.js")];
    const { plan } = planFor(dir, definitions);
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [] });
    const receipt = reconcileCostGateReceipt(
      advice.receipt,
      new Map([["fg12f.reconcile.fresh", { status: "passed", durationMs: 613 }]]),
      new Map([["fg12f.reconcile.fresh", 613]]),
    );
    expect(receipt.entries[0]!.outcome).toBe("fresh_executed");
    expect(receipt.entries[0]!.freshExecutionStatus).toBe("passed");
    expect(receipt.entries[0]!.actualFreshElapsedMs).toBe(613);
    expect(receipt.counts.freshlyExecuted).toBe(1);
  });
});
