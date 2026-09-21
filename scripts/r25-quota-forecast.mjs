#!/usr/bin/env node
/*
 * R25 quota-forecast proof — feeds the *live-observed* Groq quota windows from the Phase 5
 * pilot (allowanceAtStart / allowanceAtEnd, x-ratelimit headers) into ForgeZero's real
 * forecastCapacity engine, with a task demand profile measured from actual benchmark runs.
 *
 * Also computes actual per-pair quota deltas (optimized vs control calls/tokens) — honestly
 * reported, including pairs where the optimized arm consumed more.
 *
 * Evidence → docs/evidence/r25-live-reality/quota-forecast.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forecastCapacity } from "../packages/forge-zero/dist/capacity-forecast.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchDir = path.join(ROOT, "docs", "evidence", "r25-live-reality", "bench", "raw", "pilot");
const campaignFile = fs.readdirSync(benchDir).find((f) => f.startsWith("campaign-") && f.endsWith(".json"));
if (!campaignFile) throw new Error("no pilot campaign evidence found — run the pilot first");
const campaign = JSON.parse(fs.readFileSync(path.join(benchDir, campaignFile), "utf-8"));

const runs = campaign.runs ?? [];
const observed = {
  allowanceAtStart: campaign.allowanceAtStart,
  allowanceAtEnd: campaign.allowanceAtEnd,
  quotaAtPin: campaign.pin?.quotaAtPin,
};

// Measured per-run demand from the real pilot runs (calls + tokens actually consumed).
const measuredRuns = runs.map((r) => ({
  taskId: r.taskId, arm: r.arm, classification: r.classification,
  modelCalls: r.modelCalls, totalTokens: r.totalTokens, wallClockMs: r.wallClockMs,
}));
const callsMeasured = measuredRuns.filter((r) => typeof r.modelCalls === "number").map((r) => r.modelCalls);
const tokensMeasured = measuredRuns.filter((r) => typeof r.totalTokens === "number").map((r) => r.totalTokens);
const avgCalls = callsMeasured.length ? callsMeasured.reduce((a, b) => a + b, 0) / callsMeasured.length : 0;
const avgTokens = tokensMeasured.length ? tokensMeasured.reduce((a, b) => a + b, 0) / tokensMeasured.length : 0;

const now = Date.now();
const end = observed.allowanceAtEnd ?? observed.allowanceAtStart;
const dailyTokenRemaining = end.dailyTokenBucketLevel ?? 0;
const requestsRemaining = end.remaining ?? 0;

// Windows as actually observed via live x-ratelimit headers:
//   requests — Groq free-plan daily request budget (resets daily)
//   input_tokens — daily token bucket (the dimension that stopped the campaign)
//   a separate per-minute ITPM window (observed 8000/min; throttle dimension, not budget)
const observedAt = end.checkedAt ?? new Date(now).toISOString();
const dailyReset = new Date(now + 12 * 3600_000).toISOString();
const windows = [
  { unit: "requests", limit: end.limit ?? 1000, remaining: requestsRemaining, resetAt: dailyReset, scope: "ORG", observedAt, authoritative: true, period: "daily" },
  { unit: "input_tokens", limit: 200_000, remaining: dailyTokenRemaining, resetAt: dailyReset, scope: "ORG", observedAt, authoritative: true, period: "daily" },
];
// The owner-plan key is a user-connected account: physical quota is real, but the route is
// only eligible at product level when managed-use terms are cleared. We run the forecaster
// twice — product posture (owner-only, terms uncleared) and terms-cleared variant — to
// separate eligibility truth from raw quota arithmetic.
const baseRoute = {
  routeId: `groq::${campaign.pin?.id ?? "openai/gpt-oss-120b"}`,
  providerId: campaign.providerId ?? "groq",
  modelId: campaign.pin?.id ?? "openai/gpt-oss-120b",
  canonicalModelId: campaign.pin?.id ?? "openai/gpt-oss-120b",
  family: "gpt-oss",
  gateway: "direct",
  supplyClass: "USER_CONNECTED_FREE",
  capacityPoolId: "groq-owner-free-plan",
  capacityPoolScope: "PER_USER_POOL",
  capacityScope: "END_USER",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
  lifecycle: "APPROVED",
  explicitZeroPrice: false,
  freeOnlyAdmissionProven: true,
  paidFallbackDisabled: true,
  managedMultiUserAllowed: false,
  privacyClass: "standard",
  roles: ["coder", "tool_agent", "analyst", "planner"],
  qualityScore: 80,
  healthy: true,
  enabled: true,
  windows: windows.map((w) => ({ ...w, scope: "END_USER" })),
};
const pool = {
  poolId: "groq-owner-free-plan",
  providerId: baseRoute.providerId,
  scope: "PER_USER_POOL",
  supplyClass: "USER_CONNECTED_FREE",
  windows: baseRoute.windows,
  observedAt,
  authoritative: true,
};

const taskDemand = {
  taskKind: "r25-coder-arm",
  requests: Math.max(1, Math.ceil(avgCalls)),
  inputTokens: Math.max(1, Math.ceil(avgTokens)),
  outputTokens: 0,
  roleRequests: { coder: Math.max(1, Math.ceil(avgCalls)) },
};

const forecastProduct = forecastCapacity({
  routes: [baseRoute],
  pools: [pool],
  taskDemand,
  activeUsers: 1,
  firstRunReserveRequests: 2,
  firstRunReserveTokens: 2_000,
  now,
});
const forecastTermsCleared = forecastCapacity({
  routes: [{ ...baseRoute, managedMultiUserAllowed: true }],
  pools: [pool],
  taskDemand,
  activeUsers: 1,
  firstRunReserveRequests: 2,
  firstRunReserveTokens: 2_000,
  now,
});

// Per-pair actual deltas — honest both directions.
const pairs = new Map();
for (const r of measuredRuns) {
  const entry = pairs.get(r.taskId) ?? {};
  entry[r.arm] = r;
  pairs.set(r.taskId, entry);
}
const pairDeltas = [...pairs.entries()].map(([taskId, p]) => {
  if (!p.control || !p.optimized) return { taskId, complete: false };
  return {
    taskId,
    complete: true,
    control: { calls: p.control.modelCalls, tokens: p.control.totalTokens, classification: p.control.classification },
    optimized: { calls: p.optimized.modelCalls, tokens: p.optimized.totalTokens, classification: p.optimized.classification },
    callDelta: p.optimized.modelCalls - p.control.modelCalls,
    tokenDelta: p.optimized.totalTokens != null && p.control.totalTokens != null ? p.optimized.totalTokens - p.control.totalTokens : null,
  };
});

const project = (f) => {
  const r = f.routes?.find((x) => x.routeId === baseRoute.routeId) ?? f.routes?.[0];
  return r ? {
    eligible: r.eligible,
    exclusionReason: r.exclusionReason ?? null,
    estimatedTaskUnits: r.estimatedTaskUnits,
    availableRequests: r.availableRequests,
    availableTokens: r.availableTokens,
    countedInPool: r.countedInPool,
    alerts: f.alerts ?? [],
  } : null;
};
const evidence = {
  schemaVersion: 1,
  evidenceClass: "live_quota_observation + real_forecast_engine",
  recordedAt: new Date().toISOString(),
  campaignId: campaign.campaignId,
  route: baseRoute.routeId,
  observedQuota: {
    requests: { limit: end.limit, remaining: requestsRemaining, source: end.source },
    dailyTokens: { limit: 200_000, used: end.dailyTokensUsed, remaining: dailyTokenRemaining, source: end.source },
  },
  measuredDemand: { avgCallsPerRun: Number(avgCalls.toFixed(2)), avgTokensPerRun: Number(avgTokens.toFixed(0)), sampleSize: measuredRuns.length },
  forecast: {
    productPosture: project(forecastProduct),
    termsClearedVariant: project(forecastTermsCleared),
  },
  pairDeltas,
  interpretation: "productPosture is the honest product-level verdict (owner-plan supply is not managed-multi-user capacity); termsClearedVariant is the raw physical quota answer. pairDeltas report actual optimized-minus-control consumption (negative = optimized saved quota).",
};
const out = path.join(ROOT, "docs", "evidence", "r25-live-reality", "quota-forecast.json");
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ productPosture: evidence.forecast.productPosture, termsCleared: evidence.forecast.termsClearedVariant, pairDeltas }, null, 2));
console.log(`→ ${path.relative(ROOT, out)}`);
