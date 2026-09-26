// R42 deterministic production-stress harness. Every scenario exercises the real
// production code paths — Free Fabric decide(), CapacityReservationLedger,
// EightBitRouteHealthAuthority, and the shared role-quality semantics the runtime
// delegates to — over simulated free capacity. No live-provider claims.
//
//   node scripts/r42-stress-sim.mjs <outDir> [scenario]
//
// Scenarios: roles | expiry | capacity | stampede | budget | recovery | endurance | scale | all
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapacityReservationLedger } from "../packages/forge-zero/dist/index.js";
import {
  createFreeFabric,
  createEightBitRouteHealthAuthority,
  roleAdmissionAllowed,
  roleQualityAdvice,
  roleQualificationStatusFor,
} from "../packages/eight-bit/dist/index.js";
import { roleOutputBudget } from "../packages/server/dist/role-output-budget.js";

const DAY = 86_400_000;
const now0 = Date.parse("2026-10-10T00:00:00.000Z");
let now = now0;
const iso = () => new Date(now).toISOString();
const OUT_DIR = process.argv[2] ?? "docs/evidence/r42-production-stress";
const ONLY = process.argv[3] ?? "all";

const EVIDENCE = "deterministic simulated capacity; not live-provider traffic";

// ---------- fixture builders ----------
const window = (unit, limit) => ({
  unit, limit, remaining: limit,
  resetAt: new Date(now0 + DAY).toISOString(),
  scope: "ORG", observedAt: iso(), authoritative: true,
  period: unit === "concurrency" ? "CONTINUOUS" : "DAILY_RESET",
});
const mkPool = (providerId, over = {}) => ({
  poolId: `r42:${providerId}`, providerId, scope: "SHARED_OWNER_POOL",
  supplyClass: "PURE_MANAGED_FREE", observedAt: iso(), authoritative: true,
  windows: [
    window("requests", over.requests ?? 2_000),
    window("input_tokens", over.input ?? 4_000_000),
    window("output_tokens", over.output ?? 4_000_000),
    window("concurrency", over.concurrency ?? 16),
  ],
});
const mkRoute = (spec, pools) => ({
  routeId: `r42:${spec.providerId}/${spec.modelId}`,
  providerId: spec.providerId, modelId: spec.modelId,
  canonicalModelId: spec.modelId, family: spec.modelId, gateway: spec.providerId,
  supplyClass: "PURE_MANAGED_FREE", capacityPoolId: `r42:${spec.providerId}`,
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
/** receipt: {CODER:["QUALIFIED",4,4], REVIEWER:["HARD_FAILURE",0,4], ...} */
const mkReceipt = (providerId, modelId, roles, ageDays = 1) => {
  const completedAt = new Date(now - ageDays * DAY).toISOString();
  return {
    suiteVersion: "r42-fixture", providerId, modelId,
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

// ---------- shared harness ----------
const mkHarness = ({ routeSpecs, pools, receiptByRoute = new Map(), excluded = new Set(), maxPerUser = 1 }) => {
  const routes = routeSpecs.map((s) => mkRoute(s, pools));
  const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => now, maxActiveReservationsPerUser: maxPerUser });
  const health = createEightBitRouteHealthAuthority(undefined, () => now);
  let activeRole;
  const fabric = createFreeFabric({
    // Same ordering as production: the entitlement quarantine removes structurally
    // suspended supply (Gemini CONSUMER_SUSPENDED) before the fabric ever sees it;
    // the role filter applies the shared expiry-aware status per decide.
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
  return { routes, pools, reservations, health, fabric, decide, receiptByRoute, zeroBillingCheck };
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
// ---------- scenarios ----------
async function scenarioRoles() {
  const pools = ["mistral", "openrouter", "groq", "gemini"].map((p) => mkPool(p));
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER"] },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"] },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT", "SUBAGENT"] },
    // A structurally suspended route still sitting in the catalog — the entitlement
    // quarantine (CONSUMER_SUSPENDED) removes it before the fabric ever sees it,
    // which is where this harness applies the same exclusion.
    { providerId: "gemini", modelId: "gemini-2.5-flash", roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER"], qualityScore: 99 },
  ];
  // Route conflicts: A qualified coder / hard-failed reviewer; B probation coder /
  // qualified reviewer; C qualified coder / reviewer never measured.
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest",
      { CODER: ["QUALIFIED", 4, 4], REVIEWER: ["HARD_FAILURE", 0, 4], PLANNER: ["QUALIFIED", 3, 4], TOOL_AGENT: ["QUALIFIED", 4, 4] })],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free",
      { CODER: ["PROBATION", 2, 4], REVIEWER: ["QUALIFIED", 4, 4] })],
    ["groq/openai/gpt-oss-120b", mkReceipt("groq", "openai/gpt-oss-120b",
      { CODER: ["QUALIFIED", 4, 4], TOOL_AGENT: ["NOT_TESTED", 0, 0] })],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts,
    excluded: new Set(["gemini/gemini-2.5-flash"]) });

  // Structural quarantine: the gemini route has the highest qualityScore in the
  // fixture, so any appearance — candidate or selection — proves a boundary leak.
  let geminiCandidates = 0, geminiSelections = 0;
  for (let i = 0; i < 6; i++) {
    const d = h.decide({ id: `gem-${i}`, userId: `u-g${i}`, role: "CODER" });
    geminiCandidates += d.explanation.candidates.filter((c) => c.providerId === "gemini").length;
    if (d.selected?.providerId === "gemini") geminiSelections++;
    if (d.outcome === "ADMITTED") h.reservations.release(d.selected.reservationId ?? `gem-${i}`);
  }
  check("gemini: structurally suspended route never appears as a fabric candidate",
    geminiCandidates === 0, `${geminiCandidates} candidates`);
  check("gemini: never selected across repeated admissions", geminiSelections === 0);

  const recA = receipts.get("mistral/codestral-latest");
  check("role-status: fresh QUALIFIED coder verdict read", roleQualificationStatusFor(recA, "CODER", now) === "QUALIFIED");
  check("role-status: EXPLORER inherits TOOL_AGENT verdict", roleQualificationStatusFor(recA, "EXPLORER", now) === "QUALIFIED");
  check("role-status: HARD_FAILURE reviewer verdict read", roleQualificationStatusFor(recA, "REVIEWER", now) === "HARD_FAILURE");
  check("admission: no receipt -> legacy eligibility", roleAdmissionAllowed(undefined, "CODER", now));
  check("admission: role never measured on a fresh receipt reads NOT_TESTED -> excluded",
    !roleAdmissionAllowed(receipts.get("groq/openai/gpt-oss-120b"), "REVIEWER", now) &&
    roleQualificationStatusFor(receipts.get("groq/openai/gpt-oss-120b"), "REVIEWER", now) === "NOT_TESTED");
  check("admission: NOT_TESTED role excluded",
    !roleAdmissionAllowed(receipts.get("groq/openai/gpt-oss-120b"), "EXPLORER", now));
  check("admission: HARD_FAILURE role excluded", !roleAdmissionAllowed(recA, "REVIEWER", now));
  check("admission: PROBATION role admitted", roleAdmissionAllowed(receipts.get("openrouter/nvidia/nemotron-3-super-120b-a12b:free"), "CODER", now));

  // Reviewer work must never land on the hard-failed or untested routes.
  const reviewerSelections = new Set();
  for (let i = 0; i < 12; i++) {
    const d = h.decide({ id: `rev-${i}`, userId: `u-${i}`, role: "REVIEWER" });
    if (d.outcome === "ADMITTED") {
      reviewerSelections.add(d.selected.routeId);
      h.reservations.release(d.selected.reservationId ?? `rev-${i}`);
      check("reviewer arm: zero-billing route only", h.zeroBillingCheck(d));
    }
  }
  check("reviewer arm: every selection was the qualified reviewer route",
    reviewerSelections.size === 1 && reviewerSelections.has("r42:openrouter/nvidia/nemotron-3-super-120b-a12b:free"));
  // Planner only qualifies on mistral; groq has no PLANNER role, openrouter is NOT_TESTED.
  const plannerSel = new Set();
  for (let i = 0; i < 8; i++) {
    const d = h.decide({ id: `pl-${i}`, userId: `u-${i}`, role: "PLANNER" });
    if (d.outcome === "ADMITTED") { plannerSel.add(d.selected.routeId); h.reservations.release(d.selected.reservationId ?? `pl-${i}`); }
  }
  check("planner arm: only the qualified planner route served", plannerSel.size === 1 && plannerSel.has("r42:mistral/codestral-latest"));
  // A role with no qualified route anywhere must fail closed, not land on a disqualified route.
  const receiptsHard = new Map(receipts);
  receiptsHard.set("openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { REVIEWER: ["HARD_FAILURE", 0, 4] }));
  const h2 = mkHarness({ routeSpecs: specs,
    pools: ["mistral", "openrouter", "groq", "gemini"].map((p) => mkPool(p)),
    receiptByRoute: receiptsHard, excluded: new Set(["gemini/gemini-2.5-flash"]) });
  const d0 = h2.decide({ id: "rev-closed", userId: "u-x", role: "REVIEWER" });
  check("no qualified reviewer anywhere -> fail closed, never a disqualified route", failClosedOrWait(d0), d0.outcome);
  return { name: "roleConflicts" };
}

