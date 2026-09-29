import { createHash } from "node:crypto";

export interface StrategyObservation {
  targetFiles: readonly string[];
  failureCodes: readonly string[];
  stateDigest: string;
  transient?: boolean;
}

export type RetryNovelty = "NOVEL_STRATEGY" | "MATERIAL_NEW_EVIDENCE" | "SAME_STRATEGY_ALLOWED_TRANSIENT" | "LOW_NOVELTY_RETRY" | "STRATEGY_EXHAUSTED";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Observable files and failure codes only. The fingerprint retains no source or reasoning. */
export function strategyFingerprint(observation: StrategyObservation): { strategy: string; failure: string; state: string } {
  return {
    strategy: hash([...new Set(observation.targetFiles)].sort().join("\n")),
    failure: hash([...new Set(observation.failureCodes)].sort().join("\n")),
    state: observation.stateDigest,
  };
}

export function classifyRetryNovelty(history: readonly StrategyObservation[], proposed: StrategyObservation): RetryNovelty {
  if (proposed.transient) return "SAME_STRATEGY_ALLOWED_TRANSIENT";
  if (history.length === 0) return "NOVEL_STRATEGY";
  const current = strategyFingerprint(proposed);
  const previous = strategyFingerprint(history[history.length - 1]!);
  if (current.strategy !== previous.strategy) return "NOVEL_STRATEGY";
  if (current.failure !== previous.failure) return "MATERIAL_NEW_EVIDENCE";
  // A different patch against the same files with the same failing acceptance signal is
  // activity, not evidence that the causal strategy improved.
  const repeats = history.filter((entry) => {
    const prior = strategyFingerprint(entry);
    return !entry.transient && prior.strategy === current.strategy && prior.failure === current.failure;
  }).length;
  return repeats >= 2 ? "STRATEGY_EXHAUSTED" : "LOW_NOVELTY_RETRY";
}
