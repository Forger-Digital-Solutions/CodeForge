// R41 deterministic 373-user preference/concentration and 429-rebalance simulation.
// Simulated free capacity, not a live-provider claim or a replay of R40's harness.
import { readFile, writeFile } from "node:fs/promises";
import { CapacityReservationLedger } from "../packages/forge-zero/dist/index.js";
import { createFreeFabric, createEightBitRouteHealthAuthority, roleQualityAdvice } from "../packages/eight-bit/dist/index.js";
import { roleOutputBudget } from "../packages/server/dist/role-output-budget.js";

const OUT = process.argv[2] ?? "docs/evidence/r41-role-intelligence/R41-SCALE.json";
const evidence = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-ROLE-PROFILES.json", "utf8"));
const preflight = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
const now0 = Date.parse("2026-09-26T14:30:00.000Z");
let now = now0;
const USERS = 373, TASKS_PER_USER = 2, INJECTED_429 = 50, CONCURRENCY_PER_PROVIDER = 16;
const WINDOW_REQUESTS = 2_000, WINDOW_INPUT = 4_000_000, WINDOW_OUTPUT = 4_000_000;
const routeSpec = [
  { providerId: "mistral", modelId: "codestral-latest", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER"], fallbackRoles: [] },
  { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], fallbackRoles: ["PLANNER"] },
  { providerId: "openrouter", modelId: "cohere/north-mini-code:free", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT"], fallbackRoles: ["SUBAGENT"] },
  // R40 live-qualified Coder; Groq reviewer was NOT_TESTED under R41 TPM pressure.
  { providerId: "groq", modelId: "openai/gpt-oss-120b", qualityScore: 76, roles: ["PRIMARY_CODING_AGENT"], fallbackRoles: ["SUBAGENT"] },
];
const receiptByRoute = new Map(evidence.routes.map((r) => [`${r.providerId}/${r.modelId}`, r.receipt]));
for (const spec of routeSpec) {
  const current = preflight.providers.find((p) => p.provider === spec.providerId && p.httpStatus === 200)?.models?.find((m) => m.id === spec.modelId);
  if (!current || spec.providerId === "openrouter" && (!spec.modelId.endsWith(":free") || Number(current.pricing?.prompt) !== 0 || Number(current.pricing?.completion) !== 0)) {
    throw new Error("Scale fixture lacks current free catalog proof");
  }
}
const iso = () => new Date(now).toISOString();
const window = (unit, limit) => ({ unit, limit, remaining: limit, resetAt: new Date(now0 + 86_400_000).toISOString(), scope: "ORG", observedAt: iso(), authoritative: true, period: unit === "concurrency" ? "CONTINUOUS" : "DAILY_RESET" });
const poolFor = (providerId) => ({
  poolId: `r41:${providerId}`, providerId, scope: "SHARED_OWNER_POOL",
  supplyClass: "PURE_MANAGED_FREE", observedAt: iso(), authoritative: true,
  windows: [window("requests", WINDOW_REQUESTS), window("input_tokens", WINDOW_INPUT), window("output_tokens", WINDOW_OUTPUT), window("concurrency", CONCURRENCY_PER_PROVIDER)],
});
const pools = ["mistral", "openrouter", "groq"].map(poolFor);
const routes = routeSpec.map((s) => ({
  routeId: `r41:${s.providerId}/${s.modelId}`, providerId: s.providerId, modelId: s.modelId,
  canonicalModelId: s.modelId, family: s.modelId, gateway: s.providerId,
  supplyClass: "PURE_MANAGED_FREE", capacityPoolId: `r41:${s.providerId}`,
  capacityPoolScope: "SHARED_OWNER_POOL", capacityScope: "ORG",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED",
  explicitZeroPrice: true, paidFallbackDisabled: true, managedMultiUserAllowed: true,
  privacyClass: "standard", roles: s.roles, fallbackRoles: s.fallbackRoles,
  qualityScore: s.qualityScore, healthy: true, enabled: true, contextWindow: 64_000,
  windows: pools.find((p) => p.providerId === s.providerId).windows,
}));
const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => now, maxActiveReservationsPerUser: 1 });
const health = createEightBitRouteHealthAuthority(undefined, () => now);
const fabric = createFreeFabric({ managedRoutes: () => routes, managedPools: () => pools, reservations, health, now: () => now });
const pending = Array.from({ length: USERS }, (_, i) => ({ id: `user-${i}:coder`, userId: `user-${i}`, role: "CODER", productRole: "PRIMARY_CODING_AGENT" }));
const second = Array.from({ length: USERS }, (_, i) => ({ id: `user-${i}:reviewer`, userId: `user-${i}`, role: "REVIEWER", productRole: "REVIEWER" }));
const servedByRoute = Object.fromEntries(routes.map((r) => [r.routeId, 0]));
const servedByProvider = { mistral: 0, openrouter: 0, groq: 0 };
let completed = 0, injected429 = 0, starved = 0, falseWaits = 0, peakHolds = 0, queued = 0, rounds = 0, recovered = 0;
const awaitingRecovery = new Set();
const results = [];
for (const phase of [pending, second]) {
  let backlog = phase;
  while (backlog.length && rounds < 200) {
    rounds++;
    const held = [];
    const next = [];
    for (const task of backlog) {
      const demand = (providerId, modelId) =>
        roleOutputBudget({ role: task.role.toLowerCase(), providerId, modelId }).outputTokenDemand;
      const decision = fabric.decide({
        requestId: task.id, userId: task.userId, role: task.productRole, healthRole: task.role,
        leaseMs: 10_000,
        demand: { requests: 1, inputTokens: 1_500, outputTokens: 4_096, outputTokensFor: demand },
        roleQualityAdjustment: (providerId, modelId) => {
          const advice = roleQualityAdvice(receiptByRoute.get(`${providerId}/${modelId}`), task.role, now);
          return { scoreAdjustment: advice.scoreAdjustment, reasonCodes: advice.reasonCodes };
        },
      });
      if (decision.outcome === "ADMITTED" && decision.selected) {
        if (!routes.some((r) => r.routeId === decision.selected.routeId && r.explicitZeroPrice && r.paidFallbackDisabled)) throw new Error("Paid route selected");
        held.push({ task, route: decision.selected });
        peakHolds = Math.max(peakHolds, reservations.snapshot().activeReservations);
      } else if (decision.outcome === "QUEUED_FOR_CAPACITY") {
        queued++;
        // A false wait requires at least one eligible candidate with spare physical concurrency
        // and an unblocked quota window; otherwise this is a real bounded capacity wait.
        const active = reservations.snapshot().byPool;
        const candidateFree = decision.explanation.candidates.some((c) =>
          c.status === "CAPACITY_DENIED"
          && (active[`r41:${c.providerId}`] ?? 0) < CONCURRENCY_PER_PROVIDER);
        if (candidateFree) falseWaits++;
        next.push(task);
      } else {
        starved++;
        results.push({ task: task.id, outcome: decision.outcome, reasons: decision.explanation.reasonCodes });
      }
    }
    if (held.length === 0 && next.length > 0) {
      // The short injected 429 is a real wait, not dead work; advance virtual time to reset.
      now += 1_000;
      backlog = next;
      continue;
    }
    for (const item of held) {
      servedByRoute[item.route.routeId]++;
      servedByProvider[item.route.providerId]++;
      completed++;
      reservations.release(item.route.reservationId ?? item.task.id);
      if (injected429 < INJECTED_429 && completed % 12 === 0) {
        health.observe({
          kind: "call_failure", providerId: item.route.providerId, modelId: item.route.modelId,
          observedAt: iso(), source: "runtime", reason: "RATE_LIMITED", status: 429,
          retryAfterMs: 3_000, message: "429 requests per minute", role: item.task.role,
        });
        awaitingRecovery.add(`${item.route.providerId}/${item.route.modelId}`);
        injected429++;
      }
    }
    now += 1_000;
    for (const key of [...awaitingRecovery]) {
      const r = routes.find((route) => `${route.providerId}/${route.modelId}` === key);
      if (r && health.assess(r.providerId, r.modelId).state !== "RATE_LIMITED") {
        recovered++;
        awaitingRecovery.delete(key);
      }
    }
    backlog = next;
  }
  if (backlog.length) starved += backlog.length;
}
const activeEnd = reservations.snapshot().activeReservations;
const report = { at: new Date().toISOString(), evidenceClass: "deterministic simulated capacity; not live 373 users", users: USERS, tasks: USERS * TASKS_PER_USER, completed, starved, queuedCapacityAttempts: queued, falseWaits, leakedReservations: activeEnd, injected429, peakHolds, rounds, servedByRoute, servedByProvider, providerConcentration: Math.max(...Object.values(servedByProvider)) / Math.max(1, completed), reenteredHealthyObservations: recovered, routeCount: routes.length, poolCount: pools.length, failureSamples: results.slice(0, 10), parameters: { concurrencyPerProvider: CONCURRENCY_PER_PROVIDER, requestWindow: WINDOW_REQUESTS, inputWindow: WINDOW_INPUT, outputWindow: WINDOW_OUTPUT, initialInputDemand: 1_500, maxOutputDemand: 4_096, injected429EveryCompleted: 12, injected429RetryAfterMs: 3_000 } };
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (completed !== USERS * TASKS_PER_USER || starved || falseWaits || activeEnd || injected429 !== INJECTED_429) process.exitCode = 1;
