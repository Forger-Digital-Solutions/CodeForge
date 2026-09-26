import { beforeEach, describe, expect, it } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import {
  EightBitRouteHealthAuthority,
  DEFAULT_ROUTE_HEALTH_POLICY,
  createEightBitRouteHealthAuthority,
  rateLimitObservationFromHeaders,
  userFacingRouteStatus,
  routingExplanation,
  type NormalizedObservation,
} from "../src/route-health-authority.js";
import { EightBitRouteHealthLedger } from "../src/route-health-ledger.js";
import { EightBitHealthTracker } from "../src/health.js";
import { EightBitReliabilityTracker } from "../src/reliability.js";
import { EightBitRouter, type BindingScope } from "../src/router.js";
import { EightBitRuntime } from "../src/runtime.js";
import { makeModel } from "./fixtures.js";

const T0 = Date.parse("2026-09-21T14:43:00.000Z");
const NEMOTRON = { providerId: "openrouter", modelId: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" };
const GROQ20B = { providerId: "groq", modelId: "openai/gpt-oss-20b" };

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; }, set: (t: number) => { now = t; } };
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

const SATURATION_MESSAGE = "OpenRouter stream error (502): Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)";

describe("EightBitRouteHealthAuthority — temporal health (§6, §7)", () => {
  it("[R23 F3 replay] nemotron: gate OPEN at 14:43 → SATURATED at 14:45 → decays after the saturation TTL", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    // Two served production-shaped probes (the real 14:43Z gate).
    authority.observe({ kind: "probe_gate", ...NEMOTRON, observedAt: iso(c.now()), source: "probe", requestShape: "production", served: true, latencyMs: 2556, toolCalls: 1 });
    authority.observe({ kind: "probe_gate", ...NEMOTRON, observedAt: iso(c.now() + 10_000), source: "probe", requestShape: "production", served: true, latencyMs: 1722, toolCalls: 1 });
    let a = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" });
    expect(a.state).toBe("HEALTHY");
    expect(a.hardExclude).toBe(false);
    expect(a.scoreAdjustment).toBeGreaterThan(0);

    // ~2 minutes later the shared NVIDIA worker saturates: four in-band 502 ResourceExhausted.
    c.advance(2 * 60_000);
    for (let i = 0; i < 4; i += 1) {
      authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now() + i * 3_000), source: "runtime", reason: "TEMPORARY_CAPACITY", status: 502, message: SATURATION_MESSAGE, role: "CODER" });
    }
    a = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" });
    expect(a.state).toBe("SATURATED");
    expect(a.hardExclude).toBe(false);
    expect(a.scoreAdjustment).toBeLessThanOrEqual(-40);
    expect(a.reasonCodes[0]).toBe("SATURATED:SHARED_CAPACITY_SATURATED");
    expect(a.expiresAt).toBeGreaterThan(c.now());
    expect(a.resetEstimate).toBeDefined();

    // Confidence decays toward expiry; after the TTL the condition is gone (no permanent label).
    const midway = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER", now: c.now() + DEFAULT_ROUTE_HEALTH_POLICY.saturationTtlMs / 2 + 9_000 });
    expect(midway.state).toBe("SATURATED");
    expect(midway.confidence).toBeLessThan(a.confidence);
    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.saturationTtlMs + 10_000);
    const after = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER" });
    expect(after.state).not.toBe("SATURATED");
    // The saturation label is gone, but the rolling window (4 failures, 2 successes in the last
    // hour) still reads DEGRADED — a decayed, evidence-backed penalty, not a permanent label.
    expect(after.state).toBe("DEGRADED");
    expect(after.hardExclude).toBe(false);
    expect(Math.abs(after.scoreAdjustment)).toBeLessThan(Math.abs(a.scoreAdjustment));
    // Once the whole window has aged out, only "evidence expired" remains.
    const stale = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId, { role: "CODER", now: c.now() + DEFAULT_ROUTE_HEALTH_POLICY.windowMs + DEFAULT_ROUTE_HEALTH_POLICY.healthyTtlMs });
    expect(stale.reasonCodes).toContain("EVIDENCE_EXPIRED");
  });

  it("[PASS] a served production call clears saturation immediately (positive evidence beats a stale negative label)", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", reason: "TEMPORARY_CAPACITY", message: SATURATION_MESSAGE });
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId).state).toBe("SATURATED");
    c.advance(30_000);
    authority.observe({ kind: "call_success", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", latencyMs: 1_900, requestShape: "production" });
    const a = authority.assess(NEMOTRON.providerId, NEMOTRON.modelId);
    expect(a.state).toBe("HEALTHY");
  });

  it("[PASS] a bare probe success does NOT clear saturation (bare probes were non-predictive in R23)", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", reason: "TEMPORARY_CAPACITY", message: SATURATION_MESSAGE });
    authority.observe({ kind: "probe_gate", ...NEMOTRON, observedAt: iso(c.now() + 5_000), source: "probe", requestShape: "bare", served: true, latencyMs: 400 });
    expect(authority.assess(NEMOTRON.providerId, NEMOTRON.modelId).state).toBe("SATURATED");
  });
});