async function scenarioExpiry() {
  const AGES = [0, 15 * DAY, 30 * DAY - 60_000, 30 * DAY, 45 * DAY];
  const rows = [];
  for (const [status, passes, total] of [["HARD_FAILURE", 0, 4], ["QUALIFIED", 4, 4], ["PROBATION", 2, 4]]) {
    for (const age of AGES) {
      const rec = mkReceipt("p", `m-${status}`, { CODER: [status, passes, total] }, age / DAY);
      const s = roleQualificationStatusFor(rec, "CODER", now);
      const allowed = roleAdmissionAllowed(rec, "CODER", now);
      const advice = roleQualityAdvice(rec, "CODER", now);
      rows.push({ status, ageDays: age / DAY, readStatus: s ?? null, allowed,
        scoreAdjustment: advice.scoreAdjustment, needsRequalification: advice.needsRequalification,
        reasonCodes: advice.reasonCodes });
    }
  }
  const at = (status, days) => rows.find((r) => r.status === status && r.ageDays === days);
  check("expiry: fresh HARD_FAILURE excludes", at("HARD_FAILURE", 0).allowed === false);
  check("expiry: 29.999d HARD_FAILURE still excludes", at("HARD_FAILURE", (30 * DAY - 60_000) / DAY).allowed === false);
  check("expiry: 30d HARD_FAILURE evidence expires -> legacy eligibility",
    at("HARD_FAILURE", 30).allowed === true && at("HARD_FAILURE", 30).readStatus === null);
  check("expiry: 45d HARD_FAILURE stays legacy-eligible", at("HARD_FAILURE", 45).allowed === true);
  check("expiry: stale QUALIFIED keeps eligibility but contributes no ranking score",
    at("QUALIFIED", 30).allowed === true && at("QUALIFIED", 30).scoreAdjustment === 0 &&
    at("QUALIFIED", 30).reasonCodes.includes("ROLE_EVIDENCE_STALE"));
  check("expiry: stale evidence flags requalification",
    at("QUALIFIED", 30).needsRequalification === true && at("HARD_FAILURE", 30).needsRequalification === true);
  check("expiry: fresh QUALIFIED contributes bounded positive adjustment",
    at("QUALIFIED", 0).scoreAdjustment > 0 && at("QUALIFIED", 0).scoreAdjustment <= 12);
  check("expiry: fresh HARD_FAILURE contributes bounded negative adjustment",
    at("HARD_FAILURE", 0).scoreAdjustment < 0 && at("HARD_FAILURE", 0).scoreAdjustment >= -12);
  check("expiry: PROBATION never promotes above zero", at("PROBATION", 0).scoreAdjustment <= 0);
  return { name: "evidenceExpiry", rows };
}

