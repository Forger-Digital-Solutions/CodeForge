import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { HandoffContext, HandoffCompletedAction } from "./types.js";

export interface RepositoryIntelligenceCompletenessSource {
  /** Returns the current advisory completeness for the changed files in this turn, if
   * Repository Intelligence (FG-2) is available. 8-Bit must preserve PARTIAL/UNKNOWN as-is —
   * never upgrade it to COMPLETE for routing convenience. */
  getCompleteness(): "COMPLETE" | "PARTIAL" | "UNKNOWN" | undefined;
}

const MAX_ACTIONS = 25;
const MAX_SUMMARY_LEN = 160;

function truncate(s: string, max = MAX_SUMMARY_LEN): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Builds a bounded, deterministic snapshot of authoritative runtime truth for a turn, sourced
 * ENTIRELY from persisted `WorkItem`s (never guessed from conversation text). This is what a
 * replacement model is told already happened — CodeForge runtime persistence remains the
 * actual source of truth; this is a summary for context injection, not a new authority.
 */
export class EightBitHandoffBuilder {
  constructor(private readonly persistence: ISessionPersistence) {}

  async build(
    sessionId: string,
    turnId: string,
    objective: string,
    repoIntelligence?: RepositoryIntelligenceCompletenessSource,
  ): Promise<HandoffContext> {
    const items = await this.persistence.getWorkItems(sessionId);
    const forTurn = items.filter((i) => "turnId" in i && (i as { turnId?: string }).turnId === turnId);

    const completedActions: HandoffCompletedAction[] = [];
    const changedFiles: string[] = [];
    let approvalPending = false;
    let questionPending = false;

    for (const item of forTurn) {
      switch (item.kind) {
        case "command":
          if (item.status !== "running") {
            completedActions.push({
              kind: "command",
              summary: truncate(`${item.command}${item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ""}`),
              at: item.completedAt ?? item.startedAt,
            });
          }
          break;
        case "file_change":
          changedFiles.push(item.path);
          completedActions.push({
            kind: "file_change",
            summary: truncate(`${item.changeType} ${item.path} (+${item.additions}/-${item.deletions})`),
            at: item.appliedAt,
          });
          break;
        case "activity":
          if (item.status === "completed") {
            completedActions.push({ kind: "tool_call", summary: truncate(item.title), at: item.completedAt ?? item.startedAt });
          }
          break;
        case "approval":
          if (!item.decision) approvalPending = true;
          break;
        case "question":
          if (!item.answer) questionPending = true;
          break;
      }
    }

    completedActions.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

    return {
      sessionId,
      turnId,
      objective: truncate(objective, 400),
      completedActions: completedActions.slice(-MAX_ACTIONS),
      changedFiles: [...new Set(changedFiles)],
      verificationRequired: true,
      approvalPending,
      questionPending,
      repositoryIntelligenceCompleteness: repoIntelligence?.getCompleteness(),
      generatedAt: new Date().toISOString(),
    };
  }
}

export function createEightBitHandoffBuilder(persistence: ISessionPersistence): EightBitHandoffBuilder {
  return new EightBitHandoffBuilder(persistence);
}

export type { WorkItem };
