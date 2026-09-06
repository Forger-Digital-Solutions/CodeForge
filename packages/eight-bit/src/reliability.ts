import { routeKeyOf, type ReliabilityScore, type ReliabilitySample } from "./types.js";

export type ToolCallOutcome =
  | "valid"
  | "malformed"
  | "unknown_tool"
  | "missing_args"
  | "schema_violation"
  | "structured_output_failure";

/** Minimum attempts before a reliability score is trusted enough to gate eligibility. Below
 * this, the model is an explicit unknown and gets the benefit of the doubt (never auto-failed
 * for lack of data — only for observed failure). */
const MIN_SAMPLES_FOR_GATE = 5;
/** Consecutive malformed/schema-violation calls that trigger quarantine regardless of the
 * overall rolling score, so a model that goes bad recently is not protected by old good history. */
const QUARANTINE_STREAK = 4;
/** Bounded rolling window per route so long sessions cannot grow this unbounded. */
const WINDOW_SIZE = 50;

interface RouteReliabilityState {
  window: ToolCallOutcome[];
  consecutiveBad: number;
  quarantined: boolean;
}

function emptySample(): ReliabilitySample {
  return { attempts: 0, validCalls: 0, malformedCalls: 0, unknownToolCalls: 0, missingArgCalls: 0, schemaViolations: 0, structuredOutputFailures: 0 };
}

/**
 * Live per-route tool-call reliability tracking (the audited gap: `toolReliability` existed
 * only as an offline-certified schema field with no production feedback loop). This tracker
 * hooks into real tool-call parse/execution outcomes; it never blocks anything by itself — its
 * output feeds `EightBitEligibilityPolicy` as a hard gate once enough samples exist.
 */
export class EightBitReliabilityTracker {
  private readonly routes = new Map<string, RouteReliabilityState>();

  record(providerId: string, modelId: string, outcome: ToolCallOutcome): void {
    const key = routeKeyOf(providerId, modelId);
    const state = this.routes.get(key) ?? { window: [], consecutiveBad: 0, quarantined: false };
    state.window.push(outcome);
    if (state.window.length > WINDOW_SIZE) state.window.shift();
    if (outcome === "valid") {
      state.consecutiveBad = 0;
    } else {
      state.consecutiveBad += 1;
      if (state.consecutiveBad >= QUARANTINE_STREAK) state.quarantined = true;
    }
    this.routes.set(key, state);
  }

  /** Explicit recovery path: a manual override or catalog refresh can lift a quarantine. 8-Bit
   * never lifts it silently just because time passed — that would defeat the purpose. */
  clearQuarantine(providerId: string, modelId: string): void {
    const key = routeKeyOf(providerId, modelId);
    const state = this.routes.get(key);
    if (state) {
      state.quarantined = false;
      state.consecutiveBad = 0;
    }
  }

  sample(providerId: string, modelId: string): ReliabilitySample {
    const state = this.routes.get(routeKeyOf(providerId, modelId));
    const sample = emptySample();
    if (!state) return sample;
    for (const outcome of state.window) {
      sample.attempts++;
      switch (outcome) {
        case "valid":
          sample.validCalls++;
          break;
        case "malformed":
          sample.malformedCalls++;
          break;
        case "unknown_tool":
          sample.unknownToolCalls++;
          break;
        case "missing_args":
          sample.missingArgCalls++;
          break;
        case "schema_violation":
          sample.schemaViolations++;
          break;
        case "structured_output_failure":
          sample.structuredOutputFailures++;
          break;
      }
    }
    return sample;
  }

  score(providerId: string, modelId: string): ReliabilityScore {
    const key = routeKeyOf(providerId, modelId);
    const state = this.routes.get(key);
    const sample = this.sample(providerId, modelId);
    const quarantined = state?.quarantined ?? false;
    if (sample.attempts < MIN_SAMPLES_FOR_GATE) {
      return { score: undefined, sampleSize: sample.attempts, demoted: false, quarantined };
    }
    const score = sample.validCalls / sample.attempts;
    return { score, sampleSize: sample.attempts, demoted: score < 0.8, quarantined };
  }
}

export function createEightBitReliabilityTracker(): EightBitReliabilityTracker {
  return new EightBitReliabilityTracker();
}
