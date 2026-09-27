#!/usr/bin/env node
// Deterministic production-class federation scenarios; no provider calls.
import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  CapacityReservationLedger,
} from "../packages/forge-zero/dist/index.js";
import {
  createEightBitRouteHealthAuthority,
  createFreeFabric,
} from "../packages/eight-bit/dist/index.js";
import {
  effectiveQuota,
  parseRouteQuota,
} from "../packages/model-registry/dist/index.js";

const T0 = Date.parse("2026-09-27T14:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const availableWindows = (resetAt = iso(T0 + 60_000)) => [
  { unit: "requests", limit: 100, remaining: 100, resetAt, scope: "ORG", observedAt: iso(T0), authoritative: true },
  { unit: "input_tokens", limit: 1_000_000, remaining: 1_000_000, resetAt, scope: "ORG", observedAt: iso(T0), authoritative: true },
];
const exhaustedWindows = (resetAt) => [
  { unit: "requests", limit: 100, remaining: 0, resetAt, scope: "ORG", observedAt: iso(T0), authoritative: true },
  { unit: "input_tokens", limit: 1_000_000, remaining: 1_000_000, resetAt, scope: "ORG", observedAt: iso(T0), authoritative: true },
];

function route(id, providerId, poolId, options = {}) {
  return {
    routeId: id,
    providerId,
    modelId: options.modelId ?? `${id}-model`,
    canonicalModelId: options.modelId ?? `${id}-model`,
    family: providerId,
    gateway: providerId,
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: poolId,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["CODER"],
    fallbackRoles: options.fallbackRoles,
    qualityScore: options.qualityScore ?? 70,
    healthy: true,
    enabled: true,
    windows: options.windows ?? availableWindows(),
  };
}

function pool(poolId, providerId, windows = availableWindows()) {
  return {
    poolId,
    providerId,
    scope: "SHARED_OWNER_POOL",
    supplyClass: "PURE_MANAGED_FREE",
    windows,
    observedAt: iso(T0),
    authoritative: true,
    capacityIdentity: `managed:${providerId}:${poolId}`,
  };
}

function decide(routes, pools, request = {}, health, now = () => T0) {
  const reservations = new CapacityReservationLedger({ routes: [], pools: [], now });
  const fabric = createFreeFabric({
    managedRoutes: () => routes,
    managedPools: () => pools,
    reservations,
    health,
    now,
  });
  return fabric.decide({
    requestId: request.requestId ?? "request",
    userId: request.userId ?? "r49-user",
    role: "CODER",
    demand: { requests: 1, inputTokens: 1000, outputTokens: 500 },
    ...request,
  });
}

function compact(decision) {
  return {
    outcome: decision.outcome,
    selected: decision.selected ? {
      providerId: decision.selected.providerId,
      modelId: decision.selected.modelId,
      capacityPoolId: decision.selected.capacityPoolId,
    } : null,
    nextAvailableAt: decision.nextAvailableAt ?? null,
    reasonCodes: decision.explanation.reasonCodes,
    candidates: decision.explanation.candidates.map((candidate) => ({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      status: candidate.status,
      reasonCodes: candidate.reasonCodes,
      healthState: candidate.healthState ?? null,
      scoreAdjustment: candidate.scoreAdjustment ?? 0,
    })),
  };
}

const scenarios = [];

// A/B: sibling models share one exhausted OpenRouter account pool. They are not alternate
// capacity; the independent Groq pool must execute without parking.
{
  const reset = iso(T0 + 24 * 60 * 60_000);
  const orPool = pool("openrouter-account", "openrouter", exhaustedWindows(reset));
  const groqPool = pool("groq-model", "groq");
  const decision = decide([
    route("or-a", "openrouter", orPool.poolId, { qualityScore: 95 }),
    route("or-b", "openrouter", orPool.poolId, { qualityScore: 90 }),
    route("groq", "groq", groqPool.poolId, { qualityScore: 80 }),
  ], [orPool, groqPool]);
  scenarios.push({
    id: "A_SHARED_ACCOUNT_EXHAUSTED",
    expected: "select independent Groq; do not switch pointlessly between OpenRouter siblings; do not wait",
    pass: decision.outcome === "ADMITTED" && decision.selected?.providerId === "groq",
    decision: compact(decision),
  });
  scenarios.push({
    id: "B_OPENROUTER_EXHAUSTED_GROQ_HEALTHY",
    expected: "execute on Groq",
    pass: decision.outcome === "ADMITTED" && decision.selected?.providerId === "groq",
    decision: compact(decision),
  });
}

