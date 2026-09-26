// R43 deterministic qualification-lifecycle harness. Every scenario exercises the real
// production code paths — Free Fabric decide(), CapacityReservationLedger,
// EightBitRouteHealthAuthority, roleQualificationStatusFor / roleAdmissionAllowed /
// roleQualityAdvice / receiptSuiteSupported — over simulated free capacity.
// No live-provider claims; receipts are mutated mid-run to prove expiry and
// requalification land inside a live decision stream, not only between runs.
//
//   node scripts/r43-qualification-sim.mjs <outDir> [scenario]
//
// Scenarios: expiry | requalification | suiteversion | roleswap | healthqual | driftscale | all
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
const OUT_DIR = process.argv[2] ?? "docs/evidence/r43-green-suppression";
const ONLY = process.argv[3] ?? "all";

const EVIDENCE = "deterministic simulated capacity; not live-provider traffic";
const SUPPORTED_SUITE = "R41_ROLE_QUALIFICATION_V3";
const UNSUPPORTED_SUITE = "R41_ROLE_QUALIFICATION_V2";

// ---------- fixture builders ----------
const window = (unit, limit) => ({
  unit, limit, remaining: limit,
  resetAt: new Date(now0 + DAY).toISOString(),
  scope: "ORG", observedAt: iso(), authoritative: true,
  period: unit === "concurrency" ? "CONTINUOUS" : "DAILY_RESET",
});
const mkPool = (providerId, over = {}) => ({
  poolId: `r43:${providerId}`, providerId, scope: "SHARED_OWNER_POOL",
  supplyClass: "PURE_MANAGED_FREE", observedAt: iso(), authoritative: true,
  windows: [
    window("requests", over.requests ?? 2_000),
    window("input_tokens", over.input ?? 4_000_000),
    window("output_tokens", over.output ?? 4_000_000),
    window("concurrency", over.concurrency ?? 16),
  ],
});
const mkRoute = (spec, pools) => ({
  routeId: `r43:${spec.providerId}/${spec.modelId}`,
  providerId: spec.providerId, modelId: spec.modelId,
  canonicalModelId: spec.modelId, family: spec.modelId, gateway: spec.providerId,
  supplyClass: "PURE_MANAGED_FREE", capacityPoolId: `r43:${spec.providerId}`,
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
/** receipt: {CODER:["QUALIFIED",4,4], ...}; suite defaults to the supported one. */
const mkReceipt = (providerId, modelId, roles, ageDays = 1, suite = SUPPORTED_SUITE) => {
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

// ---------- shared harness ----------
const mkHarness = ({ routeSpecs, pools, receiptByRoute = new Map(), excluded = new Set(), maxPerUser = 1 }) => {
  const routes = routeSpecs.map((s) => mkRoute(s, pools));
  const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => now, maxActiveReservationsPerUser: maxPerUser });
  const health = createEightBitRouteHealthAuthority(undefined, () => now);
  let activeRole;
  const fabric = createFreeFabric({
    // Same ordering as production: structural quarantine first, then the shared
    // expiry/suite-aware role filter consults the receipt map live on every decide.
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
const release = (h, d, id) => { if (d.outcome === "ADMITTED") h.reservations.release(d.selected.reservationId ?? id); };

// ---------- scenarios ----------

// P17: qualification evidence expires inside a live decision stream — not between runs.
async function scenarioMidrunExpiry() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const keyA = "mistral/codestral-latest";
  const receipts = new Map([
    [keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4], TOOL_AGENT: ["QUALIFIED", 4, 4] }, 29.5)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const recA = () => receipts.get(keyA);

  // Phase 1: still inside the evidence window — the qualified route wins on advice.
  const phase1 = [];
  for (let i = 0; i < 4; i++) {
    const d = h.decide({ id: `mx-a${i}`, userId: `u-${i}`, role: "CODER" });
    phase1.push(d.selected?.providerId);
    release(h, d, `mx-a${i}`);
  }
  check("midrun-expiry: fresh-in-window QUALIFIED evidence steers coder picks to the measured route",
    phase1.every((p) => p === "mistral"), JSON.stringify(phase1));

  // Phase 2: the clock crosses 30d mid-run — evidence expires between two decisions.
  now += 0.6 * DAY;
  const after = { status: roleQualificationStatusFor(recA(), "CODER", now), advice: roleQualityAdvice(recA(), "CODER", now) };
  check("midrun-expiry: crossing the 30d boundary reads the verdict as expired (undefined status)",
    after.status === undefined, String(after.status));
  check("midrun-expiry: expired evidence stops contributing ranking score but never quarantines the route",
    roleAdmissionAllowed(recA(), "CODER", now) === true &&
    after.advice.scoreAdjustment === 0 &&
    after.advice.reasonCodes.includes("ROLE_EVIDENCE_STALE") &&
    after.advice.needsRequalification === true, JSON.stringify(after.advice.reasonCodes));
  check("midrun-expiry: expired TOOL_AGENT verdict does not leak into EXPLORER inheritance",
    roleQualificationStatusFor(recA(), "EXPLORER", now) === undefined);

  // Phase 3: both routes now compete on base score — no stale-evidence lock-in.
  const phase3 = new Set();
  for (let i = 0; i < 6; i++) {
    const d = h.decide({ id: `mx-b${i}`, userId: `u-b${i}`, role: "CODER" });
    if (d.outcome === "ADMITTED") phase3.add(d.selected.providerId);
    release(h, d, `mx-b${i}`);
  }
  check("midrun-expiry: expired route still serves work (no quarantine, no starvation)",
    phase3.has("mistral"), [...phase3].join(","));
  check("midrun-expiry: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "midrunExpiry" };
}

// P18/P19: the full expiry -> legacy-eligible -> bounded requalification -> fresh receipt cycle.
async function scenarioRequalification() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 60 },
  ];
  const keyA = "mistral/codestral-latest";
  const keyB = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
  const receipts = new Map([
    // Route A measured a CODER hard failure 5 days ago: currently excluded.
    [keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["HARD_FAILURE", 0, 4] }, 5)],
    [keyB, mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["PROBATION", 2, 4] }, 5)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const picks = (tag, n = 4) => {
    const got = [];
    for (let i = 0; i < n; i++) {
      const d = h.decide({ id: `${tag}${i}`, userId: `u-${tag}${i}`, role: "CODER" });
      got.push(d.selected?.providerId ?? d.outcome);
      release(h, d, `${tag}${i}`);
    }
    return got;
  };

  const p1 = picks("rq1-");
  check("requalification: current HARD_FAILURE receipt excludes the route from coder work",
    p1.every((p) => p === "openrouter"), JSON.stringify(p1));

  // The receipt ages past 30 days — the exclusion expires with the evidence.
  now += 26 * DAY;
  check("requalification: expired HARD_FAILURE reverts to legacy eligibility (never permanent quarantine)",
    roleAdmissionAllowed(receipts.get(keyA), "CODER", now) === true &&
    roleQualificationStatusFor(receipts.get(keyA), "CODER", now) === undefined);
  const advice = roleQualityAdvice(receipts.get(keyA), "CODER", now);
  check("requalification: stale route flags needsRequalification so the bounded suite retests it",
    advice.needsRequalification === true && advice.reasonCodes.includes("ROLE_EVIDENCE_STALE"),
    JSON.stringify(advice.reasonCodes));

  // The bounded qualification runner produces a fresh receipt (what qualifyPending records).
  receipts.set(keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 0));
  check("requalification: fresh receipt restores QUALIFIED status on the next decision",
    roleQualificationStatusFor(receipts.get(keyA), "CODER", now) === "QUALIFIED");
  const p2 = picks("rq2-");
  check("requalification: requalified route competes again and wins on measured evidence",
    p2.some((p) => p === "mistral"), JSON.stringify(p2));
  check("requalification: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "requalification" };
}

