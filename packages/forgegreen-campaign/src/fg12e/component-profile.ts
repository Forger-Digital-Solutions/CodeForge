import {
  adaptTrustedLegacyVerifiers,
  commandIsAvailable,
  createVerificationInputStateHash,
  createVerificationPlan,
  createVerifierRegistry,
  executeVerificationPlan,
  isEvidenceCurrentlyValid,
  narrowToStrictEvidence,
  requestVerificationEvidenceReuse,
  runVerification,
  summarizeVerification,
  VerificationEvidenceStore,
  type VerificationEvidence,
  type VerificationPolicy,
  type Verifier,
} from "@codeforge/workflow";
import { detectReusableVerificationEvidence, resolveOptimizationMode, type GenericVerificationEvidence } from "@codeforge/forge-green";
import { createTimelineObserver, now, round, summarize, timedSync, type SummaryStats } from "./timing.js";
import type { BenchWorkspace } from "./workloads.js";

/**
 * FG-12E component profile (spec §11/§12). Calls the SAME production functions, in the SAME
 * order, that `runVerificationWithControlledReuse` -> `runVerification` -> `executeVerificationPlan`
 * call on the reuse path — with a monotonic timer around each — so the treatment overhead can be
 * attributed to its parts. This is attribution only; the scored break-even numbers come from the
 * real wrapper (pair-runner.ts), and the two are cross-checked in the report.
 *
 * Spans are reported as a tree: a "total" span and its sub-spans measured in the same iteration.
 * Sub-spans are never summed on top of their parent (spec §11: no double counting).
 */

export interface ComponentSample {
  /** ForgeVerify input-state hash alone (git rev-parse + diff + ls-files + untracked hashing). */
  inputStateHashMs: number;
  /** Advisory side (inside the FG-12D wrapper, before `runVerification`). */
  advisory: {
    commandAvailabilityMs: number;
    adaptAndRegistryMs: number;
    /** Preliminary plan creation — INCLUDES one input-state hash. */
    preliminaryPlanMs: number;
    /** `requestVerificationEvidenceReuse` total — INCLUDES the four sub-spans below. */
    advisorTotalMs: number;
    strictNarrowingMs: number;
    canonicalValidityMs: number;
    forgeGreenDecisionMs: number;
    killSwitchResolveMs: number;
    /** Sum of the non-overlapping advisory parts = the marginal advisory overhead. */
    totalMs: number;
  };
  /** Authoritative side (inside the real `runVerification`, reuse path). */
  authoritative: {
    adaptAndRegistryMs: number;
    /** Authoritative plan creation — INCLUDES one input-state hash. */
    planMs: number;
    /** `executeVerificationPlan` with confirmed evidence: reuse matching + `summarizeVerification`
     * (which INCLUDES one more input-state hash). No child process is spawned. */
    executeReuseMatchAndSummarizeMs: number;
    /** `summarizeVerification` alone (sub-span of the previous). */
    summarizeMs: number;
    /** Observer-derived: `coverageReceiptCreated` -> return, plus the coverage evaluation
     * itself, taken from a real `runVerification` reuse call in the same iteration. */
    coverageAndReportAssemblyMs: number;
    /** Wall time of a real `runVerification(existingEvidence=confirmed)` call. */
    runVerificationReuseWallMs: number;
  };
  /** advisory.totalMs + authoritative.runVerificationReuseWallMs — the whole reuse path. */
  reusePathTotalMs: number;
}

export interface ComponentProfile {
  workspaceKind: BenchWorkspace["kind"];
  verifierIds: string[];
  iterations: number;
  samples: ComponentSample[];
  stats: Record<string, SummaryStats>;
}

function flatten(sample: ComponentSample): Record<string, number> {
  return {
    inputStateHashMs: sample.inputStateHashMs,
    "advisory.commandAvailabilityMs": sample.advisory.commandAvailabilityMs,
    "advisory.adaptAndRegistryMs": sample.advisory.adaptAndRegistryMs,
    "advisory.preliminaryPlanMs": sample.advisory.preliminaryPlanMs,
    "advisory.advisorTotalMs": sample.advisory.advisorTotalMs,
    "advisory.strictNarrowingMs": sample.advisory.strictNarrowingMs,
    "advisory.canonicalValidityMs": sample.advisory.canonicalValidityMs,
    "advisory.forgeGreenDecisionMs": sample.advisory.forgeGreenDecisionMs,
    "advisory.killSwitchResolveMs": sample.advisory.killSwitchResolveMs,
    "advisory.totalMs": sample.advisory.totalMs,
    "authoritative.adaptAndRegistryMs": sample.authoritative.adaptAndRegistryMs,
    "authoritative.planMs": sample.authoritative.planMs,
    "authoritative.executeReuseMatchAndSummarizeMs": sample.authoritative.executeReuseMatchAndSummarizeMs,
    "authoritative.summarizeMs": sample.authoritative.summarizeMs,
    "authoritative.coverageAndReportAssemblyMs": sample.authoritative.coverageAndReportAssemblyMs,
    "authoritative.runVerificationReuseWallMs": sample.authoritative.runVerificationReuseWallMs,
    reusePathTotalMs: sample.reusePathTotalMs,
  };
}