// C: Groq unavailable; independently qualified Cloudflare included-free route admits.
{
  const groqPool = pool("groq-model", "groq", exhaustedWindows(iso(T0 + 60_000)));
  const cloudflarePool = pool("cloudflare-account", "cloudflare-workers-ai");
  const decision = decide([
    route("groq", "groq", groqPool.poolId, { qualityScore: 90 }),
    route("cloudflare", "cloudflare-workers-ai", cloudflarePool.poolId, { qualityScore: 80 }),
  ], [groqPool, cloudflarePool]);
  scenarios.push({
    id: "C_GROQ_LIMITED_CLOUDFLARE_HEALTHY",
    expected: "execute on policy-eligible Cloudflare",
    pass: decision.outcome === "ADMITTED" && decision.selected?.providerId === "cloudflare-workers-ai",
    decision: compact(decision),
  });
}

// D: qualified route is exhausted; healthy PROBATION route is the canonical allowed fallback.
{
  const qualifiedPool = pool("qualified-pool", "provider-q", exhaustedWindows(iso(T0 + 60_000)));
  const probationPool = pool("probation-pool", "provider-p");
  const decision = decide([
    route("qualified", "provider-q", qualifiedPool.poolId, { qualityScore: 95 }),
    route("probation", "provider-p", probationPool.poolId, { qualityScore: 50, fallbackRoles: ["CODER"] }),
  ], [qualifiedPool, probationPool], {
    roleQualificationTierFor: (providerId) => providerId === "provider-q" ? "QUALIFIED" : "PROBATION",
  });
  scenarios.push({
    id: "D_PROBATION_AFTER_QUALIFIED_EXHAUSTION",
    expected: "use healthy probation route",
    pass: decision.outcome === "ADMITTED" && decision.selected?.providerId === "provider-p",
    decision: compact(decision),
  });
}

// E: scarcity never promotes NOT_QUALIFIED supply.
{
  const nqPool = pool("nq-pool", "provider-nq");
  const decision = decide([route("nq", "provider-nq", nqPool.poolId)], [nqPool], {
    routeAdmission: () => false,
    roleQualificationTierFor: () => "NOT_TESTED",
  });
  scenarios.push({
    id: "E_ONLY_NOT_QUALIFIED",
    expected: "DENIED_NO_SUPPLY; never wait or cheat",
    pass: decision.outcome === "DENIED_NO_SUPPLY" && !decision.selected,
    decision: compact(decision),
  });
}

// F: admissible supply exists but every independent pool is capacity-exhausted.
{
  const firstReset = iso(T0 + 30_000);
  const p1 = pool("pool-1", "provider-1", exhaustedWindows(firstReset));
  const p2 = pool("pool-2", "provider-2", exhaustedWindows(iso(T0 + 60_000)));
  const decision = decide([
    route("r1", "provider-1", p1.poolId),
    route("r2", "provider-2", p2.poolId),
  ], [p1, p2]);
  scenarios.push({
    id: "F_ALL_ADMISSIBLE_POOLS_UNAVAILABLE",
    expected: "genuine QUEUED_FOR_CAPACITY with earliest provider reset",
    pass: decision.outcome === "QUEUED_FOR_CAPACITY" && decision.nextAvailableAt === firstReset,
    decision: compact(decision),
  });
}

// G: provider cooldown expires under the authority clock; no manual state clear.
{
  let now = T0;
  const authority = createEightBitRouteHealthAuthority({}, () => now);
  const candidate = route("recovering", "recovering-provider", "recovering-pool");
  const candidatePool = pool("recovering-pool", "recovering-provider");
  authority.observe({
    kind: "call_failure",
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    observedAt: iso(now),
    source: "runtime",
    reason: "RATE_LIMITED",
    status: 429,
    retryAfterMs: 5_000,
    role: "CODER",
  });
  const before = decide([candidate], [candidatePool], { requestId: "before-recovery" }, authority, () => now);
  now += 5_001;
  const after = decide([candidate], [candidatePool], { requestId: "after-recovery" }, authority, () => now);
  scenarios.push({
    id: "G_COOLDOWN_EXPIRES",
    expected: "queued/excluded before reset, automatically admitted after fresh clock passes reset",
    pass: before.outcome !== "ADMITTED" && after.outcome === "ADMITTED",
    before: compact(before),
    after: compact(after),
  });
}