// P20: receipt suite-version compatibility — an incompatible suite's verdicts read as absent.
async function scenarioSuiteVersion() {
  const freshUnsupported = mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 1, UNSUPPORTED_SUITE);
  const freshSupported = mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 1, SUPPORTED_SUITE);
  check("suite-version: supported suite reads its verdicts",
    roleQualificationStatusFor(freshSupported, "CODER", now) === "QUALIFIED");
  check("suite-version: receiptSuiteSupported distinguishes current vs incompatible producers",
    receiptSuiteSupported(freshSupported) === true && receiptSuiteSupported(freshUnsupported) === false);
  check("suite-version: fresh-but-incompatible receipt exposes no verdict (unreadable, not trusted)",
    roleQualificationStatusFor(freshUnsupported, "CODER", now) === undefined);
  check("suite-version: incompatible receipt does NOT permanently exclude — legacy eligibility",
    roleAdmissionAllowed(freshUnsupported, "CODER", now) === true);
  const advice = roleQualityAdvice(freshUnsupported, "CODER", now);
  check("suite-version: incompatible receipt flags requalification with an explicit reason code",
    advice.needsRequalification === true && advice.reasonCodes.includes("RECEIPT_SUITE_UNSUPPORTED"),
    JSON.stringify(advice.reasonCodes));

  // Ordering: a fresh supported QUALIFIED must outrank a fresh unsupported "QUALIFIED" —
  // unreadable evidence may not lend ordering trust.
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 1, UNSUPPORTED_SUITE)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4] }, 1, SUPPORTED_SUITE)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const picks = [];
  for (let i = 0; i < 4; i++) {
    const d = h.decide({ id: `sv-${i}`, userId: `u-sv${i}`, role: "CODER" });
    picks.push(d.selected?.providerId);
    release(h, d, `sv-${i}`);
  }
  check("suite-version: unsupported-suite 'QUALIFIED' lends no ordering trust — supported route wins",
    picks.every((p) => p === "openrouter"), JSON.stringify(picks));

  // Requalification produces a current-suite receipt -> trust restored on the next decide.
  receipts.set("mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 0, SUPPORTED_SUITE));
  const d = h.decide({ id: "sv-req", userId: "u-svr", role: "CODER" });
  release(h, d, "sv-req");
  check("suite-version: requalification under the current suite reopens the route's verdicts",
    roleQualificationStatusFor(receipts.get("mistral/codestral-latest"), "CODER", now) === "QUALIFIED");
  return { name: "suiteVersion" };
}