export async function profileReusePathComponents(workspace: BenchWorkspace, verifiers: Verifier[], priorEvidence: readonly VerificationEvidence[], iterations = 20): Promise<ComponentProfile> {
  const samples: ComponentSample[] = [];
  const generic = priorEvidence as unknown as readonly GenericVerificationEvidence[];

  for (let i = 0; i < iterations; i += 1) {
    const hash = timedSync(() => createVerificationInputStateHash(workspace.root));

    // --- advisory side, in wrapper order ---
    const availability = timedSync(() => verifiers.filter((v) => commandIsAvailable(workspace.root, v.command)));
    const adapt = timedSync(() => createVerifierRegistry(adaptTrustedLegacyVerifiers(workspace.root, availability.result)));
    const policy: VerificationPolicy = { version: "fg12d-advisory-policy-v1" as VerificationPolicy["version"] };
    const prelim = timedSync(() => createVerificationPlan(adapt.result, policy, { runId: `fg12e-profile-advisory-${i}`, workspacePath: workspace.root, scope: "workspace" }));

    // Sub-spans of the advisor, measured individually against the same inputs.
    const narrowing = timedSync(() => generic.map((e) => narrowToStrictEvidence(e)).filter((e): e is VerificationEvidence => Boolean(e)));
    const validity = timedSync(() =>
      narrowing.result.map((strict) => {
        const planned = prelim.result.verifiers.find((v) => v.verifierId === strict.verifierId);
        return planned ? isEvidenceCurrentlyValid(strict, { workspacePath: prelim.result.workspacePath, inputStateHash: prelim.result.inputStateHash, definitionDigest: planned.definitionDigest }) : false;
      }),
    );
    const decision = timedSync(() =>
      detectReusableVerificationEvidence({
        runId: prelim.result.runId,
        sessionId: undefined,
        sustainabilityReceiptId: undefined,
        candidates: narrowing.result.map((strict, index) => ({ evidenceId: strict.evidenceId, workspaceContentHash: strict.inputStateHash, policyRevision: prelim.result.policyVersion, command: strict.commandDigest, dependencyStateHash: strict.definitionDigest, forgeVerifyConfirmedValid: validity.result[index] ?? false })),
      }),
    );
    const killSwitch = timedSync(() => resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE") === "OFF");
    const advisor = timedSync(() => requestVerificationEvidenceReuse({ priorEvidence: generic, plan: prelim.result, registry: adapt.result, mode: "CONTROLLED_ACTIVE_TRIAL" }));
    void decision;
    void killSwitch;
    const advisoryTotal = round(availability.ms + adapt.ms + prelim.ms + advisor.ms);

    // --- authoritative side, in runVerification order ---
    const adapt2 = timedSync(() => createVerifierRegistry(adaptTrustedLegacyVerifiers(workspace.root, availability.result)));
    const legacyPolicy: VerificationPolicy = { version: "legacy-workflow-policy-v1" as VerificationPolicy["version"] };
    const plan = timedSync(() => createVerificationPlan(adapt2.result, legacyPolicy, { runId: `fg12e-profile-authoritative-${i}`, workspacePath: workspace.root, scope: "workspace" }));
    const executeStart = now();
    const execution = await executeVerificationPlan(adapt2.result, plan.result, new VerificationEvidenceStore(), { existingEvidence: advisor.result.reusableEvidence });
    const executeMs = round(now() - executeStart);
    if (execution.attempts.length !== 0) throw new Error("component profile spawned a verifier — reuse path was not taken; profile invalid");
    const summarizeOnly = timedSync(() => summarizeVerification(plan.result, adapt2.result, execution.evidence));

    // A real reuse-path runVerification call with the timeline observer, for the coverage tail.
    const { observer, timeline } = createTimelineObserver();
    const rvStart = now();
    const report = await runVerification(workspace.root, verifiers, { observer, existingEvidence: advisor.result.reusableEvidence, existingEvidenceSource: "durable" });
    const rvMs = round(now() - rvStart);
    if (report.verifiers.some((v) => !v.reusedEvidenceId)) throw new Error("component profile's runVerification did not reuse every verifier; profile invalid");
    const planAt = timeline.planCreatedAt ?? rvStart;
    const rvEnd = rvStart + rvMs;
    // Everything after the authoritative plan in the reuse path = execute(reuse+summarize) +
    // coverage evaluation + report assembly. Subtract the directly-measured execute span.
    const coverageAndAssembly = round(Math.max(0, rvEnd - planAt - executeMs));

    samples.push({
      inputStateHashMs: hash.ms,
      advisory: {
        commandAvailabilityMs: availability.ms,
        adaptAndRegistryMs: adapt.ms,
        preliminaryPlanMs: prelim.ms,
        advisorTotalMs: advisor.ms,
        strictNarrowingMs: narrowing.ms,
        canonicalValidityMs: validity.ms,
        forgeGreenDecisionMs: decision.ms,
        killSwitchResolveMs: killSwitch.ms,
        totalMs: advisoryTotal,
      },
      authoritative: {
        adaptAndRegistryMs: adapt2.ms,
        planMs: plan.ms,
        executeReuseMatchAndSummarizeMs: executeMs,
        summarizeMs: summarizeOnly.ms,
        coverageAndReportAssemblyMs: coverageAndAssembly,
        runVerificationReuseWallMs: rvMs,
      },
      reusePathTotalMs: round(advisoryTotal + rvMs),
    });
  }

  const stats: Record<string, SummaryStats> = {};
  const keys = Object.keys(flatten(samples[0]!));
  for (const key of keys) stats[key] = summarize(samples.map((s) => flatten(s)[key]!));
  return { workspaceKind: workspace.kind, verifierIds: verifiers.map((v) => v.id), iterations, samples, stats };
}
