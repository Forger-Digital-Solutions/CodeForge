// R44 provider-saturation campaign — the §12/§14 no-false-waiting matrix over the real
// production decide path: FreeFabric.decide + CapacityReservationLedger + RouteHealthAuthority
// + live receipt consultation. Deterministic simulated capacity; no live-provider traffic.
//
//   node scripts/r44-provider-saturation.mjs <outDir> [scenario|all]
//
// Scenarios: the §14 matrix — qualified-exhausted/qualified-healthy, qualified-exhausted/
// probation-healthy, stale/qualified, unhealthy/alternate-provider, role-mismatch/valid-peer,
// expired/requalified, openrouter-limited/peer-healthy, all-exhausted fail-closed, provider
// recovery re-entry, catalog removal. Every ADMITTED decision is billing-checked.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapacityReservationLedger } from "../packages/forge-zero/dist/index.js";
import {
  createFreeFabric,
  createEightBitRouteHealthAuthority,
  receiptSuiteSupported,
  roleAdmissionAllowed,
  roleQualityAdvice,
  roleQualificationStatusFor,
} from "../packages/eight-bit/dist/index.js";
import { roleOutputBudget } from "../packages/server/dist/role-output-budget.js";

const DAY = 86_400_000;
const now0 = Date.parse("2026-10-10T00:00:00.000Z");
let now = now0;
const iso = () => new Date(now).toISOString();
const OUT_DIR = process.argv[2] ?? "docs/evidence/r44-provider-saturation";
const ONLY = process.argv[3] ?? "all";
const EVIDENCE = "deterministic simulated capacity; not live-provider traffic";
const SUITE = "R41_ROLE_QUALIFICATION_V3";

const window = (unit, limit) => ({
  unit, limit, remaining: limit,
  resetAt: new Date(now0 + DAY).toISOString(),
  scope: "ORG", observedAt: iso(), authoritative: true,
  period: unit === "concurrency" ? "CONTINUOUS" : "DAILY_RESET",
});
const mkPool = (providerId, over = {}) => ({
  poolId: `r44:${providerId}`, providerId, scope: "SHARED_OWNER_POOL",
  supplyClass: "PURE_MANAGED_FREE", observedAt: iso(), authoritative: true,
  windows: [
    window("requests", over.requests ?? 2_000),
    window("input_tokens", over.input ?? 4_000_000),
    window("output_tokens", over.output ?? 4_000_000),
    window("concurrency", over.concurrency ?? 16),
  ],
});
const mkRoute = (spec, pools) => ({
  routeId: `r44:${spec.providerId}/${spec.modelId}`,
  providerId: spec.providerId, modelId: spec.modelId,
  canonicalModelId: spec.modelId, family: spec.modelId, gateway: spec.providerId,
  supplyClass: "PURE_MANAGED_FREE", capacityPoolId: `r44:${spec.providerId}`,
  capacityPoolScope: "SHARED_OWNER_POOL", capacityScope: "ORG",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED",
  explicitZeroPrice: true, paidFallbackDisabled: true, managedMultiUserAllowed: true,
  privacyClass: "standard", roles: spec.roles, fallbackRoles: spec.fallbackRoles ?? [],
  qualityScore: spec.qualityScore ?? 75, healthy: true, enabled: true,
  contextWindow: spec.contextWindow ?? 64_000,
  windows: pools.find((p) => p.providerId === spec.providerId).windows,
});
const caseOf = (passed, i, error) => ({
  caseId: `c${i}`, category: "synthetic", passed, hardFailure: !passed && !error,
  latencyMs: 900, retries: 0, ...(error ? { error } : {}),
});
const verdict = (role, status, passes, total, completedAt) => ({
  role, status,
  testCases: Array.from({ length: total }, (_, i) => caseOf(i < passes, i)),
  hardFailures: status === "HARD_FAILURE" ? ["synthetic-hard"] : [],
  overallScore: total ? passes / total : 0,
  startedAt: completedAt, completedAt,
});
const mkReceipt = (providerId, modelId, roles, ageDays = 1, suite = SUITE) => {
  const completedAt = new Date(now - ageDays * DAY).toISOString();
  return {
    suiteVersion: suite, providerId, modelId,
    modelDisplayName: modelId, accessClass: "FREE", freeStatus: "VERIFIED_FREE",
    roleResults: Object.fromEntries(Object.entries(roles).map(([role, [status, p, t]]) =>
      [role, verdict(role, status, p, t, completedAt)])),
    startedAt: completedAt, completedAt, totalLatencyMs: 5_000,
    qualificationState: "QUALIFIED", hardFailureRoles: [],
  };
};