// H: repeated role failure demotes only that role; healthy peer wins despite lower base score.
{
  const authority = createEightBitRouteHealthAuthority({}, () => T0);
  const bad = route("bad-qwen", "groq", "groq-qwen-pool", { qualityScore: 95, modelId: "qwen/qwen3.8-27b" });
  const peer = route("verified-peer", "openrouter", "openrouter-pool", { qualityScore: 80, modelId: "nvidia/nemotron-3-super-120b-a12b:free" });
  for (let index = 0; index < 3; index++) {
    authority.observe({
      kind: "role_outcome",
      providerId: bad.providerId,
      modelId: bad.modelId,
      observedAt: iso(T0 + index),
      source: "runtime",
      role: "CODER",
      outcome: "role_failed",
    });
  }
  const decision = decide([bad, peer], [pool(bad.capacityPoolId, bad.providerId), pool(peer.capacityPoolId, peer.providerId)], {}, authority);
  scenarios.push({
    id: "H_REPEATED_NON_CONVERGENCE",
    expected: "role-quality evidence demotes Qwen; healthy qualified peer selected",
    pass: decision.outcome === "ADMITTED" && decision.selected?.modelId === peer.modelId,
    decision: compact(decision),
  });
}

const noFalseWaiting = {
  schemaVersion: 1,
  round: "R49",
  generatedAt: new Date().toISOString(),
  provenance: "deterministic production FreeFabric/CapacityReservationLedger/RouteHealthAuthority",
  paidSpendUsd: 0,
  passed: scenarios.every((scenario) => scenario.pass),
  scenarios,
};
writeFileSync(path.resolve("docs/evidence/r49-free-supply/R49-NO-FALSE-WAITING.json"), `${JSON.stringify(noFalseWaiting, null, 2)}\n`);

// Separate reset/expiry proof using the exact production parser/effective-state function.
const quota = parseRouteQuota([
  ["x-ratelimit-limit-requests", "1000"],
  ["x-ratelimit-remaining-requests", "999"],
  ["x-ratelimit-reset-requests", "2m"],
  ["x-ratelimit-limit-tokens", "8000"],
  ["x-ratelimit-remaining-tokens", "0"],
  ["x-ratelimit-reset-tokens", "7.5s"],
], () => new Date(T0));
const afterTokenReset = effectiveQuota(quota, () => new Date(T0 + 8_000));
const afterAllResets = effectiveQuota(afterTokenReset, () => new Date(T0 + 121_000));
const recovery = {
  schemaVersion: 1,
  round: "R49",
  generatedAt: new Date().toISOString(),
  provenance: "deterministic production quota parser/effectiveQuota + scenario G route-health clock",
  paidSpendUsd: 0,
  initial: quota,
  afterTokenReset,
  afterAllResets,
  assertions: {
    tokenRefilledAtOwnReset: afterTokenReset?.remainingTokens === 8000,
    requestWindowUnchangedAtTokenReset: afterTokenReset?.remainingRequests === 999 && afterTokenReset?.requestResetAt === quota?.requestResetAt,
    requestResetClearedAtOwnReset: afterAllResets?.requestResetAt === undefined,
    cooldownRouteReenteredAutomatically: scenarios.find((scenario) => scenario.id === "G_COOLDOWN_EXPIRES")?.pass === true,
  },
};
writeFileSync(path.resolve("docs/evidence/r49-free-supply/R49-CAPACITY-RECOVERY.json"), `${JSON.stringify(recovery, null, 2)}\n`);

if (!noFalseWaiting.passed || Object.values(recovery.assertions).some((value) => !value)) {
  console.error("[r49-no-false-waiting] deterministic proof failed");
  process.exitCode = 1;
} else {
  console.log(`[r49-no-false-waiting] ${scenarios.length}/${scenarios.length} scenarios passed`);
}
