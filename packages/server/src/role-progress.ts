export interface ProgressToolCall {
  tool: string;
  target?: string;
  outcome: "success" | "failed" | "denied" | "suppressed";
  observationHash?: string;
}

export interface ProgressTurn {
  turn: number;
  calls: readonly ProgressToolCall[];
}

export interface RoleProgressAssessment {
  stalled: boolean;
  reason: "REPEATED_EVIDENCE" | null;
  quietTurns: number;
  threshold: number;
  novelObservations: number;
  successfulMutations: number;
}

const MUTATIONS = new Set(["edit_file", "write_file"]);

function evidenceKey(call: ProgressToolCall): string | null {
  if (call.outcome === "denied" || call.outcome === "suppressed" || !call.observationHash) return null;
  if (MUTATIONS.has(call.tool)) return null;
  // A newly read file is useful even when two files have identical contents. Repeated
  // searches and commands with identical observations add no information.
  return call.tool === "read_file"
    ? `${call.tool}:${call.target ?? ""}:${call.observationHash}`
    : `${call.tool}:${call.observationHash}`;
}

/** Classifies only observable tool evidence. Distinct, useful reads and changed files reset
 * the quiet window; a model's own claim of progress has no effect. */
export function assessCoderProgress(turns: readonly ProgressTurn[], taskSteps = 1): RoleProgressAssessment {
  const threshold = taskSteps >= 4 ? 7 : taskSteps >= 2 ? 6 : 5;
  const seen = new Set<string>();
  let quietTurns = 0;
  let novelObservations = 0;
  let successfulMutations = 0;
  let trailingCalls = 0;
  for (const turn of turns) {
    let advanced = false;
    for (const call of turn.calls) {
      if (MUTATIONS.has(call.tool) && call.outcome === "success") {
        successfulMutations++;
        advanced = true;
      }
      const key = evidenceKey(call);
      if (key && !seen.has(key)) {
        seen.add(key);
        novelObservations++;
        advanced = true;
      }
    }
    if (advanced) {
      quietTurns = 0;
      trailingCalls = 0;
    } else if (turn.calls.length > 0) {
      quietTurns++;
      trailingCalls += turn.calls.length;
    }
  }
  return {
    stalled: quietTurns >= threshold && trailingCalls >= threshold && novelObservations > 0,
    reason: quietTurns >= threshold && trailingCalls >= threshold && novelObservations > 0 ? "REPEATED_EVIDENCE" : null,
    quietTurns,
    threshold,
    novelObservations,
    successfulMutations,
  };
}