describe("EightBitRouteHealthAuthority — permanent conditions (§8)", () => {
  it("[R23 replay] GitHub Models 410 → MODEL_RETIRED forever; probes are never spent; a catalog refresh listing it again clears it", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const route = { providerId: "github-models", modelId: "openai/gpt-4o-mini" };
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(c.now()), source: "runtime", reason: "MODEL_RETIRED", status: 410, message: "github-models error (410): Gone" });
    const a = authority.assess(route.providerId, route.modelId);
    expect(a.state).toBe("MODEL_RETIRED");
    expect(a.hardExclude).toBe(true);
    expect(a.expiresAt).toBeUndefined();
    c.advance(30 * 24 * 60 * 60_000);
    expect(authority.assess(route.providerId, route.modelId).state).toBe("MODEL_RETIRED");
    const advice = authority.probeAdvice(route.providerId, route.modelId);
    expect(advice.shouldProbe).toBe(false);
    expect(advice.never).toBe(true);
    expect(advice.reasonCodes).toContain("PERMANENT_CONDITION_NO_PROBE");
    authority.observe({ kind: "catalog", ...route, observedAt: iso(c.now()), source: "registry", fact: "present" });
    expect(authority.assess(route.providerId, route.modelId).state).not.toBe("MODEL_RETIRED");
  });

  it("[R23 replay] inkling 403 'only available on agentic harnesses' → ACCESS_RESTRICTED, permanent, excluded", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const route = { providerId: "openrouter", modelId: "thinkingmachines/inkling:free" };
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(T0), source: "runtime", reason: "ACCESS_RESTRICTED", status: 403 });
    const a = authority.assess(route.providerId, route.modelId);
    expect(a.state).toBe("ACCESS_RESTRICTED");
    expect(a.hardExclude).toBe(true);
    expect(authority.probeAdvice(route.providerId, route.modelId).never).toBe(true);
    expect(userFacingRouteStatus(a.state)).toBe("Unavailable");
  });

  it("[R40/R41] Google CONSUMER_SUSPENDED → ACCESS_RESTRICTED: permanent hard exclusion, requalified only by a proven catalog change", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const route = { providerId: "google", modelId: "gemini-2.0-flash-exp" };
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(c.now()), source: "runtime", reason: "ACCESS_RESTRICTED", status: 403, message: 'google error (403): PERMISSION_DENIED {"reason":"CONSUMER_SUSPENDED"}', role: "REVIEWER" });
    const a = authority.assess(route.providerId, route.modelId, { role: "REVIEWER" });
    expect(a.state).toBe("ACCESS_RESTRICTED");
    expect(a.hardExclude).toBe(true);
    expect(authority.probeAdvice(route.providerId, route.modelId).never).toBe(true);
    // Permanent: time alone never requalifies a suspended consumer.
    c.advance(30 * 24 * 60 * 60_000);
    expect(authority.assess(route.providerId, route.modelId).hardExclude).toBe(true);
    // A routine catalog listing ("present") is not proof the suspension lifted — it clears
    // retirement facts only, so ACCESS_RESTRICTED survives an ordinary refresh.
    authority.observe({ kind: "catalog", ...route, observedAt: iso(c.now()), source: "registry", fact: "present" });
    expect(authority.assess(route.providerId, route.modelId).state).toBe("ACCESS_RESTRICTED");
    // A credential change cannot clear it either — this was never a credential fault.
    authority.credentialChanged(route.providerId, route.modelId);
    expect(authority.assess(route.providerId, route.modelId).state).toBe("ACCESS_RESTRICTED");
    // Only an explicit catalog change — the refresh verified the route is served again —
    // requalifies it, dropping the permanent exclusion to a low-confidence UNKNOWN.
    authority.catalogChanged(route.providerId, route.modelId, "CATALOG_REQUALIFIED");
    const after = authority.assess(route.providerId, route.modelId);
    expect(after.state).not.toBe("ACCESS_RESTRICTED");
    expect(after.hardExclude).toBe(false);
  });

  it("[R23 F6] Cloudflare plan attestation unreadable → BILLING_VERIFICATION_REQUIRED until an attestation clears it", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const route = { providerId: "cloudflare", modelId: "@cf/openai/gpt-oss-120b" };
    authority.observe({ kind: "catalog", ...route, observedAt: iso(T0), source: "registry", fact: "billing_unverifiable" });
    expect(authority.assess(route.providerId, route.modelId)).toMatchObject({ state: "BILLING_VERIFICATION_REQUIRED", hardExclude: true });
    expect(userFacingRouteStatus("BILLING_VERIFICATION_REQUIRED")).toBe("Needs authorization");
    authority.observe({ kind: "catalog", ...route, observedAt: iso(T0 + 1000), source: "registry", fact: "billing_verified" });
    expect(authority.assess(route.providerId, route.modelId).hardExclude).toBe(false);
  });
});