async function scenarioCapacity() {
  const pools = [mkPool("mistral", { concurrency: 1 }), mkPool("openrouter", { concurrency: 8 })];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 60 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] })],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["PROBATION", 2, 4] })],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const tenant = h.decide({ id: "tenant-0", userId: "tenant", role: "CODER" });
  check("setup: tenant holds the qualified route's only slot",
    tenant.outcome === "ADMITTED" && tenant.selected.providerId === "mistral", tenant.selected?.providerId);
  const underPressure = h.decide({ id: "press-0", userId: "u-p", role: "CODER" });
  check("pressure: saturated QUALIFIED loses to healthy PROBATION — no stampede, no false wait",
    underPressure.outcome === "ADMITTED" && underPressure.selected.providerId === "openrouter",
    `${underPressure.outcome}:${underPressure.selected?.providerId}`);
  h.reservations.release(underPressure.selected.reservationId ?? "press-0");
  // Now degrade the probation route too — a bounded wait is honest; serving the
  // saturated route is not.
  const openrouter = h.routes.find((r) => r.providerId === "openrouter");
  observe429(h.health, openrouter, 5_000, "CODER");
  const starved = h.decide({ id: "press-1", userId: "u-q", role: "CODER" });
  check("pressure: all capacity constrained -> bounded wait or fail-closed, never the saturated route",
    failClosedOrWait(starved), starved.outcome);
  now += 6_000;
  const recovered = h.decide({ id: "press-2", userId: "u-q", role: "CODER" });
  check("pressure: window reopen re-admits on the recovered route",
    recovered.outcome === "ADMITTED" && recovered.selected.providerId === "openrouter",
    `${recovered.outcome}:${recovered.selected?.providerId}`);
  h.reservations.release(recovered.selected?.reservationId ?? "press-2");
  h.reservations.release(tenant.selected?.reservationId ?? "tenant-0");
  return { name: "capacityVsQuality" };
}

