import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  narrowToStrictEvidence,
  requestVerificationEvidenceReuse,
  runVerificationWithControlledReuse,
  type ReuseTrialMode,
} from "../src/verification-evidence-reuse.js";
import { createVerificationPlan, createVerifierRegistry, executeVerificationPlan, VerificationEvidenceStore, type VerificationEvidence, type VerifierDefinition, type VerifierId, type VerifierVersion } from "../src/forge-verify.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg12d-fixture-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.js"), "function ok() { return 1; }\nmodule.exports = { ok };\n");
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

async function produceBaselineEvidence(workspacePath: string, id: string, relFile: string): Promise<VerificationEvidence> {
  const registry = createVerifierRegistry([syntaxVerifier(id, relFile)]);
  const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "baseline", workspacePath, scope: "workspace" });
  const store = new VerificationEvidenceStore();
  const result = await executeVerificationPlan(registry, plan, store);
  return result.evidence[0]!;
}

/** Produces baseline evidence through the exact same legacy-verifier path
 * `runVerificationWithControlledReuse` reconstructs internally, so the resulting evidence's
 * `verifierId` (assigned by `adaptTrustedLegacyVerifiers`, not the caller's `id`) matches what
 * the later plan will look for — mirroring how real persisted evidence is actually produced. */
async function produceLegacyBaselineEvidence(workspacePath: string, id: string, command: string): Promise<VerificationEvidence> {
  const { runVerification } = await import("../src/verification-service.js");
  const report = await runVerification(workspacePath, [{ id, kind: "lint" as const, command, required: true, source: "configured" as const }]);
  const evidence = report.forgeVerify?.evidence[0];
  if (!evidence) throw new Error("Expected baseline evidence to be produced.");
  return evidence;
}

describe("FG-12D narrowToStrictEvidence — fail-closed on incomplete/malformed evidence", () => {
  it("accepts a complete real evidence record", async () => {
    const dir = fixture();
    const evidence = await produceBaselineEvidence(dir, "fg12d.narrow.ok", "a.js");
    expect(narrowToStrictEvidence(evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence)).toBeDefined();
  });

  it("rejects evidence missing definitionDigest (incomplete metadata)", async () => {
    const dir = fixture();
    const evidence = await produceBaselineEvidence(dir, "fg12d.narrow.missing", "a.js");
    const { definitionDigest, ...withoutDigest } = evidence;
    expect(narrowToStrictEvidence(withoutDigest as unknown as import("@codeforge/forge-green").GenericVerificationEvidence)).toBeUndefined();
  });

  it("rejects a corrupted/malformed evidence reference (wrong-typed field)", async () => {
    const dir = fixture();
    const evidence = await produceBaselineEvidence(dir, "fg12d.narrow.corrupt", "a.js");
    const corrupted = { ...evidence, inputStateHash: 12345 as unknown as string };
    expect(narrowToStrictEvidence(corrupted as unknown as import("@codeforge/forge-green").GenericVerificationEvidence)).toBeUndefined();
  });

  it("rejects an evidence status outside the known set", async () => {
    const dir = fixture();
    const evidence = await produceBaselineEvidence(dir, "fg12d.narrow.badstatus", "a.js");
    const corrupted = { ...evidence, status: "unknown_status" as unknown as VerificationEvidence["status"] };
    expect(narrowToStrictEvidence(corrupted as unknown as import("@codeforge/forge-green").GenericVerificationEvidence)).toBeUndefined();
  });
});