const ROLE_PRODUCT = {
  CODER: "PRIMARY_CODING_AGENT", REVIEWER: "REVIEWER",
  PLANNER: "PLANNER", EXPLORER: "SUBAGENT", TOOL_AGENT: "SUBAGENT", FAST_WORKER: "SUBAGENT",
};

const mkHarness = ({ routeSpecs, pools, receiptByRoute = new Map(), excluded = new Set(), maxPerUser = 1 }) => {
  const routes = routeSpecs.map((s) => mkRoute(s, pools));
  const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => now, maxActiveReservationsPerUser: maxPerUser });
  const health = createEightBitRouteHealthAuthority(undefined, () => now);
  let activeRole;
  const fabric = createFreeFabric({
    managedRoutes: () => routes.filter((r) =>
      !excluded.has(`${r.providerId}/${r.modelId}`) &&
      (activeRole === undefined || roleAdmissionAllowed(receiptByRoute.get(`${r.providerId}/${r.modelId}`), activeRole, now))),
    managedPools: () => pools, reservations, health, now: () => now,
  });
  const decide = (task) => {
    activeRole = task.role;
    try {
      return fabric.decide({
        requestId: task.id, userId: task.userId,
        role: task.productRole ?? ROLE_PRODUCT[task.role], healthRole: task.role,
        leaseMs: 10_000,
        demand: {
          requests: 1, inputTokens: 1_500, outputTokens: 4_096,
          outputTokensFor: (p, m) =>
            roleOutputBudget({ role: task.role.toLowerCase(), providerId: p, modelId: m, now }).outputTokenDemand,
        },
        roleQualityAdjustment: (p, m) => {
          const a = roleQualityAdvice(receiptByRoute.get(`${p}/${m}`), task.role, now);
          return { scoreAdjustment: a.scoreAdjustment, reasonCodes: a.reasonCodes };
        },
      });
    } finally { activeRole = undefined; }
  };
  const zeroBillingCheck = (decision) =>
    decision.outcome !== "ADMITTED" ||
    routes.some((r) => r.routeId === decision.selected?.routeId && r.explicitZeroPrice && r.paidFallbackDisabled);
  const picks = (role, tag, n = 4, userPrefix = "u") => {
    const got = [];
    for (let i = 0; i < n; i++) {
      const d = decide({ id: `${tag}${i}`, userId: `${userPrefix}-${tag}${i}`, role });
      got.push({ outcome: d.outcome, provider: d.selected?.providerId, zero: zeroBillingCheck(d) });
      if (d.outcome === "ADMITTED") reservations.release(d.selected.reservationId ?? `${tag}${i}`);
    }
    return got;
  };
  return { routes, pools, reservations, health, fabric, decide, picks, receiptByRoute, zeroBillingCheck };
};

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const failClosedOrWait = (d) => d.outcome === "QUEUED_FOR_CAPACITY" || d.outcome === "DENIED_NO_SUPPLY";
const observe429 = (health, r, retryAfterMs = 3_000, role) => health.observe({
  kind: "call_failure", providerId: r.providerId, modelId: r.modelId,
  observedAt: iso(), source: "runtime", reason: "RATE_LIMITED", status: 429,
  retryAfterMs, message: "429 requests per minute", role,
});
const probeRecover = (health, r) => health.observe({
  kind: "probe_gate", providerId: r.providerId, modelId: r.modelId,
  observedAt: iso(), source: "probe", served: true, latencyMs: 800, requestShape: "production",
});
const pickRoute = (h, providerId) => h.routes.find((r) => r.providerId === providerId);
const allZeroBilling = (picksArr) => picksArr.every((p) => p.zero !== false);

// S1: QUALIFIED saturated → QUALIFIED healthy peer serves. No waiting while a peer is usable.
async function scenarioQualifiedVsQualified() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 85 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 2)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4] }, 2)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const pre = h.picks("CODER", "qq-pre-");
  check("qualified-vs-qualified: healthy qualified route serves before saturation",
    pre.every((p) => p.provider === "mistral") && allZeroBilling(pre), JSON.stringify(pre));

  for (let i = 0; i < 3; i++) observe429(h.health, pickRoute(h, "mistral"), 120_000, "CODER");
  check("qualified-vs-qualified: 429 burst parks the preferred QUALIFIED route",
    h.health.assess("mistral", "codestral-latest").state === "RATE_LIMITED");

  const during = h.picks("CODER", "qq-mid-");
  check("qualified-vs-qualified: healthy QUALIFIED peer serves — zero waits while a peer is usable",
    during.every((p) => p.outcome === "ADMITTED" && p.provider === "openrouter") && allZeroBilling(during), JSON.stringify(during));
  check("qualified-vs-qualified: parked route does not enter the candidate set as selected",
    during.every((p) => p.provider !== "mistral"));
  check("qualified-vs-qualified: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "qualifiedVsQualified" };
}

