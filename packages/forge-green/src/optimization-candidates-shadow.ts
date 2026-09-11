import { createOptimizationDecision } from "./optimization-decision.js";
import type { ForgeGreenOptimizationDecision, OptimizationKind } from "./optimization-types.js";

/**
 * FG-9 shadow-mode candidate detectors for Candidates B, C, D. Pure functions over
 * already-available evidence — no live execution is ever altered by these (their graduated
 * mode is `SHADOW`, enforced by `createOptimizationDecision`, which refuses to produce an
 * `APPLIED` status for any kind not registered `ACTIVE_SAFE`). Each detector is deliberately
 * conservative: any invalidating signal degrades to `SKIPPED_INSUFFICIENT_EVIDENCE` rather than
 * a proposed reuse.
 */

// ---------------------------------------------------------------------------
// Candidate B — duplicate context page transmission
// ---------------------------------------------------------------------------

export interface ContextPageTransmissionEvent {
  pageId: string;
  contentHash: string;
  workspaceRevision: number;
  turnIndex: number;
}

const KIND_B: OptimizationKind = "DUPLICATE_CONTEXT_PAGE_TRANSMISSION";

/** Flags a page as a candidate ONLY when the exact same `pageId` was transmitted more than once
 * with an IDENTICAL `contentHash` AND `workspaceRevision` across turns. Any change in either
 * invalidates the candidate (the content changed, or the workspace moved on) — never suppressed. */
export function detectDuplicateContextPageTransmission(params: {
  runId: string;
  sessionId: string | undefined;
  sustainabilityReceiptId: string | undefined;
  events: ContextPageTransmissionEvent[];
}): ForgeGreenOptimizationDecision {
  const byPage = new Map<string, ContextPageTransmissionEvent[]>();
  for (const event of params.events) {
    const list = byPage.get(event.pageId) ?? [];
    list.push(event);
    byPage.set(event.pageId, list);
  }

  const redundant: ContextPageTransmissionEvent[] = [];
  for (const occurrences of byPage.values()) {
    if (occurrences.length < 2) continue;
    const sorted = [...occurrences].sort((a, b) => a.turnIndex - b.turnIndex);
    const first = sorted[0]!;
    for (const later of sorted.slice(1)) {
      if (later.contentHash === first.contentHash && later.workspaceRevision === first.workspaceRevision) {
        redundant.push(later);
      }
      // A content-hash or workspace-revision change invalidates this later occurrence as a
      // candidate — it is genuinely new content, never suppressed.
    }
  }

  return createOptimizationDecision({
    runId: params.runId,
    sessionId: params.sessionId,
    kind: KIND_B,
    targetResource: "context_page_transmission",
    sourceEvidenceIds: redundant.map((e) => `${e.pageId}:${e.contentHash}:${e.turnIndex}`),
    sustainabilityReceiptId: params.sustainabilityReceiptId,
    expectedEffect: {
      avoidedRequests: undefined,
      avoidedTokens: undefined,
      avoidedBytes: undefined,
      avoidedToolExecutions: undefined,
      avoidedVerificationReruns: undefined,
      timeReductionMs: undefined,
    },
    confidence: redundant.length > 0 ? "HIGH_CONFIDENCE_ESTIMATE" : "INSUFFICIENT_DATA",
    safetyGuards: {
      redundancyRationale: "The same context page (pageId) was transmitted more than once within this session with an identical content hash and workspace revision — the consumer already holds this exact immutable content.",
      invariant: "Content hash AND workspace revision must be identical between the original transmission and the candidate duplicate; either changing invalidates the candidate.",
      verificationProof: undefined,
      reasonCodes: redundant.length > 0 ? ["IDENTICAL_CONTENT_HASH_SAME_REVISION"] : ["NO_REDUNDANT_TRANSMISSION_FOUND"],
    },
  });
}

// ---------------------------------------------------------------------------
// Candidate C — optional prefetch suppression
// ---------------------------------------------------------------------------

export interface OptionalPrefetchCandidate {
  pageId: string;
  /** True if any active dependency, verification obligation, or explicit user request needs it. */
  required: boolean;
  /** True if the identical content is already validly available (e.g. already in this turn's
   * assembled context, or a valid canonical-cache hit) without re-fetching. */
  alreadyValidlyAvailable: boolean;
}

const KIND_C: OptimizationKind = "OPTIONAL_PREFETCH_SUPPRESSION";