describe("FG-12D requestVerificationEvidenceReuse — ForgeVerify remains the authority", () => {
  it("SHADOW mode never surfaces reusable evidence even when validity is confirmed", async () => {
    const dir = fixture();
    const id = "fg12d.advisor.shadow";
    const evidence = await produceBaselineEvidence(dir, id, "a.js");
    const registry = createVerifierRegistry([syntaxVerifier(id, "a.js")]);
    const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "check", workspacePath: dir, scope: "workspace" });
    const result = requestVerificationEvidenceReuse({ priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence], plan, registry, mode: "SHADOW" });
    expect(result.reusableEvidence).toEqual([]);
    expect(result.proposedReusableEvidence.length).toBe(1); // still confirmed valid, just not surfaced
  });

  it("CONTROLLED_ACTIVE_TRIAL surfaces evidence ForgeVerify's canonical check confirms valid", async () => {
    const dir = fixture();
    const id = "fg12d.advisor.trial";
    const evidence = await produceBaselineEvidence(dir, id, "a.js");
    const registry = createVerifierRegistry([syntaxVerifier(id, "a.js")]);
    const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "check", workspacePath: dir, scope: "workspace" });
    const result = requestVerificationEvidenceReuse({ priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence], plan, registry, mode: "CONTROLLED_ACTIVE_TRIAL" });
    expect(result.reusableEvidence.length).toBe(1);
    expect(result.reusableEvidence[0]!.evidenceId).toBe(evidence.evidenceId);
  });

  it("never surfaces evidence for a changed workspace, even in CONTROLLED_ACTIVE_TRIAL", async () => {
    const dir = fixture();
    const id = "fg12d.advisor.changed";
    const evidence = await produceBaselineEvidence(dir, id, "a.js");
    fs.writeFileSync(path.join(dir, "a.js"), "function ok() { return 2; }\nmodule.exports = { ok };\n");
    const registry = createVerifierRegistry([syntaxVerifier(id, "a.js")]);
    const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "check", workspacePath: dir, scope: "workspace" });
    const result = requestVerificationEvidenceReuse({ priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence], plan, registry, mode: "CONTROLLED_ACTIVE_TRIAL" });
    expect(result.reusableEvidence).toEqual([]);
  });

  it("respects the global CODEFORGE_FORGEGREEN_OPTIMIZATION=OFF kill-switch even in CONTROLLED_ACTIVE_TRIAL", async () => {
    const dir = fixture();
    const id = "fg12d.advisor.killswitch";
    const evidence = await produceBaselineEvidence(dir, id, "a.js");
    const registry = createVerifierRegistry([syntaxVerifier(id, "a.js")]);
    const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "check", workspacePath: dir, scope: "workspace" });
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "OFF";
    const result = requestVerificationEvidenceReuse({ priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence], plan, registry, mode: "CONTROLLED_ACTIVE_TRIAL" });
    expect(result.reusableEvidence).toEqual([]);
  });

  it("never reuses evidence whose prior status was not passed", async () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "broken.js"), "function broken( { return 1\n");
    const id = "fg12d.advisor.failed";
    const evidence = await produceBaselineEvidence(dir, id, "broken.js");
    expect(evidence.status).toBe("failed");
    const registry = createVerifierRegistry([syntaxVerifier(id, "broken.js")]);
    const plan = createVerificationPlan(registry, { version: "v1" as import("../src/forge-verify.js").VerificationPolicyVersion, requiredVerifierIds: [id as VerifierId] }, { runId: "check", workspacePath: dir, scope: "workspace" });
    const result = requestVerificationEvidenceReuse({ priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence], plan, registry, mode: "CONTROLLED_ACTIVE_TRIAL" });
    expect(result.reusableEvidence).toEqual([]);
  });
});

describe("FG-12D runVerificationWithControlledReuse — real end-to-end wrapper", () => {
  it("reuses valid prior evidence for an unchanged workspace and avoids a second real verifier process", async () => {
    const dir = fixture();
    const id = "fg12d.wrapper.reuse";
    const evidence = await produceLegacyBaselineEvidence(dir, id, "node --check a.js");
    const outcome = await runVerificationWithControlledReuse(dir, [{ id, kind: "lint" as const, command: "node --check a.js", required: true, source: "configured" as const }], {
      priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence],
      mode: "CONTROLLED_ACTIVE_TRIAL",
    });
    expect(outcome.report.overallStatus).toBe("passed");
    expect(outcome.report.verifiers[0]!.reusedEvidenceId).toBe(evidence.evidenceId);
    expect(outcome.report.verifiers[0]!.durationMs).toBe(0);
    expect(outcome.reuseRequest?.reusableEvidence.length).toBe(1);
  });

  it("runs fresh verification when the workspace changed, never reusing stale evidence", async () => {
    const dir = fixture();
    const id = "fg12d.wrapper.stale";
    const evidence = await produceBaselineEvidence(dir, id, "a.js");
    fs.writeFileSync(path.join(dir, "a.js"), "function ok() { return 99; }\nmodule.exports = { ok };\n");
    const outcome = await runVerificationWithControlledReuse(dir, [{ id, kind: "lint" as const, command: "node --check a.js", required: true, source: "configured" as const }], {
      priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence],
      mode: "CONTROLLED_ACTIVE_TRIAL",
    });
    expect(outcome.report.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(outcome.report.verifiers[0]!.durationMs).toBeGreaterThan(0);
  });

  it("SHADOW mode always runs fresh even with valid prior evidence supplied", async () => {
    const dir = fixture();
    const id = "fg12d.wrapper.shadow";
    const evidence = await produceLegacyBaselineEvidence(dir, id, "node --check a.js");
    const outcome = await runVerificationWithControlledReuse(dir, [{ id, kind: "lint" as const, command: "node --check a.js", required: true, source: "configured" as const }], {
      priorEvidence: [evidence as unknown as import("@codeforge/forge-green").GenericVerificationEvidence],
      mode: "SHADOW",
    });
    expect(outcome.report.verifiers[0]!.reusedEvidenceId).toBeUndefined();
    expect(outcome.reuseRequest?.reusableEvidence).toEqual([]);
  });

  it("falls back to fresh verification when no prior evidence is supplied at all (default path unaffected)", async () => {
    const dir = fixture();
    const id = "fg12d.wrapper.noevidence";
    const outcome = await runVerificationWithControlledReuse(dir, [{ id, kind: "lint" as const, command: "node --check a.js", required: true, source: "configured" as const }], {});
    expect(outcome.report.overallStatus).toBe("passed");
    expect(outcome.reuseRequest).toBeUndefined();
  });
});