describe("EightBitRouteHealthAuthority — quota, rate limits, auth", () => {
  it("[R23 F14] Groq TPM 429 with retry-after → RATE_LIMITED for exactly that window, then lifts", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "call_failure", ...GROQ20B, observedAt: iso(c.now()), source: "runtime", reason: "RATE_LIMITED", status: 429, retryAfterMs: 2_000, message: "Rate limit reached for model openai/gpt-oss-20b on tokens per minute (TPM): Limit 8000, Used 5229. Please try again in 2s." });
    const a = authority.assess(GROQ20B.providerId, GROQ20B.modelId);
    expect(a.state).toBe("RATE_LIMITED");
    expect(a.hardExclude).toBe(true);
    expect(a.expiresAt).toBe(c.now() + 2_000);
    expect(authority.probeAdvice(GROQ20B.providerId, GROQ20B.modelId).reasonCodes).toContain("WAIT_FOR_RESET");
    c.advance(2_500);
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).hardExclude).toBe(false);
  });

  it("[PASS] a daily allowance at zero → DAILY_QUOTA_EXHAUSTED until the provider's reset time (not a one-minute cooldown)", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const resetAt = iso(c.now() + 5 * 60 * 60_000);
    authority.observe({ kind: "daily_allowance", ...GROQ20B, observedAt: iso(c.now()), source: "governor", unit: "tokens", limit: 200_000, remaining: 0, resetAt });
    const a = authority.assess(GROQ20B.providerId, GROQ20B.modelId);
    expect(a.state).toBe("DAILY_QUOTA_EXHAUSTED");
    expect(a.hardExclude).toBe(true);
    expect(a.resetEstimate).toBe(resetAt);
    expect(userFacingRouteStatus(a.state)).toBe("Daily free capacity used");
    c.advance(60 * 60_000);
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).state).toBe("DAILY_QUOTA_EXHAUSTED");
    c.advance(4 * 60 * 60_000 + 1000);
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).state).not.toBe("DAILY_QUOTA_EXHAUSTED");
    // A refreshed allowance clears it early.
    authority.observe({ kind: "daily_allowance", ...GROQ20B, observedAt: iso(c.now()), source: "governor", unit: "tokens", limit: 200_000, remaining: 150_000, resetAt: iso(c.now() + 86_400_000) });
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).hardExclude).toBe(false);
  });

  it("[PASS] rate-limit headers (Groq duration style) parse into a window observation and an exhausted window excludes the route", () => {
    const observedAt = T0;
    const obs = rateLimitObservationFromHeaders({
      ...GROQ20B,
      status: 200,
      observedAt,
      headers: [["x-ratelimit-limit-requests", "1000"], ["x-ratelimit-remaining-requests", "987"], ["x-ratelimit-reset-requests", "18m43.2s"], ["x-ratelimit-limit-tokens", "8000"], ["x-ratelimit-remaining-tokens", "0"], ["x-ratelimit-reset-tokens", "7.66s"]],
    });
    expect(obs).toBeDefined();
    expect(obs!.requestsRemaining).toBe(987);
    expect(obs!.tokensRemaining).toBe(0);
    expect(Date.parse(obs!.tokensResetAt!)).toBe(observedAt + 7_660);
    expect(Date.parse(obs!.requestsResetAt!)).toBe(observedAt + (18 * 60 + 43.2) * 1000);
    const authority = createEightBitRouteHealthAuthority({}, () => observedAt);
    authority.observe(obs!);
    const a = authority.assess(GROQ20B.providerId, GROQ20B.modelId);
    expect(a.state).toBe("RATE_LIMITED");
    expect(a.reasonCodes[0]).toBe("RATE_LIMITED:HEADER_WINDOW_EXHAUSTED");
    expect(a.expiresAt).toBe(observedAt + 7_660);
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId, { now: observedAt + 8_000 }).hardExclude).toBe(false);
  });

  it("[PASS] Mistral per-minute aliases parse — measured live on codestral-latest (124/125 req, 624,990/625,000 tok)", () => {
    const MISTRAL = { providerId: "mistral", modelId: "codestral-latest" };
    const obs = rateLimitObservationFromHeaders({
      ...MISTRAL,
      status: 200,
      observedAt: T0,
      headers: [
        ["x-ratelimit-limit-req-minute", "125"],
        ["x-ratelimit-remaining-req-minute", "124"],
        ["x-ratelimit-limit-tokens-minute", "625000"],
        ["x-ratelimit-remaining-tokens-minute", "624990"],
      ],
    });
    expect(obs).toBeDefined();
    expect(obs!.requestsRemaining).toBe(124);
    expect(obs!.requestsLimit).toBe(125);
    expect(obs!.tokensRemaining).toBe(624990);
    expect(obs!.tokensLimit).toBe(625000);
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe(obs!);
    expect(authority.assess(MISTRAL.providerId, MISTRAL.modelId).hardExclude).toBe(false);
  });

  it("[PASS] retry-after seconds and epoch resets are both understood; a header set with no quota facts yields no observation", () => {
    expect(rateLimitObservationFromHeaders({ ...GROQ20B, status: 200, observedAt: T0, headers: [["content-type", "application/json"]] })).toBeUndefined();
    const obs = rateLimitObservationFromHeaders({ ...GROQ20B, status: 429, observedAt: T0, headers: [["retry-after", "30"], ["x-ratelimit-reset", String(Math.floor(T0 / 1000) + 90)]] });
    expect(obs!.retryAfterMs).toBe(30_000);
    expect(Date.parse(obs!.requestsResetAt!)).toBe(Math.floor(T0 / 1000) * 1000 + 90_000);
  });

  it("[R1 §21] three consecutive auth failures → AUTH_REQUIRED (no automatic retry) until the credential changes", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const route = { providerId: "mistral", modelId: "mistral-small" };
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(c.now()), source: "runtime", reason: "AUTH_FAILURE", status: 403 });
    expect(authority.assess(route.providerId, route.modelId).state).toBe("DEGRADED");
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(c.now() + 1000), source: "runtime", reason: "AUTH_FAILURE", status: 403 });
    authority.observe({ kind: "call_failure", ...route, observedAt: iso(c.now() + 2000), source: "runtime", reason: "AUTH_FAILURE", status: 403 });
    const a = authority.assess(route.providerId, route.modelId);
    expect(a.state).toBe("AUTH_REQUIRED");
    expect(a.hardExclude).toBe(true);
    expect(userFacingRouteStatus(a.state)).toBe("Connection expired");
    expect(authority.probeAdvice(route.providerId, route.modelId).never).toBe(true);
    authority.credentialChanged(route.providerId);
    expect(authority.assess(route.providerId, route.modelId).hardExclude).toBe(false);
  });

  it("[PASS] user-connected entitlement facts map to USER_CONNECTION_REQUIRED / quota exhaustion and clear on connect", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const route = { providerId: "github-copilot", modelId: "gpt-4.1" };
    authority.observe({ kind: "entitlement", ...route, observedAt: iso(T0), source: "entitlement", fact: "connection_required" });
    expect(authority.assess(route.providerId, route.modelId)).toMatchObject({ state: "USER_CONNECTION_REQUIRED", hardExclude: true });
    expect(userFacingRouteStatus("USER_CONNECTION_REQUIRED")).toBe("Optional connection");
    authority.observe({ kind: "entitlement", ...route, observedAt: iso(T0 + 1000), source: "entitlement", fact: "connected" });
    expect(authority.assess(route.providerId, route.modelId).hardExclude).toBe(false);
    authority.observe({ kind: "entitlement", ...route, observedAt: iso(T0 + 2000), source: "entitlement", fact: "overage_blocked", resetAt: iso(T0 + 3_600_000) });
    const a = authority.assess(route.providerId, route.modelId);
    expect(a.state).toBe("DAILY_QUOTA_EXHAUSTED");
    expect(a.reasonCodes[0]).toBe("DAILY_QUOTA_EXHAUSTED:ENTITLEMENT_OVERAGE_BLOCKED");
  });
});

