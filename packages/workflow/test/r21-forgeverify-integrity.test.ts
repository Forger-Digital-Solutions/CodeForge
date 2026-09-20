import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeVerificationEvidenceHash,
  createVerificationInputStateHash,
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  isEvidenceCurrentlyValid,
  summarizeVerification,
  verifyVerificationEvidenceIntegrity,
  VerificationEvidenceStore,
  type VerificationEvidence,
  type VerifierDefinition,
  type VerifierId,
  type VerificationPolicyVersion,
  type VerifierVersion,
} from "../src/forge-verify.js";
import { narrowToStrictEvidence } from "../src/verification-evidence-reuse.js";
import { adviseCostGatedReuse } from "../src/verification-reuse-cost-gate.js";
import { evaluateCompletion } from "../src/completion-gate.js";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";
import { recordR21Evidence } from "./r21-evidence.js";

/**
 * R21 ForgeVerify evidence integrity. Every stored evidence record carries `evidenceHash`, a
 * digest of its own content. These tests prove that a record whose content was altered after
 * creation — a status flipped from failed to passed, a state hash rewritten to the current
 * workspace, an exit code rewritten — is rejected by every consumer that could otherwise turn
 * it into completion authority: the canonical validity rule, the plan summary, the reuse
 * boundary inside `executeVerificationPlan`, the strict narrowing used by ForgeGreen's
 * advisors, and the cost-gated advisor itself.
 */

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r21-fv-integrity-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.js"), "module.exports = { ok: () => 1 };\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function definition(id: string, script: string, requirement: VerifierDefinition["defaultRequirement"] = "required"): VerifierDefinition {
  return {
    id: id as VerifierId,
    version: "1" as VerifierVersion,
    name: id,
    category: "unit-test",
    description: "r21 integrity fixture",
    execution: { executable: process.execPath, args: ["-e", script] },
    defaultRequirement: requirement,
    timeoutMs: 15_000,
    maxAttempts: 1,
    supportedScopes: ["workspace"],
  };
}

function planFor(dir: string, definitions: VerifierDefinition[]) {
  const registry = createVerifierRegistry(definitions);
  const plan = createVerificationPlan(registry, { version: "r21-v1" as VerificationPolicyVersion, requiredVerifierIds: definitions.map((definition) => definition.id) }, { runId: "r21-integrity", workspacePath: dir, scope: "workspace" });
  return { registry, plan };
}

async function produce(dir: string, definitions: VerifierDefinition[]): Promise<VerificationEvidence[]> {
  const { registry, plan } = planFor(dir, definitions);
  const result = await executeVerificationPlan(registry, plan, new VerificationEvidenceStore());
  return [...result.evidence];
}

/** Round-trips a record through JSON exactly like session persistence does (undefined dropped). */
function persistedCopy<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