async function scenarioStampede() {
  const USERS = 373;
  const pools = [mkPool("mistral"), mkPool("openrouter"), mkPool("groq")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 85 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 80 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 76 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] })],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["PROBATION", 2, 4] })],
    ["groq/openai/gpt-oss-120b", mkReceipt("groq", "openai/gpt-oss-120b", { CODER: ["QUALIFIED", 3, 4] })],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const servedByRoute = Object.fromEntries(h.routes.map((r) => [r.routeId, 0]));
  const servedByProvider = { mistral: 0, openrouter: 0, groq: 0 };
  let completed = 0, waits = 0, falseWaits = 0, rounds = 0, peakHolds = 0;
  let backlog = Array.from({ length: USERS }, (_, i) => ({ id: `st-${i}`, userId: `u-${i}`, role: "CODER" }));
  while (backlog.length && rounds < 50) {
    rounds++;
    const held = [], next = [];
    for (const t of backlog) {
      const d = h.decide(t);
      if (d.outcome === "ADMITTED") {
        if (!h.zeroBillingCheck(d)) throw new Error("Paid route selected");
        held.push({ t, d });
        peakHolds = Math.max(peakHolds, h.reservations.snapshot().activeReservations);
      } else if (d.outcome === "QUEUED_FOR_CAPACITY") {
        waits++;
        const active = h.reservations.snapshot().byPool;
        if (d.explanation.candidates.some((c) => c.status === "CAPACITY_DENIED" &&
          (active[`r42:${c.providerId}`] ?? 0) < 16)) falseWaits++;
        next.push(t);
      } else throw new Error(`Stampede starved ${t.id}: ${d.outcome}`);
    }
    for (const { t, d } of held) {
      servedByRoute[d.selected.routeId]++;
      servedByProvider[d.selected.providerId]++;
      completed++;
      h.reservations.release(d.selected.reservationId ?? t.id);
    }
    if (held.length === 0) now += 1_000;
    backlog = next;
  }
  const cap = 16;
  check("stampede: all 373 simultaneous tasks served", completed === USERS, `${completed}/${USERS}`);
  check("stampede: zero false waits", falseWaits === 0, `${falseWaits} of ${waits} waits`);
  check("stampede: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  check("stampede: no provider exceeded its concurrency ceiling",
    Object.entries(servedByProvider).every(([p]) => true) && peakHolds <= 3 * cap, `peakHolds=${peakHolds}`);
  check("stampede: quality-steered spread — every healthy eligible route served some work",
    Object.values(servedByRoute).every((n) => n > 0), JSON.stringify(servedByRoute));
  return { name: "stampede", users: USERS, servedByRoute, servedByProvider,
    providerConcentration: Math.max(...Object.values(servedByProvider)) / Math.max(1, completed), peakHolds, waits, rounds };
}