// P21: a fresh receipt swapped in mid-run changes role verdicts on the very next decide.
async function scenarioRoleSwap() {
  const pools = [mkPool("mistral"), mkPool("openrouter")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 80 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 70 },
  ];
  const keyA = "mistral/codestral-latest";
  const receipts = new Map([
    [keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4], REVIEWER: ["QUALIFIED", 4, 4] }, 2)],
    ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["PROBATION", 2, 4], REVIEWER: ["PROBATION", 2, 4] }, 2)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const picks = (role, tag, n = 3) => {
    const got = [];
    for (let i = 0; i < n; i++) {
      const d = h.decide({ id: `${tag}${i}`, userId: `u-${tag}${i}`, role });
      got.push(d.selected?.providerId ?? d.outcome);
      release(h, d, `${tag}${i}`);
    }
    return got;
  };
  check("role-swap: pre-swap coder picks land on the qualified route",
    picks("CODER", "rs-c1-").every((p) => p === "mistral"));

  // Mid-run requalification flips mistral's CODER to NOT_QUALIFIED while REVIEWER stays.
  receipts.set(keyA, mkReceipt("mistral", "codestral-latest", { CODER: ["NOT_QUALIFIED", 1, 4], REVIEWER: ["QUALIFIED", 4, 4] }, 0));
  const coderPicks = picks("CODER", "rs-c2-");
  check("role-swap: the very next coder decision respects the fresh NOT_QUALIFIED verdict",
    coderPicks.every((p) => p === "openrouter"), JSON.stringify(coderPicks));
  const reviewerPicks = picks("REVIEWER", "rs-r2-");
  check("role-swap: unaffected roles keep their verdicts — reviewer still lands on the qualified route",
    reviewerPicks.every((p) => p === "mistral"), JSON.stringify(reviewerPicks));
  check("role-swap: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "roleSwap" };
}

