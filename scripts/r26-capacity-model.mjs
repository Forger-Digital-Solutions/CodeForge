#!/usr/bin/env node
/*
 * R26 capacity / 373-DAU model — refreshes the R4 deterministic scale simulation against the
 * R26-qualified live roster and the *measured* Phase 5 pilot demand profile.
 *
 * Three honest postures, matching quota-forecast-r26.json:
 *   1. productPosture      — production admission as it stands today (owner-pool routes carry
 *                            managedMultiUserAllowed=false → zero product-admissible capacity).
 *   2. termsClearedCeiling — the same fleet with managed terms cleared: the raw physical ceiling.
 *   3. userConnected       — :free routes modeled as PER_USER_POOL user-connected accounts; this is
 *                            the architectural scaling path (each user's own account → per-user quota).
 *
 * Fleet sources (all live-observed during R26):
 *   groq::openai/gpt-oss-120b  — 1000 req/day, 200k tok/day (x-ratelimit headers, quota-forecast-r26)
 *   groq::openai/gpt-oss-20b   — same plan tier modeled; 8k TPM per-minute window noted as a burst
 *                                constraint that a daily model cannot express (Phase 5 pilot saturated it)
 *   groq::qwen/qwen3.8-27b     — only Planner-qualified route; requests-window only (daily token cap
 *                                unobserved); 1k OTPM structural cap blocks production-shaped calls
 *   openrouter account (:free) — one SHARED 1000 req/day account pool across all three qualified
 *                                :free models (observed account usage=0; policy-modeled per ≥$10 FAQ)
 *
 * Demand: measured R26 pilot — 10.75 calls/run, 29,880 tokens/run (75/25 in/out split),
 * role requests mapped from qualification roles (CODER+TOOL_AGENT→coder, ANALYST+EXPLORER→explorer).
 *
 * Evidence → docs/evidence/r26-production-readiness/capacity-model-r26.json + R26-CAPACITY.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateScale } from "../packages/forge-zero/dist/capacity-simulator.js";
import { forecastCapacity } from "../packages/forge-zero/dist/capacity-forecast.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.now();
const resetAt = new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z");
resetAt.setUTCDate(resetAt.getUTCDate() + 1);
const window = (unit, limit, scope = "ORG") => ({
  unit, limit, remaining: limit, resetAt: resetAt.toISOString(), scope,
  observedAt: new Date(now).toISOString(), authoritative: true,
});

// Roles are the runtime's (explorer/planner/coder/reviewer); qualification roles map
// CODER+TOOL_AGENT→coder, EXPLORER+ANALYST→explorer. Only qualified roles are listed.
const routeBase = {
  lifecycle: "APPROVED",
  explicitZeroPrice: true,
  paidFallbackDisabled: true,
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
  privacyClass: "standard",
  healthy: true,
  enabled: true,
  qualityScore: 75,
  supplyClass: "PURE_MANAGED_FREE",
  capacityPoolScope: "SHARED_OWNER_POOL",
};

const groqPool = (id, modelId, roles, extra = {}) => ({
  ...routeBase,
  routeId: `groq-${id}`, providerId: "groq", modelId, canonicalModelId: modelId,
  family: id.includes("gpt-oss") ? "gpt-oss" : "qwen", gateway: "direct",
  capacityPoolId: `groq:${modelId}`, capacityScope: "ORG",
  roles, ...extra,
});
const orRoute = (id, modelId, roles, qualityScore) => ({
  ...routeBase,
  routeId: `openrouter-${id}`, providerId: "openrouter", modelId, canonicalModelId: modelId.replace(/:free$/, ""),
  family: modelId.split("/")[0], gateway: "openrouter",
  capacityPoolId: "openrouter:account-free", capacityPoolScope: "SHARED_OWNER_POOL",
  capacityScope: "ACCOUNT", capacityIdentity: "or-owner-account",
  // The 1000/day account counter is shared across :free models — one pool, counted once.
  windows: [window("requests", 1000, "ACCOUNT")],
  roles, qualityScore,
});

// Owner-pool fleet (postures 1 & 2).
const ownerFleet = [
  groqPool("gpt-oss-120b", "openai/gpt-oss-120b", ["coder", "explorer"], {
    qualityScore: 84,
    windows: [window("requests", 1000), window("input_tokens", 200_000), window("output_tokens", 200_000)],
  }),
  groqPool("gpt-oss-20b", "openai/gpt-oss-20b", ["coder", "explorer"], {
    qualityScore: 78,
    windows: [window("requests", 1000), window("input_tokens", 200_000), window("output_tokens", 200_000)],
  }),
  groqPool("qwen3.8-27b", "qwen/qwen3.8-27b", ["coder", "explorer", "planner", "reviewer"], {
    qualityScore: 80,
    windows: [window("requests", 1000)],
  }),
  orRoute("nex-n2.5-pro", "nex-agi/nex-n2.5-pro:free", ["coder", "explorer"], 78),
  orRoute("nemotron-3-ultra", "nvidia/nemotron-3-ultra-550b-a55b:free", ["coder", "explorer"], 76),
  orRoute("nemotron-3.5-lightning", "nvidia/nemotron-3.5-lightning:free", ["coder"], 72),
];

const pools = [
  { poolId: "groq:openai/gpt-oss-120b", providerId: "groq", scope: "ORG", supplyClass: "PURE_MANAGED_FREE", windows: [window("requests", 1000), window("input_tokens", 200_000), window("output_tokens", 200_000)] },
  { poolId: "groq:openai/gpt-oss-20b", providerId: "groq", scope: "ORG", supplyClass: "PURE_MANAGED_FREE", windows: [window("requests", 1000), window("input_tokens", 200_000), window("output_tokens", 200_000)] },
  { poolId: "groq:qwen/qwen3.8-27b", providerId: "groq", scope: "ORG", supplyClass: "PURE_MANAGED_FREE", windows: [window("requests", 1000)] },
  { poolId: "openrouter:account-free", providerId: "openrouter", scope: "SHARED_OWNER_POOL", supplyClass: "PURE_MANAGED_FREE", capacityIdentity: "or-owner-account", windows: [window("requests", 1000, "ACCOUNT")] },
];

// Posture 3: the same physical routes carried on each user's own account.
const userConnectedFleet = ownerFleet.map((r) => ({
  ...r,
  supplyClass: "USER_CONNECTED_FREE",
  capacityPoolScope: "PER_USER_POOL",
  capacityPoolId: `${r.capacityPoolId}:per-user`,
  freeOnlyAdmissionProven: true,
}));
const userPools = pools.map((p) => ({ ...p, poolId: `${p.poolId}:per-user`, scope: "PER_USER_POOL", supplyClass: "USER_CONNECTED_FREE", capacityIdentity: undefined }));

// Measured R26 pilot demand (quota-forecast-r26.json measuredDemand): 10.75 calls, 29,880 tok/run.
const taskDemand = {
  taskKind: "r26-measured-engineering-task",
  requests: 11,
  inputTokens: 22_410,
  outputTokens: 7_470,
  roleRequests: { explorer: 1, planner: 1, coder: 8, reviewer: 1 },
};

const scenarios = [];
for (const registeredUsers of [1, 50, 100, 200, 373, 500, 1000]) {
  scenarios.push({ id: `registered-${registeredUsers}`, registeredUsers, dailyActiveUsers: registeredUsers, newUsers: Math.min(registeredUsers, 1), tasksPerActiveUser: 1, taskDemand, now });
}
for (const dailyActiveUsers of [75, 150, 373]) {
  scenarios.push({ id: `registered-373-dau-${dailyActiveUsers}`, registeredUsers: 373, dailyActiveUsers, newUsers: Math.min(25, dailyActiveUsers), tasksPerActiveUser: 2, taskDemand, now });
}
scenarios.push(
  { id: "top-provider-outage", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand, failedProviders: ["groq"], now },
  { id: "gateway-outage", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand, failedGateways: ["openrouter"], now },
  { id: "50-huge-vs-50-normal", registeredUsers: 100, dailyActiveUsers: 100, newUsers: 0, tasksPerActiveUser: 1, taskDemand, heavyUsers: 50, hugeTaskMultiplier: 8, now },
);

const postures = {
  // Production admission today: owner-pool routes are not managed-multi-user cleared.
  productPosture: {
    routes: ownerFleet.map((r) => ({ ...r, managedMultiUserAllowed: false })),
    pools,
  },
  termsClearedCeiling: {
    routes: ownerFleet.map((r) => ({ ...r, managedMultiUserAllowed: true })),
    pools,
  },
  userConnected: {
    routes: userConnectedFleet.map((r) => ({ ...r, managedMultiUserAllowed: true })),
    pools: userPools,
  },
};

const out = { schema: "codeforge-r26-capacity-v1", generatedAt: new Date(now).toISOString(), deterministic: true, demand: taskDemand, postures: {} };
for (const name of ["productPosture", "termsClearedCeiling"]) {
  // simulateScale accepts only {routes, scenarios, qualityFloor} — pool windows equal their
  // routes' windows here, so the engine's inferred-pool path is equivalent.
  out.postures[name] = simulateScale({ routes: postures[name].routes, scenarios });
}
// simulateScale never forwards activeUsers to forecastCapacity, so PER_USER_POOL scaling must go
// through the forecast engine directly: capacity = per-user pool units × dailyActiveUsers.
out.postures.userConnected = scenarios.map((scenario) => {
  const demand = Math.ceil(scenario.dailyActiveUsers * scenario.tasksPerActiveUser
    * (1 + Math.max(0, scenario.heavyUsers ?? 0) * Math.max(0, (scenario.hugeTaskMultiplier ?? 1) - 1) / Math.max(1, scenario.dailyActiveUsers)));
  const failed = new Set([...(scenario.failedProviders ?? []), ...(scenario.failedGateways ?? [])]);
  const routes = postures.userConnected.routes.filter((r) => !failed.has(r.providerId) && !failed.has(r.gateway));
  const forecast = forecastCapacity({ routes, pools: postures.userConnected.pools.filter((p) => routes.some((r) => r.capacityPoolId === p.poolId)), taskDemand, now, activeUsers: scenario.dailyActiveUsers });
  const blocks = Math.max(0, demand - forecast.estimatedTaskUnits);
  return {
    scenarioId: scenario.id, registeredUsers: scenario.registeredUsers, dailyActiveUsers: scenario.dailyActiveUsers,
    demand: { totalTasks: demand },
    capacity: { totalTasks: forecast.estimatedTaskUnits },
    outcomes: {
      normalSuccessRate: demand > 0 ? Number((Math.min(demand, forecast.estimatedTaskUnits) / demand).toFixed(6)) : 1,
      capacityBlocks: blocks,
      p95WaitMinutes: blocks === 0 ? 0 : Math.ceil((blocks / Math.max(1, forecast.estimatedTaskUnits)) * 60),
    },
    alerts: forecast.alerts,
  };
});

const evidenceDir = path.join(root, "docs", "evidence", "r26-production-readiness");
fs.writeFileSync(path.join(evidenceDir, "capacity-model-r26.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8");

const rows = (posture) => out.postures[posture].map((r) =>
  `| ${r.scenarioId} | ${r.demand.totalTasks} | ${r.capacity.totalTasks} | ${(r.outcomes.normalSuccessRate * 100).toFixed(1)}% | ${r.outcomes.capacityBlocks} | ${r.outcomes.p95WaitMinutes} |`);
const table = (posture) => [
  "| Scenario | Demand (tasks) | Counted capacity | Normal success | Blocks | p95 wait (min) |",
  "|---|---:|---:|---:|---:|---:|",
  ...rows(posture),
].join("\n");

const md = `# R26 capacity / 373-DAU model

**Date:** 2026-09-22 · engine: \`simulateScale\` (forge-zero capacity-simulator, current contract)
**Demand:** measured R26 pilot — ${taskDemand.requests} calls, ${taskDemand.inputTokens + taskDemand.outputTokens} tokens per task (vs R4's synthetic 4 calls / 2,100 tokens)
**Fleet:** the 6 R26-qualified live routes only — Groq gpt-oss-120b / gpt-oss-20b / qwen3.8-27b (per-model daily buckets) + one shared OpenRouter :free account pool (1,000 req/day, policy-modeled).

> **Stale-tooling finding:** \`scripts/r4-scale-sim.mjs\` predates the current \`CapacityRoute\`
> contract — re-run at HEAD it produces zero capacity on every scenario (its legacy
> \`capacityClass\`/\`economicSource\` fields are ignored by \`isFreeRouteEligible\`). This model
> replaces it for R26; the R4 script should not be cited again.

## Posture 1 — productPosture (production admission today)

Owner-pool routes carry \`managedMultiUserAllowed=false\` — every route is ineligible, matching
quota-forecast-r26.json's productPosture (\`MANAGED_MULTI_USER_TERMS_NOT_CLEARED\`). Product-admissible
multi-user capacity is **0 task-units/day** until terms are cleared or users connect their own accounts.

## Posture 2 — termsClearedCeiling (raw physical quota)

${table("termsClearedCeiling")}

## Posture 3 — userConnected (each user's own :free account, PER_USER_POOL)

${table("userConnected")}

## Reading

- The binding constraint is **tokens, not requests**: each Groq pool yields ~⌊200k/22.4k⌋ = 8
  tasks/day at measured demand; the requests-only pools (qwen, OpenRouter account) yield ~90 each.
- Physical ceiling ≈ **${out.postures.termsClearedCeiling.find((r) => r.scenarioId === "registered-373")?.capacity.totalTasks ?? "?"} task-units/day** — 373 registered users at 1 task/day
  is borderline; the honest product-entitlement ceiling is lower once fairness/concentration apply.
- The architectural scaling path is Posture 3: user-connected :free accounts scale capacity
  linearly with DAU, which is why Phase 6 fairness work matters more than raw fleet size.
- Caveats: qwen's 1k OTPM cap makes it unusable for production-shaped (4,096-token) calls — it
  serves planner/reviewer-sized calls only; gpt-oss-20b's 8k TPM window saturates under burst load.
`;
fs.writeFileSync(path.join(evidenceDir, "R26-CAPACITY.md"), md, "utf8");
console.log(JSON.stringify({ out: "capacity-model-r26.json + R26-CAPACITY.md", ceiling373: out.postures.termsClearedCeiling.find((r) => r.scenarioId === "registered-373") }, null, 2));