// S2: QUALIFIED exhausted + PROBATION healthy → probation admits (§14 explicit combination).
async function scenarioQualifiedVsProbation() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 70 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 2)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["PROBATION", 2, 4] }, 2)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  for (let i = 0; i < 3; i++) observe429(h.health, pickRoute(h, "mistral"), 120_000, "CODER");
  const picks = h.picks("CODER", "qp-");
  check("qualified-vs-probation: QUALIFIED-exhausted does not block a healthy PROBATION peer",
    picks.every((p) => p.outcome === "ADMITTED" && p.provider === "openrouter") && allZeroBilling(picks), JSON.stringify(picks));
  check("qualified-vs-probation: probation verdict remains legible in the role evidence",
    roleQualificationStatusFor(receipts.get("openrouter/nvidia/nemotron-3-super-120b-a12b:free"), "CODER", now) === "PROBATION");
  check("qualified-vs-probation: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "qualifiedVsProbation" };
}

// S3: STALE evidence + QUALIFIED peer — stale stays eligible but loses ordering trust.
async function scenarioStaleVsQualified() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 31)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4] }, 1)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  check("stale-vs-qualified: >30d receipt reads as expired (no verdict)",
    roleQualificationStatusFor(receipts.get("mistral/codestral-latest"), "CODER", now) === undefined);
  check("stale-vs-qualified: stale evidence never excludes — legacy eligibility preserved",
    roleAdmissionAllowed(receipts.get("mistral/codestral-latest"), "CODER", now) === true);
  const picks = h.picks("CODER", "sq-");
  check("stale-vs-qualified: fresh QUALIFIED evidence outranks the stale route",
    picks.every((p) => p.provider === "openrouter") && allZeroBilling(picks), JSON.stringify(picks));
  const advice = roleQualityAdvice(receipts.get("mistral/codestral-latest"), "CODER", now);
  check("stale-vs-qualified: stale route flags bounded requalification, not quarantine",
    advice.needsRequalification === true && advice.reasonCodes.includes("ROLE_EVIDENCE_STALE"), JSON.stringify(advice.reasonCodes));
  return { name: "staleVsQualified" };
}

// S4: route unhealthy on one provider → alternate provider healthy serves (cross-provider failover).
async function scenarioCrossProviderFailover() {
  const pools = [mkPool("openrouter"), mkPool("groq"), mkPool("mistral")];
  const specs = [
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 88 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 82 },
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const receipts = new Map(specs.map((s) => [
    `${s.providerId}/${s.modelId}`,
    mkReceipt(s.providerId, s.modelId, { CODER: ["QUALIFIED", 4, 4] }, 1),
  ]));
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  for (let i = 0; i < 3; i++) observe429(h.health, pickRoute(h, "openrouter"), 180_000, "CODER");
  const picks = h.picks("CODER", "cp-");
  check("cross-provider: OpenRouter-limited fails over to a healthy peer provider",
    picks.every((p) => p.outcome === "ADMITTED" && (p.provider === "groq" || p.provider === "mistral")) && allZeroBilling(picks), JSON.stringify(picks));
  check("cross-provider: the limited provider is never selected while parked",
    picks.every((p) => p.provider !== "openrouter"));
  // Provider recovery: probe success clears the park, the route re-enters and wins again.
  now += 181_000;
  probeRecover(h.health, pickRoute(h, "openrouter"));
  const post = h.picks("CODER", "cp-post-", 3);
  check("cross-provider: recovered provider re-enters rotation after a probe success",
    post.some((p) => p.provider === "openrouter") && allZeroBilling(post), JSON.stringify(post));
  check("cross-provider: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "crossProviderFailover" };
}

// S5: role-mismatched route is never a candidate; the role-valid peer serves.
async function scenarioRoleMismatch() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 95 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["REVIEWER"], qualityScore: 60 },
  ];
  const h = mkHarness({ routeSpecs: specs, pools });
  const d = h.decide({ id: "rm-1", userId: "u-rm", role: "REVIEWER" });
  check("role-mismatch: REVIEWER work lands on the reviewer-role route, never the coder-only route",
    d.outcome === "ADMITTED" && d.selected.providerId === "openrouter" && h.zeroBillingCheck(d),
    `${d.outcome}:${d.selected?.providerId}`);
  if (d.outcome === "ADMITTED") h.reservations.release(d.selected.reservationId ?? "rm-1");
  const coder = h.decide({ id: "rm-2", userId: "u-rm2", role: "CODER" });
  check("role-mismatch: CODER work lands on the coder-role route",
    coder.outcome === "ADMITTED" && coder.selected.providerId === "mistral" && h.zeroBillingCheck(coder),
    `${coder.outcome}:${coder.selected?.providerId}`);
  if (coder.outcome === "ADMITTED") h.reservations.release(coder.selected.reservationId ?? "rm-2");
  return { name: "roleMismatch" };
}