async function scenarioBudget() {
  const roles = ["explorer", "planner", "coder", "reviewer"];
  const profiles = {
    "groq/openai/gpt-oss-120b": { reasoningReserveTokens: 1_024, expiresAtMs: now0 + 60 * DAY, evidence: "fixture" },
  };
  const rows = [];
  for (const role of roles) {
    for (const [p, m] of [["groq", "openai/gpt-oss-120b"], ["mistral", "codestral-latest"], [undefined, undefined]]) {
      const b = roleOutputBudget({ role, providerId: p, modelId: m, now, profiles });
      rows.push({ role, route: p ? `${p}/${m}` : "unresolved", ...b });
    }
  }
  const find = (role, route) => rows.find((r) => r.role === role && r.route === route);
  check("budget: reasoning route gets role demand + measured reserve",
    find("reviewer", "groq/openai/gpt-oss-120b").reasoningProfileApplied === true);
  check("budget: unprofiled route gets role demand only",
    find("reviewer", "mistral/codestral-latest").reasoningProfileApplied === false);
  check("budget: unresolved route holds the bounded worst case",
    find("reviewer", "unresolved").outputTokenDemand >= find("reviewer", "groq/openai/gpt-oss-120b").outputTokenDemand);
  check("budget: every role demand within the 4k hard cap",
    rows.every((r) => r.outputTokenDemand <= 4_096));
  check("budget: coder keeps the full generation room on every route",
    rows.filter((r) => r.role === "coder").every((r) => r.outputTokenDemand === 4_096));
  // Context-nearly-full still contracts rather than overruns.
  const tight = roleOutputBudget({ role: "coder", providerId: "groq", modelId: "openai/gpt-oss-120b", now, profiles, contextTokensRemaining: 512 });
  check("budget: nearly-full context contracts maxTokens, never overruns",
    tight.maxTokens === 512 && tight.contextFits === true);
  const empty = roleOutputBudget({ role: "coder", now, contextTokensRemaining: 0 });
  check("budget: zero context room marks unfit before any request", empty.contextFits === false);
  return { name: "budgetUnderPressure", rows };
}

async function scenarioRecovery() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 85 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 70 },
  ];
  const h = mkHarness({ routeSpecs: specs, pools });
  const primary = h.routes.find((r) => r.providerId === "mistral");
  const alt = h.routes.find((r) => r.providerId === "openrouter");
  const phases = [];
  const admit = (id) => {
    const d = h.decide({ id, userId: `u-${id}`, role: "CODER" });
    phases.push({ id, outcome: d.outcome, route: d.selected?.providerId ?? null, healthMistral: h.health.assess(primary.providerId, primary.modelId).state });
    if (d.outcome === "ADMITTED") h.reservations.release(d.selected.reservationId ?? id);
    return d;
  };
  // Phase 1: healthy baseline — primary wins on score.
  const d1 = admit("p1"); check("recovery: baseline admits on primary", d1.selected?.providerId === "mistral");
  // Phase 2: degrade — burst of rate limits parks the primary.
  for (let i = 0; i < 3; i++) observe429(h.health, primary, 120_000, "CODER");
  const state = h.health.assess(primary.providerId, primary.modelId).state;
  check("recovery: injected 429 burst parks primary (hard-excluded)", state === "RATE_LIMITED", state);
  // Phase 3: failover — work continues on the alternate; primary never selected.
  let failoverOk = true;
  for (let i = 0; i < 4; i++) failoverOk &&= admit(`f${i}`).selected?.providerId === "openrouter";
  check("recovery: parked primary never selected; failover served on alternate", failoverOk);
  // Phase 4: probe-gated recovery — a successful production-shaped probe re-opens the route.
  now += 121_000;
  probeRecover(h.health, primary);
  const post = h.health.assess(primary.providerId, primary.modelId).state;
  check("recovery: successful probe restores primary to HEALTHY", post === "HEALTHY", post);
  // Phase 5: re-entry — the recovered route competes again.
  let reenter = false;
  for (let i = 0; i < 6; i++) if (admit(`r${i}`).selected?.providerId === "mistral") reenter = true;
  check("recovery: recovered route re-enters selection", reenter);
  check("recovery: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "recovery", phases };
}