// P22: health and qualification are orthogonal — a qualified route parks on 429 while a
// disqualified route stays excluded regardless of its health.
async function scenarioHealthVsQualification() {
  const pools = [mkPool("mistral"), mkPool("openrouter"), mkPool("groq")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 90 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 70 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 95 },
  ];
  const receipts = new Map([
    ["mistral/codestral-latest", mkReceipt("mistral", "codestral-latest", { CODER: ["QUALIFIED", 4, 4] }, 1)],
    // groq's receipt measured a coder hard failure — disqualified despite top qualityScore.
    ["groq/openai/gpt-oss-120b", mkReceipt("groq", "openai/gpt-oss-120b", { CODER: ["HARD_FAILURE", 0, 4] }, 1)],
  ]);
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });
  const qualified = h.routes.find((r) => r.providerId === "mistral");
  for (let i = 0; i < 3; i++) observe429(h.health, qualified, 300_000, "CODER");
  check("health-vs-qual: injected 429 burst parks the QUALIFIED route",
    h.health.assess(qualified.providerId, qualified.modelId).state === "RATE_LIMITED");

  const d = h.decide({ id: "hq-1", userId: "u-hq", role: "CODER" });
  release(h, d, "hq-1");
  check("health-vs-qual: parked qualified route is not served — admission falls to the unmeasured route, never the HARD_FAILURE route",
    (d.outcome === "ADMITTED" && d.selected.providerId === "openrouter") || failClosedOrWait(d),
    `${d.outcome}:${d.selected?.providerId}`);
  const groqSeen = h.decide({ id: "hq-2", userId: "u-hq2", role: "CODER" });
  release(h, groqSeen, "hq-2");
  check("health-vs-qual: the disqualified route is never a candidate regardless of perfect health",
    groqSeen.explanation.candidates.every((c) => c.providerId !== "groq") &&
    (groqSeen.selected?.providerId ?? "") !== "groq",
    groqSeen.explanation.candidates.map((c) => c.providerId).join(","));

  now += 301_000;
  probeRecover(h.health, qualified);
  const d2 = h.decide({ id: "hq-3", userId: "u-hq3", role: "CODER" });
  release(h, d2, "hq-3");
  check("health-vs-qual: recovered qualified route re-enters and wins on the next decide",
    d2.outcome === "ADMITTED" && d2.selected.providerId === "mistral", `${d2.outcome}:${d2.selected?.providerId}`);
  check("health-vs-qual: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "healthVsQualification" };
}