// S6: expired receipt → bounded requalification → fresh receipt reopens verdicts (mid-campaign).
async function scenarioExpiredRequalification() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 85 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 85 },
  ];
  const keyA = "mistral/codestral-latest";
  const receipts = new Map([
    [keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["HARD_FAILURE", 0, 4] }, 5)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4] }, 1)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const p1 = h.picks("CODER", "er-pre-");
  check("expired-requalification: current HARD_FAILURE receipt excludes the route",
    p1.every((p) => p.provider === "openrouter") && allZeroBilling(p1), JSON.stringify(p1));

  now += 26 * DAY;
  check("expired-requalification: expired HARD_FAILURE reverts to legacy eligibility",
    roleAdmissionAllowed(receipts.get(keyA), "CODER", now) === true);
  receipts.set(keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 0));
  const p2 = h.picks("CODER", "er-post-");
  check("expired-requalification: fresh receipt restores the route on the next decide",
    p2.some((p) => p.provider === "mistral") && allZeroBilling(p2), JSON.stringify(p2));
  check("expired-requalification: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "expiredRequalification" };
}

// S7: every eligible route capacity-blocked → QUEUED, never paid. The only legal wait.
async function scenarioAllExhaustedFailsClosed() {
  const pools = [mkPool("mistral", { requests: 0, input: 0, output: 0, concurrency: 0 }), mkPool("openrouter", { requests: 0, input: 0, output: 0, concurrency: 0 })];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 85 },
  ];
  const receipts = new Map(specs.map((s) => [`${s.providerId}/${s.modelId}`, mkReceipt(s.providerId, s.modelId, { CODER: ["QUALIFIED", 4, 4] }, 1)]));
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const d = h.decide({ id: "ae-1", userId: "u-ae", role: "CODER" });
  check("all-exhausted: genuinely exhausted supply queues instead of inventing capacity",
    failClosedOrWait(d), `${d.outcome}`);
  check("all-exhausted: a queued decision selects nothing — nothing billable is held",
    d.selected === undefined || d.selected === null);
  check("all-exhausted: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "allExhaustedFailsClosed" };
}

// S8: catalog removal excludes the route mid-run; a peer continues serving.
async function scenarioCatalogRemoval() {
  const pools = [mkPool("mistral"), mkPool("groq")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const receipts = new Map(specs.map((s) => [`${s.providerId}/${s.modelId}`, mkReceipt(s.providerId, s.modelId, { CODER: ["QUALIFIED", 4, 4] }, 1)]));
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const removed = pickRoute(h, "mistral");
  h.health.observe({
    kind: "catalog", providerId: removed.providerId, modelId: removed.modelId,
    observedAt: iso(), source: "catalog", fact: "retired",
  });
  check("catalog-removal: a retired model reads MODEL_RETIRED (hard exclusion)",
    h.health.assess("mistral", "codestral-latest").state === "MODEL_RETIRED");
  const picks = h.picks("CODER", "cr-");
  check("catalog-removal: retired route never serves; healthy peer absorbs the work",
    picks.every((p) => p.outcome === "ADMITTED" && p.provider === "groq") && allZeroBilling(picks), JSON.stringify(picks));
  check("catalog-removal: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "catalogRemoval" };
}

const SCENARIOS = {
  qualifiedQualified: scenarioQualifiedVsQualified,
  qualifiedProbation: scenarioQualifiedVsProbation,
  staleQualified: scenarioStaleVsQualified,
  crossProvider: scenarioCrossProviderFailover,
  roleMismatch: scenarioRoleMismatch,
  expiredRequalification: scenarioExpiredRequalification,
  allExhausted: scenarioAllExhaustedFailsClosed,
  catalogRemoval: scenarioCatalogRemoval,
};

await mkdir(OUT_DIR, { recursive: true });
const wanted = ONLY === "all" ? Object.keys(SCENARIOS) : ONLY.split(",");
const results = [];
for (const name of wanted) {
  const before = checks.length;
  const result = await SCENARIOS[name]();
  results.push({ ...result, checks: checks.slice(before) });
}
const failed = checks.filter((c) => !c.pass);
await writeFile(join(OUT_DIR, "R44-PROVIDER-SATURATION.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  evidenceClass: EVIDENCE,
  scenarios: results.map((r) => ({ ...r, checks: r.checks.map((c) => c.name) })),
  checks,
  totals: { pass: checks.length - failed.length, fail: failed.length },
}, null, 2));
console.log(`R44 provider-saturation sim: ${checks.length - failed.length}/${checks.length} checks pass`);
for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