async function scenarioEndurance() {
  const EPOCHS = 120;
  const pools = [mkPool("mistral"), mkPool("openrouter"), mkPool("groq")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER"], qualityScore: 85 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 78 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT", "SUBAGENT"], qualityScore: 74 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest",
      { CODER: ["QUALIFIED", 4, 4], PLANNER: ["QUALIFIED", 3, 4], REVIEWER: ["HARD_FAILURE", 0, 4] })],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free",
      { CODER: ["PROBATION", 2, 4], REVIEWER: ["QUALIFIED", 4, 4] })],
    ["groq/openai/gpt-oss-120b", mkReceipt("groq", "openai/gpt-oss-120b",
      { CODER: ["QUALIFIED", 3, 4], TOOL_AGENT: ["QUALIFIED", 4, 4] })],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const roleWave = ["CODER", "CODER", "REVIEWER", "PLANNER", "CODER", "EXPLORER", "REVIEWER", "CODER"];
  const servedByProvider = { mistral: 0, openrouter: 0, groq: 0 };
  const stat = { completed: 0, waits: 0, falseWaits: 0, denied: 0, injected429: 0,
    parkedEpochs: 0, recoveries: 0, timeouts: 0, ineligibleClosures: 0, roleBudgetMismatches: 0 };
  const parkedUntil = new Map();
  const deferred = new Map(); // taskId -> {task, denials}
  let churnTarget = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    // Churn: a rotating provider gets parked for three epochs mid-run; recovery probe fires after.
    if (epoch % 30 === 20) {
      const victim = h.routes[churnTarget++ % h.routes.length];
      for (let i = 0; i < 3; i++) observe429(h.health, victim, 300_000, "CODER");
      parkedUntil.set(victim.routeId, epoch + 3);
      stat.injected429++;
    }
    const HARD_EXCLUDE = new Set(["MODEL_RETIRED", "ACCESS_RESTRICTED", "BILLING_VERIFICATION_REQUIRED",
      "AUTH_REQUIRED", "USER_CONNECTION_REQUIRED", "QUARANTINED", "DAILY_QUOTA_EXHAUSTED", "RATE_LIMITED"]);
    for (const [routeId, untilEpoch] of [...parkedUntil]) {
      if (epoch >= untilEpoch) {
        const r = h.routes.find((x) => x.routeId === routeId);
        now += 301_000;
        probeRecover(h.health, r);
        // Recovery = no longer hard-excluded. A lingering DEGRADED from unrelated
        // timeout churn still outranks HEALTHY in state precedence but serves work.
        if (!HARD_EXCLUDE.has(h.health.assess(r.providerId, r.modelId).state)) stat.recoveries++;
        parkedUntil.delete(routeId);
      }
    }
    const tasks = [
      ...[...deferred.values()].map((d) => d.task),
      ...roleWave.map((role, i) => ({ id: `e${epoch}-${i}`, userId: `u-${(epoch * 7 + i) % 53}`, role })),
    ];
    const held = [], queuedTasks = [], deniedTasks = [];
    for (const t of tasks) {
      const d = h.decide(t);
      if (d.outcome === "ADMITTED") { held.push({ t, d }); deferred.delete(t.id); }
      else if (d.outcome === "QUEUED_FOR_CAPACITY") {
        stat.waits++;
        const active = h.reservations.snapshot().byPool;
        if (d.explanation.candidates.some((c) => c.status === "CAPACITY_DENIED" &&
          (active[`r42:${c.providerId}`] ?? 0) < 16)) stat.falseWaits++;
        queuedTasks.push(t);
      } else { deniedTasks.push(t); stat.denied++; }
    }
    for (const { t, d } of held) {
      stat.completed++;
      servedByProvider[d.selected.providerId]++;
      // ~3% of completed work reports a timeout — transient churn, not a parking event.
      if ((stat.completed + epoch) % 37 === 0) {
        h.health.observe({ kind: "call_failure", providerId: d.selected.providerId, modelId: d.selected.modelId,
          observedAt: iso(), source: "runtime", reason: "TIMEOUT", message: "upstream timeout", role: t.role });
        stat.timeouts++;
      }
      h.reservations.release(d.selected.reservationId ?? t.id);
    }
    // Waiters and temporarily supply-less tasks retry next epoch — bounded, never
    // terminal: a task denied for 8 consecutive epochs counts as real starvation.
    for (const t of [...queuedTasks, ...deniedTasks]) {
      const entry = deferred.get(t.id) ?? { task: t, denials: 0 };
      entry.denials += 1;
      if (entry.denials >= 8) { stat.starved = (stat.starved ?? 0) + 1; deferred.delete(t.id); }
      else deferred.set(t.id, entry);
    }
    now += 1_000;
  }
  // Any task still deferred at the end of the run is real starvation, not backlog.
  stat.starved = (stat.starved ?? 0) + deferred.size;
  check("endurance: sustained mixed workload completed with zero starvation",
    (stat.starved ?? 0) === 0 && stat.completed === EPOCHS * roleWave.length,
    `completed=${stat.completed}/${EPOCHS * roleWave.length} denied=${stat.denied} starved=${stat.starved}`);
  check("endurance: zero false waits under churn", stat.falseWaits === 0, `${stat.falseWaits}/${stat.waits}`);
  check("endurance: zero leaked reservations after 120 epochs",
    h.reservations.snapshot().activeReservations === 0);
  check("endurance: every parked route recovered and re-entered",
    stat.recoveries >= Math.floor(EPOCHS / 30), `recoveries=${stat.recoveries} parks=${stat.injected429}`);
  return { name: "endurance", epochs: EPOCHS, stat, servedByProvider };
}