// P25: 373-user scale with receipts expiring and requalifying mid-run — the decide path must
// never starve, never false-wait, never leak, and never serve a role-ineligible route while
// the evidence landscape mutates underneath it.
async function scenarioDriftScale() {
  const USERS = 373;
  const pools = [mkPool("mistral"), mkPool("openrouter"), mkPool("groq")];
  const specs = [
    { providerId: "mistral", modelId: "codestral-latest", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 80 },
    { providerId: "openrouter", modelId: "nvidia/nemotron-3-super-120b-a12b:free", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 78 },
    { providerId: "groq", modelId: "openai/gpt-oss-120b", roles: ["PRIMARY_CODING_AGENT", "REVIEWER"], qualityScore: 76 },
  ];
  const mkAll = (coderStatus, reviewerStatus, ageDays = 1, suite = SUPPORTED_SUITE) => ({
    "mistral/codestral-latest": mkReceipt("mistral", "codestral-latest", { CODER: [coderStatus[0], coderStatus[1], coderStatus[2]], REVIEWER: [reviewerStatus[0], reviewerStatus[1], reviewerStatus[2]] }, ageDays, suite),
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free": mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: [coderStatus[0], coderStatus[1], coderStatus[2]], REVIEWER: [reviewerStatus[0], reviewerStatus[1], reviewerStatus[2]] }, ageDays, suite),
    "groq/openai/gpt-oss-120b": mkReceipt("groq", "openai/gpt-oss-120b", { CODER: [coderStatus[0], coderStatus[1], coderStatus[2]], REVIEWER: [reviewerStatus[0], reviewerStatus[1], reviewerStatus[2]] }, ageDays, suite),
  });
  const receipts = new Map(Object.entries(mkAll(["QUALIFIED", 4, 4], ["QUALIFIED", 4, 4])));
  const h = mkHarness({ routeSpecs: specs, pools, receiptByRoute: receipts });

  const stat = { completed: 0, waits: 0, falseWaits: 0, starved: 0, roleViolations: 0, peakHolds: 0, rounds: 0 };
  const servedByProvider = { mistral: 0, openrouter: 0, groq: 0 };
  let backlog = Array.from({ length: USERS }, (_, i) => ({ id: `d-${i}`, userId: `u-${i}`, role: i % 4 === 0 ? "REVIEWER" : "CODER" }));
  let driftStep = 0;
  while (backlog.length && stat.rounds < 60) {
    stat.rounds++;
    // Mid-run evidence mutations between admission rounds, keyed on completed work so all
    // four land while the 373-task workload is still flowing regardless of round pacing:
    if (driftStep === 0 && stat.completed >= 40) {
      // groq's receipts age out entirely -> legacy eligibility, zero advice.
      receipts.set("groq/openai/gpt-oss-120b",
        mkReceipt("groq", "openai/gpt-oss-120b", { CODER: ["HARD_FAILURE", 0, 4], REVIEWER: ["HARD_FAILURE", 0, 4] }, 31));
      driftStep++;
    } else if (driftStep === 1 && stat.completed >= 120) {
      // mistral's reviewer verdict is re-measured as a hard failure.
      receipts.set("mistral/codestral-latest", mkReceipt("mistral", "codestral-latest",
        { CODER: ["QUALIFIED", 4, 4], REVIEWER: ["HARD_FAILURE", 0, 4] }, 0));
      driftStep++;
    } else if (driftStep === 2 && stat.completed >= 200) {
      // openrouter's receipt is rewritten by an incompatible suite version.
      receipts.set("openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4], REVIEWER: ["QUALIFIED", 4, 4] }, 0, UNSUPPORTED_SUITE));
      driftStep++;
    } else if (driftStep === 3 && stat.completed >= 280) {
      // openrouter requalifies under the current suite — verdicts readable again.
      receipts.set("openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        mkReceipt("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", { CODER: ["QUALIFIED", 4, 4], REVIEWER: ["QUALIFIED", 4, 4] }, 0));
      driftStep++;
    }
    const held = [], next = [];
    for (const t of backlog) {
      const d = h.decide(t);
      if (d.outcome === "ADMITTED") {
        if (!h.zeroBillingCheck(d)) throw new Error("Paid route selected");
        const rec = receipts.get(`${d.selected.providerId}/${d.selected.modelId}`);
        if (!roleAdmissionAllowed(rec, t.role, now)) stat.roleViolations++;
        held.push({ t, d });
        stat.peakHolds = Math.max(stat.peakHolds, h.reservations.snapshot().activeReservations);
      } else if (d.outcome === "QUEUED_FOR_CAPACITY") {
        stat.waits++;
        const active = h.reservations.snapshot().byPool;
        if (d.explanation.candidates.some((c) => c.status === "CAPACITY_DENIED" &&
          (active[`r43:${c.providerId}`] ?? 0) < 16)) stat.falseWaits++;
        next.push(t);
      } else { stat.starved++; }
    }
    for (const { t, d } of held) {
      servedByProvider[d.selected.providerId]++;
      stat.completed++;
      h.reservations.release(d.selected.reservationId ?? t.id);
    }
    if (held.length === 0) now += 1_000;
    backlog = next;
  }
  stat.starved += backlog.length;
  check("drift-scale: all mid-run evidence mutations applied", driftStep === 4, `${driftStep}/4`);
  check("drift-scale: 373 tasks served across receipt expiry/requalification drift", stat.completed === USERS, `${stat.completed}`);
  check("drift-scale: zero role-ineligible selections while evidence churned", stat.roleViolations === 0, `${stat.roleViolations}`);
  check("drift-scale: zero starvation", stat.starved === 0, `${stat.starved}`);
  check("drift-scale: zero false waits", stat.falseWaits === 0, `${stat.falseWaits}/${stat.waits}`);
  check("drift-scale: zero leaked reservations", h.reservations.snapshot().activeReservations === 0);
  return { name: "driftScale", users: USERS, stat, servedByProvider };
}

const SCENARIOS = {
  expiry: scenarioMidrunExpiry,
  requalification: scenarioRequalification,
  suiteversion: scenarioSuiteVersion,
  roleswap: scenarioRoleSwap,
  healthqual: scenarioHealthVsQualification,
  driftscale: scenarioDriftScale,
};

await mkdir(OUT_DIR, { recursive: true });
const wanted = ONLY === "all" ? Object.keys(SCENARIOS) : [ONLY];
const results = [];
for (const name of wanted) {
  const before = checks.length;
  const result = await SCENARIOS[name]();
  results.push({ ...result, checks: checks.slice(before) });
}
const failed = checks.filter((c) => !c.pass);
await writeFile(join(OUT_DIR, "R43-QUALIFICATION-EXPIRY.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  evidenceClass: EVIDENCE,
  scenarios: results.map((r) => ({ ...r, checks: r.checks.map((c) => c.name) })),
  checks,
  totals: { pass: checks.length - failed.length, fail: failed.length },
}, null, 2));
console.log(`R43 qualification sim: ${checks.length - failed.length}/${checks.length} checks pass`);
for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
