import { describe, expect, it } from "vitest";
import {
  EightBitRouteHealthAuthority,
  DEFAULT_ROUTE_HEALTH_POLICY,
  createEightBitRouteHealthAuthority,
} from "../src/route-health-authority.js";

/**
 * R50 — runtime quality authority: canonical role outcomes, bounded per-role graded evidence,
 * capacity/quality separation, dedup, persistence, decay/recovery.
 *
 * The invariant under test: model-quality failures demote a route FOR THE ROLE that failed,
 * provider/supply failures never create role evidence, and positive work gradually restores
 * standing — all inside the same authority that already owns health conditions.
 */

const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const NEMOTRON = { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free" };
const GROQ = { providerId: "groq", modelId: "openai/gpt-oss-120b" };

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

describe("R50 — canonical role outcomes", () => {
  it("security_blocked sets role-scoped CAPABILITY_LIMITED at high confidence — and other roles are untouched", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "REVIEWER", outcome: "security_blocked", failureClass: "WORKSPACE_ESCAPE_ATTEMPT", correlationId: "run-1" });
    const reviewer = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "REVIEWER" });
    expect(reviewer.state).toBe("CAPABILITY_LIMITED");
    expect(reviewer.confidence).toBeGreaterThanOrEqual(0.8);
    expect(reviewer.reasonCodes.some((c) => c.includes("WORKSPACE_ESCAPE_ATTEMPT"))).toBe(true);
    // Role isolation: the same route is unpenalized as CODER.
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" }).state).not.toBe("CAPABILITY_LIMITED");
  });

  it("budget_exhausted marks CAPABILITY_LIMITED (previously a dead outcome kind)", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "EXPLORER", outcome: "budget_exhausted", failureClass: "NON_CONVERGENCE", correlationId: "run-2" });
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "EXPLORER" }).state).toBe("CAPABILITY_LIMITED");
  });

  it("converged produces positive evidence but never mutates conditions", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "CODER", outcome: "converged", correlationId: "run-3" });
    const delta = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", T0);
    expect(delta.scoreAdjustment).toBeGreaterThan(0);
    expect(delta.reasonCodes).toContain("ROLE_RUNTIME_POSITIVE");
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" }).state).not.toBe("CAPABILITY_LIMITED");
  });
});

describe("R50 — capacity failures never become model-quality penalties", () => {
  it("rate limits and capacity blips leave zero role evidence and no CAPABILITY_LIMITED", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(T0), source: "runtime", reason: "RATE_LIMITED", status: 429, role: "CODER" });
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(T0 + 1000), source: "runtime", reason: "TEMPORARY_CAPACITY", status: 502, role: "CODER" });
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(T0 + 2000), source: "runtime", reason: "TRANSIENT_NETWORK", role: "CODER" });
    const delta = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", T0 + 3000);
    expect(delta.samples).toBe(0);
    expect(delta.scoreAdjustment).toBe(0);
    expect(delta.reasonCodes).toContain("ROLE_RUNTIME_EVIDENCE_ABSENT");
    // Supply failures still produce supply conditions — just never capability evidence.
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" }).state).not.toBe("CAPABILITY_LIMITED");
  });

  it("model-quality failures produce role evidence but never fabricate a rate-limit/quota condition", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...GROQ, observedAt: iso(T0), source: "runtime", role: "CODER", outcome: "role_failed", failureClass: "REPETITION_LOOP", correlationId: "run-4" });
    const a = authority.assess(GROQ.providerId, GROQ.modelId, { role: "CODER" });
    expect(a.activeConditions.every((c) => c.state !== "RATE_LIMITED" && c.state !== "DAILY_QUOTA_EXHAUSTED" && c.state !== "SATURATED")).toBe(true);
  });
});