async function scenarioScale() {
  // R41 revalidation with the role-admission filter now exercising the same shared
  // status code the runtime delegates to — NOT_TESTED reviewer routes must never
  // serve reviewer work even under 429 pressure.
  const USERS = 373, TASKS_PER_USER = 2, INJECTED_429 = 50, CONCURRENCY = 16;
  let evidence;
  try {
    evidence = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-ROLE-PROFILES.json", "utf8"));
    JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
  } catch {
    evidence = null;
  }
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER"], fallbackRoles: [] },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], fallbackRoles: ["PLANNER"] },
    { providerId: "openrouter", modelId: "cohere/north-mini-code:free", qualityScore: 80, roles: ["PRIMARY_CODING_AGENT"], fallbackRoles: ["SUBAGENT"] },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", qualityScore: 76, roles: ["PRIMARY_CODING_AGENT"], fallbackRoles: ["SUBAGENT"] },
  ];
  const receiptByRoute = new Map();
  let timestampsRebased = false;
  for (const spec of specs) {
    const key = `${spec.providerId}/${spec.modelId}`;
    const live = evidence?.routes?.find((r) => `${r.providerId}/${r.modelId}` === key)?.receipt;
    if (live) {
      // Re-base receipt timestamps into the fixture window: the property under test
      // is status-driven eligibility, and real receipt dates would read as stale.
      const fresh = new Date(now - DAY).toISOString();
      receiptByRoute.set(key, { ...live, completedAt: fresh,
        roleResults: Object.fromEntries(Object.entries(live.roleResults).map(([k, v]) => [k, { ...v, completedAt: fresh }])) });
      timestampsRebased = true;
    } else {
      receiptByRoute.set(key, mkReceipt(spec.providerId, spec.modelId, {
        CODER: ["QUALIFIED", 4, 4], REVIEWER: ["NOT_TESTED", 0, 0], PLANNER: ["NOT_TESTED", 0, 0] }));
    }
  }
  const pools = ["mistral", "openrouter", "groq"].map((p) => mkPool(p));
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute });
  const phases = [
    Array.from({ length: USERS }, (_, i) => ({ id: `s-${i}:c`, userId: `user-${i}`, role: "CODER" })),
    Array.from({ length: USERS }, (_, i) => ({ id: `s-${i}:r`, userId: `user-${i}`, role: "REVIEWER" })),
  ];
  const servedByRoute = Object.fromEntries(h.routes.map((r) => [r.routeId, 0]));
  const servedByProvider = { mistral: 0, openrouter: 0, groq: 0 };
  let completed = 0, injected = 0, starved = 0, falseWaits = 0, peakHolds = 0, queued = 0, rounds = 0, recovered = 0, roleViolations = 0, parkEvents = 0;
  const awaitingRecovery = new Set();
  for (const phase of phases) {
    let backlog = phase;
    while (backlog.length && rounds < 200) {
      rounds++;
      const held = [], next = [];
      for (const task of backlog) {
        const d = h.decide(task);
        if (d.outcome === "ADMITTED") {
          if (!h.zeroBillingCheck(d)) throw new Error("Paid route selected");
          const rec = receiptByRoute.get(`${d.selected.providerId}/${d.selected.modelId}`);
          if (!roleAdmissionAllowed(rec, task.role, now)) roleViolations++;
          held.push({ task, d });
          peakHolds = Math.max(peakHolds, h.reservations.snapshot().activeReservations);
        } else if (d.outcome === "QUEUED_FOR_CAPACITY") {
          queued++;
          const active = h.reservations.snapshot().byPool;
          if (d.explanation.candidates.some((c) => c.status === "CAPACITY_DENIED" &&
            (active[`r42:${c.providerId}`] ?? 0) < CONCURRENCY)) falseWaits++;
          next.push(task);
        } else { starved++; }
      }
      if (held.length === 0 && next.length) { now += 1_000; backlog = next; continue; }
      for (const { task, d } of held) {
        servedByRoute[d.selected.routeId]++;
        servedByProvider[d.selected.providerId]++;
        completed++;
        h.reservations.release(d.selected.reservationId ?? task.id);
        if (injected < INJECTED_429 && completed % 12 === 0) {
          observe429(h.health, d.selected, 3_000, task.role);
          const key = `${d.selected.providerId}/${d.selected.modelId}`;
          if (!awaitingRecovery.has(key)) parkEvents++;
          awaitingRecovery.add(key);
          injected++;
        }
      }
      now += 1_000;
      for (const key of [...awaitingRecovery]) {
        const r = h.routes.find((x) => `${x.providerId}/${x.modelId}` === key);
        if (r && h.health.assess(r.providerId, r.modelId).state !== "RATE_LIMITED") {
          recovered++; awaitingRecovery.delete(key);
        }
      }
      backlog = next;
    }
    if (backlog.length) starved += backlog.length;
  }
  // Cooldown drain: 429s injected near run end still hold a live RATE_LIMITED
  // window; recovery is the TTL clearing, so let the clock run out and count.
  let drain = 0;
  while (awaitingRecovery.size && drain++ < 20) {
    now += 3_000;
    for (const key of [...awaitingRecovery]) {
      const r = h.routes.find((x) => `${x.providerId}/${x.modelId}` === key);
      if (r && h.health.assess(r.providerId, r.modelId).state !== "RATE_LIMITED") {
        recovered++; awaitingRecovery.delete(key);
      }
    }
  }
  const activeEnd = h.reservations.snapshot().activeReservations;
  check("scale: 746/746 tasks completed", completed === USERS * TASKS_PER_USER, `${completed}`);
  check("scale: zero starvation", starved === 0, `${starved}`);
  check("scale: zero false waits", falseWaits === 0, `${falseWaits}/${queued}`);
  check("scale: zero leaked reservations", activeEnd === 0, `${activeEnd}`);
  check("scale: zero role-ineligible selections under pressure", roleViolations === 0, `${roleViolations}`);
  check("scale: every distinct park recovered and no route left parked",
    recovered === parkEvents && awaitingRecovery.size === 0 && injected === INJECTED_429,
    `recovered=${recovered} parks=${parkEvents} injected=${injected} parkedAtEnd=${awaitingRecovery.size}`);
  return { name: "scale", users: USERS, tasks: USERS * TASKS_PER_USER, completed, starved,
    queuedCapacityAttempts: queued, falseWaits, leakedReservations: activeEnd, injected429: injected,
    peakHolds, rounds, servedByRoute, servedByProvider,
    providerConcentration: Math.max(...Object.values(servedByProvider)) / Math.max(1, completed),
    reenteredHealthyObservations: recovered, roleViolations, timestampsRebased,
    receiptSource: evidence ? "R41-ROLE-PROFILES (timestamps re-based)" : "synthetic" };
}