describe("EightBitRouteHealthAuthority — role-specific reliability (§10, §35)", () => {
  function feedGroqRound4(authority: EightBitRouteHealthAuthority, at: number): void {
    // R23 round 4: 41 calls, 4 in-band Groq rejections (9.8%) — served everything else.
    for (let i = 0; i < 37; i += 1) {
      authority.observe({ kind: "call_success", ...GROQ20B, observedAt: iso(at + i * 10_000), source: "runtime", latencyMs: 700, role: "CODER" });
      authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(at + i * 10_000), source: "runtime", outcome: "valid", role: "CODER" });
    }
    // The four rejections were spread across the round (calls 5, 14, 27, 38) — never a streak.
    for (let i = 0; i < 4; i += 1) {
      authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(at + 400_000 + i * 10_000), source: "runtime", outcome: i % 2 === 0 ? "unknown_tool" : "malformed", role: "CODER" });
      authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(at + 400_000 + i * 10_000 + 5_000), source: "runtime", outcome: "valid", role: "CODER" });
    }
  }

  it("[R23 round-4 replay] gpt-oss-20b at ~10% malformed tool calls is TOOL_UNRELIABLE for CODER but only mildly penalised for a read-only EXPLORER-class role", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    feedGroqRound4(authority, c.now());
    c.advance(500_000);
    const coder = authority.assess(GROQ20B.providerId, GROQ20B.modelId, { role: "CODER" });
    expect(coder.state).toBe("TOOL_UNRELIABLE");
    expect(coder.hardExclude).toBe(false);
    expect(coder.scoreAdjustment).toBeLessThanOrEqual(-15);
    const analyst = authority.assess(GROQ20B.providerId, GROQ20B.modelId, { role: "ANALYST" });
    // The condition is role-scoped to CODER (the only role that produced malformed calls) —
    // an ANALYST assessment does not even see it and reads the route as HEALTHY.
    expect(analyst.state).toBe("HEALTHY");
    expect(analyst.scoreAdjustment).toBeGreaterThan(coder.scoreAdjustment);
    expect(userFacingRouteStatus(coder.state)).toBe("Ready");
  });

  it("[PASS] four consecutive malformed calls quarantine the route (hard exclude) until explicitly cleared", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    for (let i = 0; i < 4; i += 1) authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(T0 + i * 1000), source: "runtime", outcome: "malformed", role: "CODER" });
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId)).toMatchObject({ state: "QUARANTINED", hardExclude: true });
    authority.observe({ kind: "quarantine", ...GROQ20B, observedAt: iso(T0 + 5000), source: "registry", action: "clear", reason: "OWNER_LIFT" });
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).hardExclude).toBe(false);
  });

  it("[PASS] role outcomes mark CAPABILITY_LIMITED for the failing role only, and a verified completion for that role clears it", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    authority.observe({ kind: "role_outcome", ...GROQ20B, observedAt: iso(T0), source: "bench", role: "PLANNER", outcome: "role_failed" });
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId, { role: "PLANNER" }).state).toBe("CAPABILITY_LIMITED");
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId, { role: "CODER" }).state).not.toBe("CAPABILITY_LIMITED");
    authority.observe({ kind: "role_outcome", ...GROQ20B, observedAt: iso(T0 + 1000), source: "bench", role: "PLANNER", outcome: "verified_complete" });
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId, { role: "PLANNER" }).state).not.toBe("CAPABILITY_LIMITED");
  });
});

