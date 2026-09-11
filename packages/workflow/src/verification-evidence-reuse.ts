import {
  adaptTrustedLegacyVerifiers,
  createVerificationPlan,
  createVerifierRegistry,
  isEvidenceCurrentlyValid,
  type VerificationEvidence,
  type VerificationPlan,
  type VerificationPolicy,
  type VerifierRegistry,
} from "./forge-verify.js";
import { commandIsAvailable, discoverVerifiers, runVerification } from "./verification-service.js";
import type { Verifier, VerificationReport } from "./types.js";
import {
  detectReusableVerificationEvidence,
  resolveOptimizationMode,
  type ForgeGreenOptimizationDecision,
  type GenericVerificationEvidence,
  type VerificationEvidenceReuseCandidate,
} from "@codeforge/forge-green";

/**
 * FG-12D controlled trial mode. Deliberately NOT added to ForgeGreen's certified
 * `OptimizationPolicyMode` union (`optimization-types.ts`) — that type is pattern-matched by
 * `createOptimizationDecision`'s APPLIED guard and the global graduation/ceiling machinery, and
 * widening it would make this mode reachable from places far outside this narrow, explicit
 * opt-in. The global graduation registry entry for `VERIFICATION_EVIDENCE_REUSE` stays `SHADOW`
 * — nothing here changes it. Only code that explicitly imports `ReuseTrialMode` and passes
 * `"CONTROLLED_ACTIVE_TRIAL"` can ever reach reuse; every existing production caller of
 * `runVerification` is untouched and keeps running fresh, unconditionally.
 */
export type ReuseTrialMode = "SHADOW" | "CONTROLLED_ACTIVE_TRIAL";

const REQUIRED_STRICT_STRING_FIELDS = [
  "evidenceId",
  "attemptId",
  "planId",
  "verifierId",
  "runId",
  "workspacePath",
  "inputStateHash",
  "definitionDigest",
  "status",
  "commandDigest",
  "evidenceHash",
] as const;

/**
 * Narrows a loosely-typed, persistence-round-tripped `GenericVerificationEvidence` to a strict
 * `VerificationEvidence` — or `undefined` if any field this module's validity/identity logic
 * depends on is missing or not a string. This alone implements the "incomplete evidence
 * metadata" / "corrupted or malformed evidence reference" invalidation categories: a gap here is
 * never guessed closed, it simply removes the record from reuse consideration (spec §4/§14).
 */
export function narrowToStrictEvidence(generic: GenericVerificationEvidence): VerificationEvidence | undefined {
  const record = generic as unknown as Record<string, unknown>;
  for (const field of REQUIRED_STRICT_STRING_FIELDS) {
    if (typeof record[field] !== "string" || record[field] === "") return undefined;
  }
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "cancelled" && record.status !== "timed_out" && record.status !== "infra_error" && record.status !== "interrupted") {
    return undefined;
  }
  return generic as unknown as VerificationEvidence;
}

export interface VerificationEvidenceReuseRequest {
  /** Real persisted evidence — e.g. from `loadForgeVerifyEvidence` — for this workspace/session.
   * Never fetched by this function itself; always supplied by the caller. */
  priorEvidence: readonly GenericVerificationEvidence[];
  /** The plan whose obligations reuse is being considered against. Any plan works here — this
   * function never executes anything — but see `runVerificationWithControlledReuse` for why the
   * *authoritative* decision always comes from a plan built fresh, immediately before execution. */
  plan: VerificationPlan;
  registry: VerifierRegistry;
  mode: ReuseTrialMode;
}

export interface VerificationEvidenceReuseResult {
  /** Confirmed-valid AND permitted under the current mode — this is what may be handed to the
   * real `runVerification`'s `existingEvidence`. Always empty outside `CONTROLLED_ACTIVE_TRIAL`,
   * and always empty if the global `VERIFICATION_EVIDENCE_REUSE` kill-switch resolves to `OFF`. */
  reusableEvidence: readonly VerificationEvidence[];
  /** Every candidate ForgeVerify's canonical validity check confirmed, regardless of mode —
   * diagnostic only. "Actual" prevented work is never computed from this; only from what
   * `runVerification` itself reports it actually reused (amendment §3). */
  proposedReusableEvidence: readonly VerificationEvidence[];
  /** The formal ForgeGreen decision — always built and returned, even in SHADOW, for full
   * observability. A SHADOW-mode call still produces this; it just never affects execution. */
  decision: ForgeGreenOptimizationDecision;
}

/**
 * ForgeGreen's advisory layer for Candidate D: identifies candidates and requests validation —
 * it never determines validity itself. Every "is this still valid" question is answered by
 * calling the single canonical `isEvidenceCurrentlyValid` helper from `forge-verify.ts`
 * unmodified; this function only decides, from that answer plus the trial mode, whether to
 * surface the evidence for reuse at all.
 */