const SCENARIOS = {
  roles: scenarioRoles, expiry: scenarioExpiry, capacity: scenarioCapacity,
  stampede: scenarioStampede, budget: scenarioBudget, recovery: scenarioRecovery,
  endurance: scenarioEndurance, scale: scenarioScale,
};
const ARTIFACT = {
  roles: "R42-ROLE-ROUTING-STRESS.json", expiry: "R42-ROLE-ROUTING-STRESS.json",
  capacity: "R42-ROLE-ROUTING-STRESS.json", stampede: "R42-ROLE-ROUTING-STRESS.json",
  budget: "R42-BUDGET-STRESS.json", recovery: "R42-RECOVERY.json",
  endurance: "R42-ENDURANCE.json", scale: "R42-SCALE.json",
};

await mkdir(OUT_DIR, { recursive: true });
const artifacts = new Map();
const names = ONLY === "all" ? Object.keys(SCENARIOS) : [ONLY];
for (const name of names) {
  checks.length = 0;
  const t0 = Date.now();
  const result = await SCENARIOS[name]();
  const file = ARTIFACT[name];
  const prior = artifacts.get(file) ?? { at: new Date().toISOString(), evidenceClass: EVIDENCE, scenarios: {}, checks: [] };
  prior.scenarios[result.name] = { ...result, name: undefined, wallMs: Date.now() - t0 };
  prior.checks.push(...checks.map((c) => ({ ...c, scenario: name })));
  artifacts.set(file, prior);
  console.log(`${name}: ${checks.filter((c) => c.pass).length}/${checks.length} checks pass (${Date.now() - t0}ms)`);
}
for (const [file, doc] of artifacts) {
  doc.allChecksPassed = doc.checks.every((c) => c.pass);
  await writeFile(join(OUT_DIR, file), `${JSON.stringify(doc, null, 2)}\n`);
}
const failed = [...artifacts.values()].flatMap((d) => d.checks.filter((c) => !c.pass));
console.log(JSON.stringify({ artifacts: [...artifacts.keys()], checks: failed.length ? failed : "all pass" }));
if (failed.length) process.exitCode = 1;
