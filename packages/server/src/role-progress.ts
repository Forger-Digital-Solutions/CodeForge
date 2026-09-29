export interface ProgressToolCall {
  tool: string;
  target?: string;
  outcome: "success" | "failed" | "denied" | "suppressed";
  requestHash?: string;
  observationHash?: string;
}

export interface ProgressTurn {
  turn: number;
  calls: readonly ProgressToolCall[];
}

export interface RoleProgressAssessment {
  stalled: boolean;
  reason: "REPEATED_EVIDENCE" | "REPEATED_EDIT_FAILURE" | null;
  quietTurns: number;
  threshold: number;
  novelObservations: number;
  successfulMutations: number;
  repeatedEditFailures: number;
}

const MUTATIONS = new Set(["edit_file", "write_file"]);

/** Count distinct observable effects, never model turns or repeated tool activity. The
 * existing role trace is bounded by the model/tool budgets and carries hashes, not content. */
export function countUsefulProgress(turns: readonly ProgressTurn[]): number {
  const effects = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.outcome !== "success" || !call.observationHash) continue;
      if (MUTATIONS.has(call.tool)) {
        if (call.requestHash) effects.add(`edit:${call.tool}:${call.target ?? ""}:${call.requestHash}:${call.observationHash}`);
      } else {
        const key = evidenceKey(call);
        if (key) effects.add(key);
      }
    }
  }
  return effects.size;
}

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
  const failedEdits = new Map<string, { key: string; count: number }>();
  const readStates = new Map<string, string>();
  for (const turn of turns) {
    let advanced = false;
    for (const call of turn.calls) {
      if (call.tool === "read_file" && call.target && call.outcome === "success" && call.observationHash) {
        const previous = readStates.get(call.target);
        if (previous && previous !== call.observationHash) failedEdits.delete(call.target);
        readStates.set(call.target, call.observationHash);
      }
      if (MUTATIONS.has(call.tool) && call.outcome === "success") {
        successfulMutations++;
        advanced = true;
        if (call.target) failedEdits.delete(call.target);
      } else if (MUTATIONS.has(call.tool) && call.outcome === "failed" && call.target && call.requestHash && call.observationHash) {
        const key = `${call.tool}:${call.requestHash}:${call.observationHash}`;
        const current = failedEdits.get(call.target);
        const count = current?.key === key ? current.count + 1 : 1;
        failedEdits.set(call.target, { key, count });
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
  const repeatedEditFailures = Math.max(0, ...Array.from(failedEdits.values(), (entry) => entry.count));
  return {
    stalled: repeatedEditFailures >= 3 || (quietTurns >= threshold && trailingCalls >= threshold && novelObservations > 0),
    reason: repeatedEditFailures >= 3 ? "REPEATED_EDIT_FAILURE" : quietTurns >= threshold && trailingCalls >= threshold && novelObservations > 0 ? "REPEATED_EVIDENCE" : null,
    quietTurns,
    threshold,
    novelObservations,
    successfulMutations,
    repeatedEditFailures,
  };
}