export function requestVerificationEvidenceReuse(request: VerificationEvidenceReuseRequest): VerificationEvidenceReuseResult {
  const candidates: Array<{ strict: VerificationEvidence; candidate: VerificationEvidenceReuseCandidate }> = [];

  for (const generic of request.priorEvidence) {
    const strict = narrowToStrictEvidence(generic);
    if (!strict) continue;
    const planned = request.plan.verifiers.find((v) => v.verifierId === strict.verifierId);
    if (!planned) continue; // not part of the current obligation set at all

    const forgeVerifyConfirmedValid = isEvidenceCurrentlyValid(strict, {
      workspacePath: request.plan.workspacePath,
      inputStateHash: request.plan.inputStateHash,
      definitionDigest: planned.definitionDigest,
    });

    candidates.push({
      strict,
      candidate: {
        evidenceId: strict.evidenceId,
        workspaceContentHash: strict.inputStateHash,
        policyRevision: request.plan.policyVersion,
        command: strict.commandDigest,
        dependencyStateHash: strict.definitionDigest,
        forgeVerifyConfirmedValid,
      },
    });
  }

  const decision = detectReusableVerificationEvidence({
    runId: request.plan.runId,
    sessionId: undefined,
    sustainabilityReceiptId: undefined,
    candidates: candidates.map((entry) => entry.candidate),
  });

  const proposedReusableEvidence = candidates.filter((entry) => entry.candidate.forgeVerifyConfirmedValid).map((entry) => entry.strict);

  // Hard kill-switch: the existing env-var ceiling that can force any ForgeGreen optimization
  // kind down to OFF still applies here even though this trial mode bypasses the ACTIVE_SAFE
  // graduation registry itself — rollback capability is preserved.
  const globallyDisabled = resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE") === "OFF";
  const reusableEvidence = request.mode === "CONTROLLED_ACTIVE_TRIAL" && !globallyDisabled ? proposedReusableEvidence : [];

  return { reusableEvidence, proposedReusableEvidence, decision };
}

export interface ControlledReuseOptions {
  priorEvidence?: readonly GenericVerificationEvidence[];
  mode?: ReuseTrialMode;
  signal?: AbortSignal;
  timeoutMs?: number;
  runId?: string;
  executionRevision?: number;
}

export interface ControlledReuseOutcome {
  report: VerificationReport;
  /** `undefined` when no prior evidence was supplied, or when building the advisory plan itself
   * failed (see `fallbackReason`) — fresh verification still ran unconditionally either way. */
  reuseRequest: VerificationEvidenceReuseResult | undefined;
  fallbackReason: string | undefined;
}

/**
 * Thin, additive wrapper around the real, unmodified `runVerification`. Builds a *preliminary*
 * plan only so the advisor can propose reusable evidence; `runVerification` then builds its own
 * *authoritative* plan fresh, immediately before real execution — that second plan (and
 * `executeVerificationPlan`'s own pre-existing, unmodified reuse check inside it) is what
 * actually decides reuse. Any workspace mutation between the two plan constructions changes
 * `inputStateHash` and is caught by the authoritative check, not by anything here (TOCTOU-safe
 * by construction). If the advisory step throws for any reason, it is swallowed and fresh
 * verification runs exactly as if no prior evidence had been supplied — ForgeGreen failure never
 * blocks verification (spec §19).
 */
export async function runVerificationWithControlledReuse(
  workspacePath: string,
  commandsOrVerifiers: string[] | Verifier[] = ["npm test", "npm run typecheck"],
  options: ControlledReuseOptions = {},
): Promise<ControlledReuseOutcome> {
  const { priorEvidence = [], mode = "SHADOW", ...runOptions } = options;
  let reuseRequest: VerificationEvidenceReuseResult | undefined;
  let fallbackReason: string | undefined;

  try {
    if (priorEvidence.length > 0) {
      const verifiers: Verifier[] =
        Array.isArray(commandsOrVerifiers) && commandsOrVerifiers.length > 0 && typeof commandsOrVerifiers[0] !== "string"
          ? (commandsOrVerifiers as Verifier[])
          : discoverVerifiers(workspacePath, Array.isArray(commandsOrVerifiers) && typeof commandsOrVerifiers[0] === "string" ? (commandsOrVerifiers as string[]) : undefined);
      const availableVerifiers = verifiers.filter((v) => commandIsAvailable(workspacePath, v.command));
      if (availableVerifiers.length > 0) {
        const definitions = adaptTrustedLegacyVerifiers(
          workspacePath,
          availableVerifiers.map((verifier) => ({ ...verifier, timeoutMs: verifier.timeoutMs ?? runOptions.timeoutMs })),
        );
        const registry = createVerifierRegistry(definitions);
        const policy: VerificationPolicy = { version: "fg12d-advisory-policy-v1" as VerificationPolicy["version"] };
        const preliminaryPlan = createVerificationPlan(registry, policy, {
          runId: runOptions.runId ? `${runOptions.runId}-fg12d-advisory` : `fg12d-advisory-${Date.now()}`,
          workspacePath,
          scope: "workspace",
          ...(runOptions.executionRevision !== undefined ? { executionRevision: runOptions.executionRevision } : {}),
        });
        reuseRequest = requestVerificationEvidenceReuse({ priorEvidence, plan: preliminaryPlan, registry, mode });
      }
    }
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    reuseRequest = undefined;
  }

  const report = await runVerification(workspacePath, commandsOrVerifiers, {
    ...runOptions,
    ...(reuseRequest && reuseRequest.reusableEvidence.length > 0
      ? { existingEvidence: reuseRequest.reusableEvidence, existingEvidenceSource: "durable" as const }
      : {}),
  });

  return { report, reuseRequest, fallbackReason };
}