export function detectOptionalPrefetchSuppression(params: {
  runId: string;
  sessionId: string | undefined;
  sustainabilityReceiptId: string | undefined;
  candidates: OptionalPrefetchCandidate[];
}): ForgeGreenOptimizationDecision {
  const suppressible = params.candidates.filter((c) => !c.required && c.alreadyValidlyAvailable);

  return createOptimizationDecision({
    runId: params.runId,
    sessionId: params.sessionId,
    kind: KIND_C,
    targetResource: "optional_context_prefetch",
    sourceEvidenceIds: suppressible.map((c) => c.pageId),
    sustainabilityReceiptId: params.sustainabilityReceiptId,
    expectedEffect: {
      avoidedRequests: undefined,
      avoidedTokens: undefined,
      avoidedBytes: undefined,
      avoidedToolExecutions: suppressible.length > 0 ? suppressible.length : undefined,
      avoidedVerificationReruns: undefined,
      timeReductionMs: undefined,
    },
    confidence: suppressible.length > 0 ? "HIGH_CONFIDENCE_ESTIMATE" : "INSUFFICIENT_DATA",
    safetyGuards: {
      redundancyRationale: "The candidate page is explicitly optional (no active dependency, verification obligation, or user request needs it) and the identical content is already validly available.",
      invariant: "A page whose `required` flag is true, or whose content is not already validly available, is never a candidate — this is never a semantic-usefulness guess.",
      verificationProof: undefined,
      reasonCodes: suppressible.length > 0 ? ["OPTIONAL_AND_ALREADY_AVAILABLE"] : ["NO_SUPPRESSIBLE_OPTIONAL_PREFETCH"],
    },
  });
}

// ---------------------------------------------------------------------------
// Candidate D — verification evidence reuse (ForgeVerify decides; FG-9 only proposes)
// ---------------------------------------------------------------------------

export interface VerificationEvidenceReuseCandidate {
  evidenceId: string;
  workspaceContentHash: string;
  policyRevision: string;
  command: string;
  dependencyStateHash: string;
  /** MUST be an explicit, already-made ForgeVerify validity decision — FG-9 never computes this
   * itself. Absent/false means the evidence is not proposed for reuse, full stop. */
  forgeVerifyConfirmedValid: boolean;
}

const KIND_D: OptimizationKind = "VERIFICATION_EVIDENCE_REUSE";

export function detectReusableVerificationEvidence(params: {
  runId: string;
  sessionId: string | undefined;
  sustainabilityReceiptId: string | undefined;
  candidates: VerificationEvidenceReuseCandidate[];
}): ForgeGreenOptimizationDecision {
  const reusable = params.candidates.filter((c) => c.forgeVerifyConfirmedValid === true);
  const anyRejectedByForgeVerify = params.candidates.some((c) => c.forgeVerifyConfirmedValid === false);

  return createOptimizationDecision({
    runId: params.runId,
    sessionId: params.sessionId,
    kind: KIND_D,
    targetResource: "verification_evidence",
    sourceEvidenceIds: reusable.map((c) => c.evidenceId),
    sustainabilityReceiptId: params.sustainabilityReceiptId,
    expectedEffect: {
      avoidedRequests: undefined,
      avoidedTokens: undefined,
      avoidedBytes: undefined,
      avoidedToolExecutions: undefined,
      avoidedVerificationReruns: reusable.length > 0 ? reusable.length : undefined,
      timeReductionMs: undefined,
    },
    confidence: reusable.length > 0 ? "DIRECT" : "INSUFFICIENT_DATA",
    safetyGuards: {
      redundancyRationale: "ForgeVerify's own validity policy (workspace content hash, policy revision, command/config, dependency state) already confirmed this evidence remains valid — FG-9 never invents a parallel verification-cache validity policy.",
      invariant: "`forgeVerifyConfirmedValid` must be an explicit true from ForgeVerify's own decision; FG-9 never independently judges evidence validity. Removing verification is never represented as an optimization — this class only REUSES evidence ForgeVerify already authorized.",
      verificationProof: reusable.length > 0 ? reusable.map((c) => c.evidenceId).join(",") : undefined,
      reasonCodes: [
        ...(reusable.length > 0 ? ["FORGEVERIFY_CONFIRMED_VALID_EVIDENCE_REUSE"] : []),
        ...(anyRejectedByForgeVerify ? ["FORGEVERIFY_REJECTED_SOME_CANDIDATES"] : []),
        ...(reusable.length === 0 && !anyRejectedByForgeVerify ? ["NO_CANDIDATES_SUBMITTED"] : []),
      ],
    },
  });
}
