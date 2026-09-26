/**
 * R42 selective ForgeGreen run policy.
 *
 * The static `efficiencyControls` ceiling answers "is this mechanism available at all" (the
 * A/B arm switch). This policy answers a different question: "is optimization safe and useful
 * for THIS run, right now". It resolves a per-run level from request signals, then escalates
 * monotonically toward baseline behavior on quality-risk signals — never the reverse.
 *
 * Levels:
 * - FULL: every available control may act (state-bound duplicate replay, dispatch-time
 *   superseded compaction, bounded tool-output compression, model-request dedup including
 *   completed-response replay).
 * - CONSERVATIVE: compression and compaction stay on (both are provably non-destructive —
 *   the durable transcript keeps the authoritative bytes), but a duplicate read executes
 *   instead of replaying, and a completed model response is never replayed. The classifier
 *   still runs so the no-progress bound survives.
 * - OFF: baseline behavior, identical to a disabled arm.
 */
export type ForgeGreenLevel = "OFF" | "CONSERVATIVE" | "FULL";

export type ForgeGreenControl = "duplicateSuppression" | "toolOutputCompression" | "supersededCompaction";

export type ForgeGreenEscalationSignal =
  | "provider_failover"
  | "model_response_unusable"
  | "output_truncated"
  | "content_filter"
  | "no_effect_write"
  | "verification_feedback";

export interface ForgeGreenRunSignals {
  role: string;
  workstreamScope?: string;
  taskPlan?: string;
  reviewFeedback?: string;
  verificationEvidence?: string;
  resumeJournal?: unknown;
}

export interface ForgeGreenPolicyEscalation {
  signal: ForgeGreenEscalationSignal;
  from: ForgeGreenLevel;
  to: ForgeGreenLevel;
  detail: string;
}

export interface ForgeGreenPolicySnapshot {
  initialLevel: ForgeGreenLevel;
  level: ForgeGreenLevel;
  initialReasonCodes: string[];
  escalations: ForgeGreenPolicyEscalation[];
  /** Duplicate actions whose replay the conservative policy prevented (the read ran anyway). */
  preventedReplays: number;
}

const LEVEL_RANK: Record<ForgeGreenLevel, number> = { OFF: 0, CONSERVATIVE: 1, FULL: 2 };

/**
 * Runs that inherit evidence or share mutable state get CONSERVATIVE: a replayed read or a
 * replayed completed response is the one optimization that can serve semantically stale
 * content (a sibling workstream's write, a pre-repair observation) without this run's state
 * version ever noticing. Fresh single-context runs keep FULL — the R39/R40 corpus showed the
 * savings concentrate exactly there.
 */
export function initialForgeGreenLevel(signals: ForgeGreenRunSignals): { level: ForgeGreenLevel; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  if (signals.resumeJournal) reasonCodes.push("RESUMED_TRANSCRIPT");
  if (signals.reviewFeedback || signals.verificationEvidence) reasonCodes.push("REPAIR_OR_REVIEW_EVIDENCE");
  if (signals.role.toLowerCase() === "reviewer") reasonCodes.push("REVIEW_EVIDENCE_FIDELITY");
  if (signals.workstreamScope !== undefined) reasonCodes.push("WORKSTREAM_SHARED_STATE");
  if (signals.taskPlan) reasonCodes.push("COORDINATED_MULTI_STEP");
  return reasonCodes.length > 0
    ? { level: "CONSERVATIVE", reasonCodes }
    : { level: "FULL", reasonCodes: ["NO_INHERITED_EVIDENCE"] };
}

export class ForgeGreenRunPolicy {
  private level: ForgeGreenLevel;
  private readonly escalations: ForgeGreenPolicyEscalation[] = [];
  private preventedReplays = 0;

  constructor(
    private readonly initial: { level: ForgeGreenLevel; reasonCodes: string[] },
    private readonly ceiling: Record<ForgeGreenControl, boolean>,
  ) {
    this.level = initial.level;
  }

  static forRun(signals: ForgeGreenRunSignals, ceiling: Record<ForgeGreenControl, boolean>, forcedLevel?: ForgeGreenLevel): ForgeGreenRunPolicy {
    const initial = forcedLevel
      ? { level: forcedLevel, reasonCodes: ["FORCED_LEVEL_BENCHMARK_ARM"] }
      : initialForgeGreenLevel(signals);
    return new ForgeGreenRunPolicy(initial, ceiling);
  }

  get currentLevel(): ForgeGreenLevel {
    return this.level;
  }

  /** Monotonic downgrade only — a run can never re-enable optimization mid-flight. */
  escalate(signal: ForgeGreenEscalationSignal, detail: string): ForgeGreenLevel {
    if (this.level === "OFF") return this.level;
    const to: ForgeGreenLevel = this.level === "FULL" ? "CONSERVATIVE" : "OFF";
    this.escalations.push({ signal, from: this.level, to, detail });
    this.level = to;
    return this.level;
  }

  /**
   * Whether the duplicate classifier should run at all. OFF matches the disabled arm exactly;
   * anything above keeps the classifier because its no-progress bound is a safety mechanism,
   * not an optimization.
   */
  runsDuplicateClassifier(): boolean {
    return this.ceiling.duplicateSuppression && this.level !== "OFF";
  }

  /** Whether a classified duplicate may replay its prior output instead of executing. */
  replaysDuplicates(): boolean {
    return this.ceiling.duplicateSuppression && this.level === "FULL";
  }

  compressesToolOutput(): boolean {
    return this.ceiling.toolOutputCompression && this.level !== "OFF";
  }

  compactsSuperseded(): boolean {
    return this.ceiling.supersededCompaction && this.level !== "OFF";
  }

  /**
   * Model-request dedup mode. Completed-response replay only at FULL: a completed answer is
   * safe to join only while the run has seen no quality-risk signal, because an identical
   * retry after a bad answer must re-execute rather than replay it.
   */
  modelDedupeMode(): "off" | "inflight" | "full" {
    if (!this.ceiling.duplicateSuppression || this.level === "OFF") return "off";
    return this.level === "CONSERVATIVE" ? "inflight" : "full";
  }

  /**
   * Epoch folded into the model-request dedupe key. Every escalation bumps it, so a response
   * cached before a quality-risk signal can never be replayed to a retry issued after it.
   */
  dedupeEpoch(): number {
    return this.escalations.length;
  }

  notePreventedReplay(): void {
    this.preventedReplays++;
  }

  snapshot(): ForgeGreenPolicySnapshot {
    return {
      initialLevel: this.initial.level,
      level: this.level,
      initialReasonCodes: [...this.initial.reasonCodes],
      escalations: [...this.escalations],
      preventedReplays: this.preventedReplays,
    };
  }

  toJSON(): ForgeGreenPolicySnapshot {
    return this.snapshot();
  }
}