describe("EightBitRouteHealthAuthority — probe budgeting (§9)", () => {
  it("[PASS] no evidence → probe worthwhile; fresh HEALTHY evidence → not worth spending; importance overrides", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const unknown = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId);
    expect(unknown.shouldProbe).toBe(true);
    expect(unknown.informationGain).toBeGreaterThan(0.5);
    expect(unknown.reasonCodes).toContain("NO_EVIDENCE_PROBE_WORTHWHILE");
    authority.observe({ kind: "probe_gate", ...NEMOTRON, observedAt: iso(c.now()), source: "probe", requestShape: "production", served: true, latencyMs: 2000 });
    c.advance(60_000);
    const fresh = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId);
    expect(fresh.shouldProbe).toBe(false);
    expect(fresh.reasonCodes).toContain("FRESH_HEALTHY_EVIDENCE");
    expect(fresh.notBefore).toBeGreaterThan(c.now());
    // Only candidate for the role: routing needs certainty even on fresh evidence... but not
    // before the transient-change window has a chance to matter.
    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.healthyTtlMs / 2 + 1000);
    const later = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId, { importance: 1 });
    expect(later.shouldProbe).toBe(true);
    expect(later.stateChangeProbability).toBeGreaterThan(0.5);
  });

  it("[PASS] the allowance reserve is protected: a probe that would dip below the request/token reserve is refused", () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const low = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId, { remainingRequests: 20 });
    expect(low.shouldProbe).toBe(false);
    expect(low.reasonCodes).toContain("REQUEST_RESERVE_PROTECTED");
    const tokens = authority.probeAdvice(GROQ20B.providerId, GROQ20B.modelId, { remainingTokens: 22_000 });
    expect(tokens.shouldProbe).toBe(false);
    expect(tokens.reasonCodes).toContain("TOKEN_RESERVE_PROTECTED");
    expect(authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId, { remainingRequests: 753, remainingTokens: 150_000 }).shouldProbe).toBe(true);
  });

  it("[PASS] a fresh SATURATED condition is not re-probed until it is near expiry (no hammering a saturated worker)", () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", reason: "TEMPORARY_CAPACITY", message: SATURATION_MESSAGE });
    const early = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId);
    expect(early.shouldProbe).toBe(false);
    expect(early.reasonCodes).toContain("TRANSIENT_CONDITION_STILL_FRESH");
    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.saturationTtlMs - 30_000);
    const late = authority.probeAdvice(NEMOTRON.providerId, NEMOTRON.modelId);
    expect(late.shouldProbe).toBe(true);
    expect(late.reasonCodes).toContain("STATE_LIKELY_CHANGED");
  });
});

