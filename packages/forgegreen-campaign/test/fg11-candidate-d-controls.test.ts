import { afterEach, describe, expect, it } from "vitest";
import { createVerifierRegistry, type VerificationPolicy, type VerificationPolicyVersion, type VerifierDefinition, type VerifierId, type VerifierVersion } from "@codeforge/workflow";
import { disposeFixture, FIXTURE_FILE_SETS, materializeFixture, mutateFixtureFile, type CampaignFixture } from "../src/fixtures.js";
import { observeCandidateD } from "../src/candidate-d-observer.js";

const identity = { certifiedSourceStateId: "test-state", campaignHarnessId: "test-harness" };
const fixtures: CampaignFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await disposeFixture(fixture);
});

function syntaxVerifier(id: string, relFilePath: string, extraArgs: string[] = []): VerifierDefinition {
  return {
    id: id as VerifierId,
    version: "1" as VerifierVersion,
    name: `syntax:${relFilePath}`,
    category: "lint",
    description: "test verifier",
    execution: { executable: process.execPath, args: [...extraArgs, "--check", relFilePath] },
    defaultRequirement: "required",
    timeoutMs: 15_000,
    maxAttempts: 1,
    supportedScopes: ["workspace"],
  };
}

function policyFor(ids: string[]): VerificationPolicy {
  return { version: "fg11-test-verify-1" as VerificationPolicyVersion, requiredVerifierIds: ids as VerifierId[] };
}

describe("FG-11 Candidate D real ForgeVerify-authority controls (spec §15, amendment §4)", () => {
  it("[identical state / equivalent pass] no mutation between baseline and fresh rerun validates as reusable", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const id = "d-control-1";
    const registry = createVerifierRegistry([syntaxVerifier(id, "src/billing/invoice.ts")]);
    const { observations } = await observeCandidateD({ runId: id, taskId: "control", ...identity, registry, policy: policyFor([id]), workspacePath: fixture.root, scope: "workspace" });
    expect(observations.length).toBe(1);
    expect(observations[0]!.classification).toBe("VALIDATED");
    expect(observations[0]!.unsafeFalsePositive).toBe(false);
  });

  it("[changed source] a real source edit between baseline and rerun invalidates reuse", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const id = "d-control-2";
    const registry = createVerifierRegistry([syntaxVerifier(id, "src/billing/currency.ts")]);
    const { observations } = await observeCandidateD({
      runId: id,
      taskId: "control",
      ...identity,
      registry,
      policy: policyFor([id]),
      workspacePath: fixture.root,
      scope: "workspace",
      mutate: async () => mutateFixtureFile(fixture, "src/billing/currency.ts", "export function formatCurrency(amount: number): string { return `USD ${amount.toFixed(2)}`; }\n"),
    });
    expect(observations.length).toBe(1);
    expect(observations[0]!.classification).toBe("INVALIDATED");
    expect(observations[0]!.unsafeFalsePositive).toBe(false);
  });

  it("[changed verification command] a different verifier definition on rerun invalidates reuse even with no source change", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const id = "d-control-3";
    const baselineRegistry = createVerifierRegistry([syntaxVerifier(id, "src/billing/invoice.ts")]);
    const freshRegistry = createVerifierRegistry([syntaxVerifier(id, "src/billing/invoice.ts", ["--stack-trace-limit=64"])]);
    const { observations } = await observeCandidateD({
      runId: id,
      taskId: "control",
      ...identity,
      registry: baselineRegistry,
      freshRegistry,
      policy: policyFor([id]),
      workspacePath: fixture.root,
      scope: "workspace",
    });
    expect(observations.length).toBe(1);
    expect(observations[0]!.classification).toBe("INVALIDATED");
  });

  it("[failed prior evidence] a baseline verifier that failed is never proposed for reuse", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    await mutateFixtureFile(fixture, "src/billing/currency.ts", "function broken( { return 1 \n"); // real, unambiguous syntax error (no top-level `export`)
    const id = "d-control-4";
    const registry = createVerifierRegistry([syntaxVerifier(id, "src/billing/currency.ts")]);
    const { observations } = await observeCandidateD({ runId: id, taskId: "control", ...identity, registry, policy: policyFor([id]), workspacePath: fixture.root, scope: "workspace" });
    expect(observations.length).toBe(1);
    expect(observations[0]!.diversityDimensions.priorStatus).toBe("failed");
    expect(observations[0]!.classification).toBe("INVALIDATED");
  });

  it("fresh verification always actually executes — evidence carries a real, distinct attemptId pair", async () => {
    const fixture = await materializeFixture(FIXTURE_FILE_SETS[0]!);
    fixtures.push(fixture);
    const id = "d-control-5";
    const registry = createVerifierRegistry([syntaxVerifier(id, "src/billing/invoice.ts")]);
    const { observations } = await observeCandidateD({ runId: id, taskId: "control", ...identity, registry, policy: policyFor([id]), workspacePath: fixture.root, scope: "workspace" });
    const [priorAttemptId, freshAttemptId] = observations[0]!.productionOccurrenceId.split(":");
    expect(priorAttemptId).toBeTruthy();
    expect(freshAttemptId).toBeTruthy();
    expect(priorAttemptId).not.toBe(freshAttemptId);
  });
});
