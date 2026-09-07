import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import { buildContextKernel } from "@codeforge/context";
import type { HandoffContext, HandoffContextPageRef } from "./types.js";

export interface RepositoryIntelligenceCompletenessSource {
  /** Returns the current advisory completeness for the changed files in this turn, if
   * Repository Intelligence (FG-2) is available. 8-Bit must preserve PARTIAL/UNKNOWN as-is —
   * never upgrade it to COMPLETE for routing convenience. */
  getCompleteness(): "COMPLETE" | "PARTIAL" | "UNKNOWN" | undefined;
}

/**
 * Builds a bounded, deterministic snapshot of authoritative runtime truth for a turn, sourced
 * ENTIRELY from persisted `WorkItem`s (never guessed from conversation text). This is what a
 * replacement model is told already happened — CodeForge runtime persistence remains the
 * actual source of truth; this is a summary for context injection, not a new authority.
 *
 * FG-3: internally delegates to `buildContextKernel` (`@codeforge/context`) so the handoff and
 * every other FG-3 consumer of runtime truth (the progressive Context Planner, receipts) share
 * one computation instead of two independently-maintained WorkItem readers.
 */
export class EightBitHandoffBuilder {
  constructor(private readonly persistence: ISessionPersistence) {}

  async build(
    sessionId: string,
    turnId: string,
    objective: string,
    repoIntelligence?: RepositoryIntelligenceCompletenessSource,
    /** FG-3D: optional callback the caller supplies to build reusable Context Page references
     * for this turn's changed files (it alone holds the RepositoryIntelligence/page-store
     * handles needed to do so) — kept out of this class to preserve its "intentionally thin,
     * WorkItem-only" contract. Failure here must never fail the handoff itself. */
    buildContextPages?: (changedFiles: string[]) => Promise<HandoffContextPageRef[]>,
  ): Promise<HandoffContext> {
    const kernel = await buildContextKernel(this.persistence, {
      sessionId,
      turnId,
      objective,
      repositoryIntelligenceCompleteness: repoIntelligence?.getCompleteness(),
    });

    const contextPages = buildContextPages
      ? await buildContextPages(kernel.changedFiles).catch(() => undefined)
      : undefined;

    return {
      sessionId,
      turnId,
      objective: kernel.objective,
      completedActions: kernel.completedActions,
      changedFiles: kernel.changedFiles,
      verificationRequired: kernel.verification.required,
      approvalPending: kernel.approval.pending,
      questionPending: kernel.question.pending,
      repositoryIntelligenceCompleteness: kernel.repositoryIntelligenceCompleteness,
      generatedAt: kernel.generatedAt,
      kernel,
      ...(contextPages && contextPages.length > 0 ? { contextPages } : {}),
    };
  }
}

export function createEightBitHandoffBuilder(persistence: ISessionPersistence): EightBitHandoffBuilder {
  return new EightBitHandoffBuilder(persistence);
}

export type { WorkItem };