describe("EightBitRouteHealthAuthority — durable ledger + hydration (§5, §7)", () => {
  let persistence: ISessionPersistence;
  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
  });

  it("[PASS] observations are appended and snapshots upserted through the existing work_items persistence; a new authority hydrates the still-active conditions and drops expired ones", async () => {
    const c = clock();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, c.now);
    const ledger = new EightBitRouteHealthLedger(persistence);
    ledger.attach(authority);
    authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", reason: "TEMPORARY_CAPACITY", message: SATURATION_MESSAGE });
    authority.observe({ kind: "call_failure", providerId: "github-models", modelId: "gpt-4o-mini", observedAt: iso(c.now()), source: "runtime", reason: "MODEL_RETIRED", status: 410 });
    await ledger.flush();
    const observations = await ledger.loadObservations();
    expect(observations).toHaveLength(2);
    expect(observations.map((o) => o.kind)).toEqual(["call_failure", "call_failure"]);
    const snapshots = await ledger.loadSnapshots();
    expect(snapshots.map((s) => s.state).sort()).toEqual(["MODEL_RETIRED", "SATURATED"]);

    // Restart 20 minutes later: saturation has expired, retirement has not.
    const restartClock = clock(c.now() + 20 * 60_000);
    const rehydrated = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, restartClock.now);
    const count = await new EightBitRouteHealthLedger(persistence).hydrate(rehydrated);
    expect(count).toBe(2);
    expect(rehydrated.assess("github-models", "gpt-4o-mini")).toMatchObject({ state: "MODEL_RETIRED", hardExclude: true });
    expect(rehydrated.assess(NEMOTRON.providerId, NEMOTRON.modelId).state).not.toBe("SATURATED");
    expect(rehydrated.assess(NEMOTRON.providerId, NEMOTRON.modelId).reasonCodes).toContain("EVIDENCE_EXPIRED");
  });

  it("[PASS] a persistence failure never breaks observation (listener isolation)", async () => {
    const authority = createEightBitRouteHealthAuthority({}, () => T0);
    const broken = { ...persistence, insertIfAbsent: async () => { throw new Error("disk full"); }, upsertWorkItem: async () => { throw new Error("disk full"); } } as unknown as ISessionPersistence;
    const ledger = new EightBitRouteHealthLedger(broken);
    ledger.attach(authority);
    expect(() => authority.observe({ kind: "call_success", ...GROQ20B, observedAt: iso(T0), source: "runtime", latencyMs: 500 })).not.toThrow();
    await ledger.flush();
    expect(authority.assess(GROQ20B.providerId, GROQ20B.modelId).state).toBe("HEALTHY");
  });
});