describe("R50 — bounded graded evidence", () => {
  it("one failure is a small signal; repeated failures saturate the bound", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", role: "REVIEWER", outcome: "role_failed", correlationId: "run-a" });
    const single = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", c.now());
    expect(single.scoreAdjustment).toBeLessThan(0);
    expect(single.scoreAdjustment).toBeGreaterThanOrEqual(-4); // one bad run ≠ blacklist
    for (let i = 1; i <= 6; i += 1) {
      authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now() + i * 60_000), source: "runtime", role: "REVIEWER", outcome: "role_failed", failureClass: "NON_CONVERGENCE", correlationId: `run-a${i}` });
    }
    const repeated = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", c.now() + 7 * 60_000);
    expect(repeated.scoreAdjustment).toBeLessThanOrEqual(-12); // strong demotion
    expect(repeated.scoreAdjustment).toBeGreaterThanOrEqual(-16); // bounded
  });

  it("role isolation: failures as REVIEWER never demote the route as CODER", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    for (let i = 0; i < 6; i += 1) {
      authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0 + i * 1000), source: "runtime", role: "REVIEWER", outcome: "role_failed", correlationId: `rev-${i}` });
    }
    expect(authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", T0 + 7000).scoreAdjustment).toBeLessThan(0);
    expect(authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", T0 + 7000).scoreAdjustment).toBe(0);
  });

  it("verified work gradually recovers standing after failures", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    for (let i = 0; i < 4; i += 1) {
      authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now() + i * 1000), source: "runtime", role: "CODER", outcome: "role_failed", correlationId: `f-${i}` });
    }
    const bad = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", c.now() + 5000);
    expect(bad.scoreAdjustment).toBeLessThan(0);
    for (let i = 0; i < 6; i += 1) {
      c.advance(1000);
      authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", role: "CODER", outcome: "verified_complete", correlationId: `ok-${i}` });
    }
    const recovered = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", c.now());
    expect(recovered.scoreAdjustment).toBeGreaterThan(0);
  });

  it("evidence decays with age — a stale failure weighs less than a fresh one", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", role: "CODER", outcome: "role_failed", correlationId: "old-1" });
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", role: "CODER", outcome: "role_failed", correlationId: "old-2" });
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", role: "CODER", outcome: "role_failed", correlationId: "old-3" });
    const fresh = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", c.now());
    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.windowMs * 0.8);
    const stale = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", c.now());
    expect(Math.abs(stale.scoreAdjustment)).toBeLessThan(Math.abs(fresh.scoreAdjustment));
  });

  it("cold start: no runtime evidence is neutral, not a penalty", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const delta = authority.roleQualityDelta(GROQ.providerId, GROQ.modelId, "CODER", T0);
    expect(delta.scoreAdjustment).toBe(0);
    expect(delta.samples).toBe(0);
  });

  it("severity grading: a workspace escape weighs more than an empty completion", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "REVIEWER", outcome: "security_blocked", failureClass: "WORKSPACE_ESCAPE_ATTEMPT", correlationId: "s-1" });
    authority.observe({ kind: "role_outcome", ...GROQ, observedAt: iso(T0), source: "runtime", role: "REVIEWER", outcome: "role_failed", failureClass: "EMPTY_COMPLETION", correlationId: "s-2" });
    const severe = authority.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", T0);
    const mild = authority.roleQualityDelta(GROQ.providerId, GROQ.modelId, "REVIEWER", T0);
    expect(severe.scoreAdjustment).toBeLessThan(mild.scoreAdjustment);
  });
});

describe("R50 — dedup and persistence", () => {
  it("a replayed outcome with the same correlationId counts exactly once", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const obs = { kind: "role_outcome" as const, ...NEMOTRON, observedAt: iso(T0), source: "runtime" as const, role: "CODER" as const, outcome: "role_failed" as const, correlationId: "dup-1" };
    authority.observe(obs);
    authority.observe(obs);
    authority.observe({ ...obs, observedAt: iso(T0 + 5000) }); // replayed later — still one event
    const evidence = authority.roleEvidenceFor(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", T0 + 6000);
    expect(evidence).toHaveLength(1);
  });

  it("distinct outcomes for the same run are not deduped against each other", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "CODER", outcome: "verification_failed", correlationId: "run-x" });
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0 + 100), source: "runtime", role: "CODER", outcome: "verified_complete", correlationId: "run-x" });
    expect(authority.roleEvidenceFor(NEMOTRON.providerId, NEMOTRON.modelId, "CODER", T0 + 200)).toHaveLength(2);
  });

  it("role evidence survives snapshot → hydrate (restart durability)", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "REVIEWER", outcome: "security_blocked", failureClass: "WORKSPACE_ESCAPE_ATTEMPT", correlationId: "run-p" });
    const snapshot = authority.snapshot(T0).find((s) => s.providerId === NEMOTRON.providerId);
    expect(snapshot?.roleEvidence?.length).toBe(1);

    const restored = createEightBitRouteHealthAuthority({}, () => T0 + 60_000);
    restored.hydrate(snapshot!);
    const delta = restored.roleQualityDelta(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", T0 + 60_000);
    expect(delta.samples).toBe(1);
    expect(delta.scoreAdjustment).toBeLessThan(0);
    // Hydrated dedup keys still suppress a replay of the same event.
    restored.observe({ kind: "role_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", role: "REVIEWER", outcome: "security_blocked", failureClass: "WORKSPACE_ESCAPE_ATTEMPT", correlationId: "run-p" });
    expect(restored.roleEvidenceFor(NEMOTRON.providerId, NEMOTRON.modelId, "REVIEWER", T0 + 60_000)).toHaveLength(1);
  });
});

describe("R50 — boundary violations in the tool ledger", () => {
  it("two consecutive boundary violations quarantine where four malformed calls would", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "tool_outcome", ...NEMOTRON, observedAt: iso(T0), source: "runtime", outcome: "boundary_violation", role: "REVIEWER" });
    authority.observe({ kind: "tool_outcome", ...NEMOTRON, observedAt: iso(T0 + 1000), source: "runtime", outcome: "boundary_violation", role: "REVIEWER" });
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "REVIEWER" }).state).toBe("QUARANTINED");
    // Same route, only formatting slips on a second model: not quarantined until four.
    authority.observe({ kind: "tool_outcome", ...GROQ, observedAt: iso(T0), source: "runtime", outcome: "malformed", role: "CODER" });
    authority.observe({ kind: "tool_outcome", ...GROQ, observedAt: iso(T0 + 1000), source: "runtime", outcome: "malformed", role: "CODER" });
    expect(authority.assess(GROQ.providerId, GROQ.modelId, { role: "CODER" }).state).not.toBe("QUARANTINED");
  });
});
