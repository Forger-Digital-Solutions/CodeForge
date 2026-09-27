import type { PaidAutoCanonicalModelId } from "./registry.js";
import type { SixteenBitRoleQualification } from "./expected-cost.js";

/**
 * R48 — per-role qualification evidence for 16-Bit production routing.
 *
 * A canonical model that measured QUALIFIED for Coder is evidence only for Coder — the
 * verdict binds `${canonicalModelId} × role`. Verdicts carry measurement provenance and
 * expire: a stale result is not a current qualification, and absent evidence is honestly
 * NOT_TESTED rather than assumed competent.
 */

export type PaidRoleStatus = "QUALIFIED" | "PROBATION" | "NOT_QUALIFIED" | "HARD_FAILURE";

/**
 * `paid-auto/auto` — the model id a run selects to ask for per-role paid routing. It is
 * never dispatched itself: the role router resolves it to a qualified canonical model
 * before the first request, and rotation stays inside the qualified paid roster. This is
 * NOT OpenRouter's `openrouter/auto` router — no unknown-cost substitution is possible;
 * only registered canonical models can be selected.
 */
export const PAID_AUTO_AUTO_MODEL_ID = "auto";

export interface PaidRoleVerdict {
  readonly canonicalModelId: PaidAutoCanonicalModelId;
  /** Role the verdict applies to — normalized to the uppercase capability vocabulary
   *  (EXPLORER/PLANNER/CODER/REVIEWER/TOOL_AGENT/ANALYST) on store entry. */
  readonly role: string;
  readonly status: PaidRoleStatus;
  /** ISO timestamp of the measurement. */
  readonly measuredAt: string;
  /** Provenance — the qualification suite/receipt this verdict was measured by. */
  readonly source: string;
}

/** Thirty days — the same freshness window the free fleet's role receipts use. */
export const PAID_ROLE_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ROLE_ALIASES: Record<string, string> = {
  TOOLAGENT: "TOOL_AGENT",
  TOOL_AGENT: "TOOL_AGENT",
  SUBAGENT: "TOOL_AGENT",
};

export function normalizePaidRole(role: string): string {
  const upper = role.trim().toUpperCase().replace(/[\s-]/g, "_");
  return ROLE_ALIASES[upper] ?? upper;
}

/**
 * In-memory verdict book, optionally seeded from persisted qualification receipts. The
 * newest verdict per (model, role) wins; an expired verdict reverts to unmeasured rather
 * than silently keeping its old answer.
 */
export class PaidRoleEvidenceBook {
  private readonly verdicts = new Map<string, PaidRoleVerdict>();

  constructor(seed: readonly PaidRoleVerdict[] = []) {
    for (const verdict of seed) this.record(verdict);
  }

  record(verdict: PaidRoleVerdict): void {
    const key = `${verdict.canonicalModelId}:${normalizePaidRole(verdict.role)}`;
    const existing = this.verdicts.get(key);
    if (existing === undefined || existing.measuredAt <= verdict.measuredAt) {
      this.verdicts.set(key, { ...verdict, role: normalizePaidRole(verdict.role) });
    }
  }

  /**
   * The current verdict for (model, role): QUALIFIED/PROBATION/NOT_QUALIFIED/HARD_FAILURE
   * when measured inside the freshness window, STALE when the only measurement expired,
   * NOT_TESTED when none exists. The floor treats the last two as absent evidence —
   * admissible only below measured tiers, never above.
   */
  verdictFor(canonicalModelId: PaidAutoCanonicalModelId, role: string, now: number, maxAgeMs = PAID_ROLE_EVIDENCE_MAX_AGE_MS): SixteenBitRoleQualification {
    const verdict = this.verdicts.get(`${canonicalModelId}:${normalizePaidRole(role)}`);
    if (verdict === undefined) return "NOT_TESTED";
    const age = now - Date.parse(verdict.measuredAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return "STALE";
    return verdict.status;
  }

  entries(): readonly PaidRoleVerdict[] {
    return [...this.verdicts.values()];
  }
}