describe("EightBitRouter × health authority — health controls routing (§10)", () => {
  const scope: BindingScope = { sessionId: "s1", role: "CODER" };

  function setup(now: () => number) {
    const fw = new ForgeZero();
    const health = new EightBitHealthTracker(fw, now);
    const reliability = new EightBitReliabilityTracker();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, now);
    const router = new EightBitRouter(fw, health, reliability, undefined, authority);
    return { fw, router, authority };
  }

  it("[PASS] a SATURATED route with the higher capability score loses to a HEALTHY route; when the saturation expires the capability winner returns", () => {
    const c = clock();
    const { fw, router, authority } = setup(c.now);
    fw.register(makeModel({ ...NEMOTRON, codingScore: 95 }));
    fw.register(makeModel({ ...GROQ20B, codingScore: 70 }));
    const coderOptions = { policyMode: "adaptive" as const, hasAdapter: () => true, requiredCapabilities: ["coding", "toolCalling"], taskType: "coder" };
    const baseline = router.selectRoute({ scope, ...coderOptions });
    expect(baseline.outcome).toBe("selected");
    if (baseline.outcome === "selected") expect(baseline.model.modelId).toBe(NEMOTRON.modelId);

    for (let i = 0; i < 3; i += 1) authority.observe({ kind: "call_failure", ...NEMOTRON, observedAt: iso(c.now() + i * 1000), source: "runtime", reason: "TEMPORARY_CAPACITY", message: SATURATION_MESSAGE, role: "CODER" });
    authority.observe({ kind: "call_success", ...GROQ20B, observedAt: iso(c.now()), source: "runtime", latencyMs: 600, role: "CODER" });
    const saturated = router.selectRoute({ scope, ...coderOptions });
    expect(saturated.outcome).toBe("selected");
    if (saturated.outcome === "selected") {
      expect(saturated.model.modelId).toBe(GROQ20B.modelId);
      expect(saturated.sticky).toBe(false);
      expect(saturated.health?.state).toBe("HEALTHY");
      expect(saturated.reasons.some((r) => r.startsWith("HEALTH_HEALTHY"))).toBe(true);
    }

    c.advance(DEFAULT_ROUTE_HEALTH_POLICY.saturationTtlMs + 1000);
    // Saturation expired but the window still reads DEGRADED for nemotron; groq stays bound.
    const recovered = router.selectRoute({ scope, ...coderOptions });
    if (recovered.outcome === "selected") expect(recovered.model.modelId).toBe(GROQ20B.modelId);
    // A served production call on nemotron is positive evidence: it returns to HEALTHY and, with
    // the binding cleared, wins again on capability.
    authority.observe({ kind: "call_success", ...NEMOTRON, observedAt: iso(c.now()), source: "runtime", latencyMs: 1800, role: "CODER" });
    router.clearBinding(scope);
    const fresh = router.selectRoute({ scope, ...coderOptions });
    if (fresh.outcome === "selected") expect(fresh.model.modelId).toBe(NEMOTRON.modelId);
  });

  it("[PASS] hard-excluded routes (retired / daily quota exhausted) are removed from the candidate set and reported when nothing remains", () => {
    const c = clock();
    const { fw, router, authority } = setup(c.now);
    fw.register(makeModel({ ...NEMOTRON }));
    fw.register(makeModel({ ...GROQ20B }));
    authority.observe({ kind: "catalog", ...NEMOTRON, observedAt: iso(c.now()), source: "registry", fact: "retired" });
    authority.observe({ kind: "daily_allowance", ...GROQ20B, observedAt: iso(c.now()), source: "governor", unit: "tokens", limit: 200_000, remaining: 0, resetAt: iso(c.now() + 3_600_000) });
    const result = router.selectRoute({ scope, policyMode: "adaptive", hasAdapter: () => true });
    expect(result.outcome).toBe("no_eligible_route");
    if (result.outcome === "no_eligible_route") {
      expect(result.reasonCodes).toContain("HEALTH_EXCLUDED_ALL_CANDIDATES");
      expect(result.healthExcluded?.map((e) => e.state).sort()).toEqual(["DAILY_QUOTA_EXHAUSTED", "MODEL_RETIRED"]);
    }
    c.advance(3_600_000 + 1000);
    const later = router.selectRoute({ scope, policyMode: "adaptive", hasAdapter: () => true });
    expect(later.outcome).toBe("selected");
    if (later.outcome === "selected") expect(later.model.modelId).toBe(GROQ20B.modelId);
  });

  it("[PASS] a TOOL_UNRELIABLE route is demoted for the CODER role but can still win the ANALYST role (heterogeneous teams, §34)", () => {
    const c = clock();
    const { fw, router, authority } = setup(c.now);
    fw.register(makeModel({ ...GROQ20B, codingScore: 90 }));
    fw.register(makeModel({ ...NEMOTRON, codingScore: 60 }));
    for (let i = 0; i < 9; i += 1) authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(c.now() + i * 1000), source: "runtime", outcome: "valid", role: "CODER" });
    authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(c.now() + 9_000), source: "runtime", outcome: "unknown_tool", role: "CODER" });
    authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(c.now() + 10_000), source: "runtime", outcome: "valid", role: "CODER" });
    authority.observe({ kind: "tool_outcome", ...GROQ20B, observedAt: iso(c.now() + 11_000), source: "runtime", outcome: "malformed", role: "CODER" });
    const coder = router.selectRoute({ scope, policyMode: "adaptive", hasAdapter: () => true, requiredCapabilities: ["coding", "toolCalling"], taskType: "coder" });
    expect(coder.outcome).toBe("selected");
    if (coder.outcome === "selected") expect(coder.model.modelId).toBe(NEMOTRON.modelId);
    const analyst = router.selectRoute({ scope: { sessionId: "s1", role: "ANALYST" }, policyMode: "adaptive", hasAdapter: () => true, requiredCapabilities: ["coding"], taskType: "analyst" });
    expect(analyst.outcome).toBe("selected");
    if (analyst.outcome === "selected") expect(analyst.model.modelId).toBe(GROQ20B.modelId);
  });
});