describe("R21 ForgeVerify evidence integrity — the hash is verified, not just present", () => {
  it("a genuine record verifies, including after a persistence-style JSON round trip", async () => {
    const dir = fixture();
    const [evidence] = await produce(dir, [definition("r21.int.pass", "console.log('2 passed'); process.exit(0)")]);
    expect(evidence!.status).toBe("passed");
    expect(verifyVerificationEvidenceIntegrity(evidence)).toBe(true);
    expect(verifyVerificationEvidenceIntegrity(persistedCopy(evidence))).toBe(true);
    expect(computeVerificationEvidenceHash(persistedCopy(evidence))).toBe(evidence!.evidenceHash);
    recordR21Evidence("forgeverify-integrity", { case: "genuine_round_trip", verified: true });
  });

  it("a failed record with its status flipped to passed is rejected everywhere it could count", async () => {
    const dir = fixture();
    const definitions = [definition("r21.int.flip", "console.log('1 failed'); process.exit(1)")];
    const { registry, plan } = planFor(dir, definitions);
    const [genuine] = await produce(dir, definitions);
    expect(genuine!.status).toBe("failed");

    // The forgery: same record, status and exit code rewritten to look like a pass. The current
    // workspace state has not changed, so its inputStateHash is already the live one.
    const forged = persistedCopy({ ...genuine!, status: "passed" as const, exitCode: 0 });
    expect(forged.inputStateHash).toBe(createVerificationInputStateHash(dir));

    // 1. The pure integrity rule and the canonical validity rule.
    expect(verifyVerificationEvidenceIntegrity(forged)).toBe(false);
    expect(isEvidenceCurrentlyValid(forged, { workspacePath: plan.workspacePath, inputStateHash: plan.inputStateHash, definitionDigest: plan.verifiers[0]!.definitionDigest })).toBe(false);

    // 2. The plan summary: the forged record cannot satisfy the obligation.
    const summary = summarizeVerification(plan, registry, [forged]);
    expect(summary.verificationComplete).toBe(false);
    expect(summary.reasons).toContain("integrity_failed");
    expect(summary.integrityRejectedEvidenceIds).toEqual([forged.evidenceId]);

    // 3. The strict narrowing every ForgeGreen advisor goes through.
    expect(narrowToStrictEvidence(forged as unknown as GenericVerificationEvidence)).toBeUndefined();

    // 4. The cost-gated advisor under ACTIVE_SAFE: nothing to propose.
    const advice = adviseCostGatedReuse({ plan, priorEvidence: [forged as unknown as GenericVerificationEvidence] });
    expect(advice.reusableEvidence).toEqual([]);
    expect(advice.receipt.entries[0]!.validityResult).toBe("no_prior_evidence");

    // 5. The authoritative reuse boundary: the verifier is executed fresh and fails for real.
    const fresh = await executeVerificationPlan(registry, plan, new VerificationEvidenceStore(), { existingEvidence: [forged] });
    expect(fresh.evidence).toHaveLength(1);
    expect(fresh.evidence[0]!.evidenceId).not.toBe(forged.evidenceId);
    expect(fresh.evidence[0]!.status).toBe("failed");
    expect(fresh.summary.verificationComplete).toBe(false);

    // 6. The completion gate, handed the forged evidence as if it were the report.
    const decision = evaluateCompletion({
      plan: { id: "p", title: "t", taskId: "r21-integrity", status: "completed", createdAt: "", updatedAt: "", steps: [{ id: "s", description: "edit", status: "completed", kind: "edit", risk: "safe", requiresApproval: false, targetPath: "a.js" }] },
      verification: { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "", exitCode: 0, command: "node", failures: [], verifiers: [], requiredPassed: true, hasFailures: false, advisories: [], overallStatus: "passed", summary: "", forgeVerify: { plan, attempts: [], evidence: [forged], summary } } as never,
      analysis: { hasFailures: false, summary: "", diagnostics: [], suggestedRepairs: [], isRepairable: false },
      review: { approved: true, issues: [], findings: [], diffs: [{ path: "a.js", changeType: "modified", additions: 1, deletions: 0, diff: "+x", beforeHash: "a", afterHash: "b" }], summary: "1 file" },
    });
    expect(decision.outcome).not.toBe("completed");
    expect(decision.blockers.some((blocker) => blocker.code === "verification_not_run" || blocker.code === "verification_not_current")).toBe(true);
    recordR21Evidence("forgeverify-integrity", { case: "status_flip_forgery", rejectedAt: ["integrity", "validity", "summary", "narrowing", "advisor", "reuse_boundary", "completion_gate"], falseCompletion: false });
  });

  it("a passed record whose state hash was rewritten to the live workspace is rejected", async () => {
    const dir = fixture();
    const definitions = [definition("r21.int.rehash", "process.exit(0)")];
    const [genuine] = await produce(dir, definitions);
    expect(genuine!.status).toBe("passed");
    // The work changes; the attacker rewrites the old pass to the new state instead of re-running.
    fs.writeFileSync(path.join(dir, "a.js"), "module.exports = { ok: () => { throw new Error('broken'); } };\n");
    const { registry, plan } = planFor(dir, definitions);
    const forged = persistedCopy({ ...genuine!, inputStateHash: plan.inputStateHash });
    expect(verifyVerificationEvidenceIntegrity(forged)).toBe(false);
    const summary = summarizeVerification(plan, registry, [forged]);
    expect(summary.verificationComplete).toBe(false);
    const reuse = await executeVerificationPlan(registry, plan, new VerificationEvidenceStore(), { existingEvidence: [forged] });
    expect(reuse.evidence[0]!.evidenceId).not.toBe(forged.evidenceId);
    recordR21Evidence("forgeverify-integrity", { case: "state_hash_rewrite", reused: false, falseCompletion: false });
  });

  it("every hashed field is covered: any single-field mutation invalidates the record", async () => {
    const dir = fixture();
    const [genuine] = await produce(dir, [definition("r21.int.fields", "process.exit(0)")]);
    const mutations: Array<[keyof VerificationEvidence, unknown]> = [
      ["evidenceId", "forged-id"], ["attemptId", "forged-attempt"], ["planId", "forged-plan"], ["verifierId", "other.verifier"],
      ["verifierVersion", "2"], ["definitionDigest", "0".repeat(64)], ["runId", "other-run"], ["workspacePath", "/elsewhere"],
      ["inputStateHash", "0".repeat(64)], ["status", "failed"], ["exitCode", 1], ["elapsedMs", 999_999], ["commandDigest", "0".repeat(64)],
      ["outputDigest", "0".repeat(64)], ["outputExcerpt", "ALL TESTS PASSED"], ["outputTruncated", true], ["outputBytes", 1], ["createdAt", "2020-01-01T00:00:00.000Z"],
    ];
    const results: Record<string, boolean> = {};
    for (const [field, value] of mutations) {
      const mutated = persistedCopy({ ...genuine!, [field]: value }) as VerificationEvidence;
      results[field] = verifyVerificationEvidenceIntegrity(mutated);
      expect(results[field], `mutating ${field} must invalidate the record`).toBe(false);
    }
    expect(verifyVerificationEvidenceIntegrity(persistedCopy(genuine))).toBe(true);
    recordR21Evidence("forgeverify-integrity", { case: "single_field_mutations", fieldsCovered: mutations.length, allRejected: Object.values(results).every((verified) => verified === false) });
  });

  it("malformed and corrupted records never pass: wrong types, missing hash, truncated hash, non-object", async () => {
    const dir = fixture();
    const [genuine] = await produce(dir, [definition("r21.int.shape", "process.exit(0)")]);
    const corrupt: unknown[] = [
      null, undefined, "passed", 42, [],
      { ...genuine!, evidenceHash: undefined },
      { ...genuine!, evidenceHash: genuine!.evidenceHash.slice(0, 63) },
      { ...genuine!, evidenceHash: genuine!.evidenceHash.toUpperCase() },
      { ...genuine!, elapsedMs: "12" },
      { ...genuine!, outputTruncated: "false" },
      { ...genuine!, exitCode: "0" },
      { ...genuine!, status: undefined },
    ];
    for (const record of corrupt) expect(verifyVerificationEvidenceIntegrity(record)).toBe(false);
    recordR21Evidence("forgeverify-integrity", { case: "malformed_records", variants: corrupt.length, allRejected: true });
  });

  it("output containing secret-shaped text is redacted before hashing, so the persisted record still verifies", async () => {
    const dir = fixture();
    // The verifier prints a credential-shaped line. ForgeVerify redacts before hashing; session
    // persistence redacts again with the same redactor — the stored bytes equal the hashed bytes.
    const [evidence] = await produce(dir, [definition("r21.int.redact", "console.log('password: hunter2secret'); console.log('Bearer abcdefghijklmnop.qrstuvwxyz'); console.log('3 passed'); process.exit(0)")]);
    expect(evidence!.outputExcerpt).not.toContain("hunter2secret");
    expect(evidence!.outputExcerpt).not.toContain("abcdefghijklmnop.qrstuvwxyz");
    expect(evidence!.outputExcerpt).toContain("[REDACTED]");
    expect(verifyVerificationEvidenceIntegrity(persistedCopy(evidence))).toBe(true);
    recordR21Evidence("forgeverify-integrity", { case: "redaction_alignment", secretsInExcerpt: false, verifiesAfterRoundTrip: true });
  });

  it("a legitimately re-minted record (re-hashed after a change) is internally consistent but still bound to its own identity", async () => {
    const dir = fixture();
    const definitions = [definition("r21.int.remint", "process.exit(1)")];
    const { registry, plan } = planFor(dir, definitions);
    const [genuine] = await produce(dir, definitions);
    // A forger who knows the algorithm can re-mint a hash over a flipped status. This documents
    // the boundary of an unkeyed content hash: it defeats corruption and naive tampering, not a
    // forger with code access. Such a record verifies internally...
    const { evidenceHash: _old, ...rest } = { ...genuine!, status: "passed" as const, exitCode: 0 };
    const reminted = { ...rest, evidenceHash: computeVerificationEvidenceHash(rest) } as VerificationEvidence;
    expect(verifyVerificationEvidenceIntegrity(reminted)).toBe(true);
    // ...which is exactly why the storage layer refuses to overwrite terminal records (see the
    // sessions R21 immutability suite) and why the gate rebinds evidence to live workspace state.
    // Here the workspace still matches, so the summary would accept it: the residual risk is
    // recorded honestly rather than hidden.
    const summary = summarizeVerification(plan, registry, [reminted]);
    recordR21Evidence("forgeverify-integrity", {
      case: "reminted_forgery_boundary",
      internallyConsistent: true,
      acceptedBySummaryWhenWorkspaceUnchanged: summary.verificationComplete,
      mitigation: "storage-layer immutability trigger (sessions migration 4 / SQLite trigger) + unkeyed hash; keyed signature is a recorded follow-up",
    });
    expect(summary.verificationComplete).toBe(true);
  });
});