describe("EightBitRuntime — the authority is fed by the runtime seams and survives restart", () => {
  let persistence: ISessionPersistence;
  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    await persistence.upsertSession({ id: "s1", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
  });

  it("[PASS] handleTurnFailure feeds a classified failure; recordSuccess/recordToolCallOutcome feed the authority; a second runtime on the same persistence inherits the durable state", async () => {
    const c = clock();
    const fw = new ForgeZero();
    fw.register(makeModel({ ...NEMOTRON }));
    fw.register(makeModel({ ...GROQ20B }));
    const runtime = new EightBitRuntime({ firewall: fw, persistence, now: c.now });
    await runtime.hydrate("s1");
    const selection = await runtime.selectInitialRoute({ sessionId: "s1", role: "CODER" }, { policyMode: "adaptive", hasAdapter: () => true }, {});
    expect(selection.outcome).toBe("selected");
    const retired = Object.assign(new Error("github-models error (410): Gone"), { status: 410 });
    await runtime.handleTurnFailure({ sessionId: "s1", turnId: "t1", role: "CODER", current: { providerId: "github-models", modelId: "gpt-4o-mini" }, isExactPin: true, pinMode: "route", policyMode: "adaptive", error: retired, hasAdapter: () => true });
    runtime.recordSuccess(GROQ20B.providerId, GROQ20B.modelId, { latencyMs: 640, role: "CODER" });
    runtime.recordToolCallOutcome(GROQ20B.providerId, GROQ20B.modelId, "valid", { role: "CODER" });
    expect(runtime.routeHealth.assess("github-models", "gpt-4o-mini")).toMatchObject({ state: "MODEL_RETIRED", hardExclude: true });
    expect(runtime.routeHealth.assess(GROQ20B.providerId, GROQ20B.modelId).state).toBe("HEALTHY");
    await runtime.routeHealthLedger.flush();

    const second = new EightBitRuntime({ firewall: fw, persistence, now: c.now });
    await second.hydrate("s2");
    expect(second.routeHealth.assess("github-models", "gpt-4o-mini").hardExclude).toBe(true);
    const observations = await second.routeHealthLedger.loadObservations({ providerId: GROQ20B.providerId });
    expect(observations.map((o) => o.kind)).toEqual(["call_success", "tool_outcome"]);
  });

  it("[PASS] user-facing explanations never leak internal vocabulary", () => {
    expect(routingExplanation({ providerLabel: "Groq", supplyLabel: "free capacity", state: "HEALTHY" })).toBe("Using Groq free capacity");
    expect(routingExplanation({ providerLabel: "GitHub Copilot", supplyLabel: "your entitlement", state: "HEALTHY" })).toBe("Using GitHub Copilot your entitlement");
    expect(routingExplanation({ providerLabel: "OpenRouter", supplyLabel: "free capacity", state: "SATURATED" })).toBe("OpenRouter is temporarily busy — trying another free route");
    expect(routingExplanation({ providerLabel: "OpenRouter", supplyLabel: "free capacity", state: "HEALTHY", queued: true })).toBe("Free route temporarily busy — queued");
    const states: NormalizedObservation["kind"][] = ["probe_gate", "call_success"];
    expect(states).toHaveLength(2);
  });
});
