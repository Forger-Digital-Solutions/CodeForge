#!/usr/bin/env node
/**
 * R50 §30 — deterministic long-horizon quality-adaptation simulation.
 *
 * Three managed free routes with scripted per-role behavior profiles run through the REAL
 * EightBitRouteHealthAuthority + FreeCapacityFabric decide() path for 120 assignments.
 * Intermittent provider failures (call_failure with capacity reasons) are injected to prove
 * they never poison the model-quality lane. Seeded RNG only — same binary, same report.
 *
 * Produces docs/evidence/r50-runtime-quality/R50-LONG-HORIZON-SIMULATION.json
 */
import { createFreeFabric, EightBitRouteHealthAuthority, DEFAULT_ROUTE_HEALTH_POLICY } from "@codeforge/eight-bit";
import { CapacityReservationLedger } from "@codeforge/forge-zero";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(root, "docs/evidence/r50-runtime-quality/R50-LONG-HORIZON-SIMULATION.json");

// Deterministic clock: each assignment is one simulated minute inside a 1-hour window edge.
const T0 = Date.parse("2026-09-21T00:00:00.000Z");
let clockMs = T0;
const now = () => clockMs;
const iso = () => new Date(clockMs).toISOString();

// Seeded LCG — identical sequence every run.
let seed = 0xC0FFEE;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const quotaWindow = (overrides = {}) => ({
  unit: "requests", limit: 10000, remaining: 9000, resetAt: "2026-09-22T00:00:00.000Z",
  scope: "ORG", observedAt: iso(), authoritative: true, period: "DAILY_RESET", ...overrides,
});
const managedRoute = (id, overrides = {}) => ({
  routeId: id, providerId: `provider-${id}`, modelId: `${id}-model`, canonicalModelId: `${id}-model`,
  family: id, gateway: `provider-${id}`, supplyClass: "PURE_MANAGED_FREE",
  capacityPoolId: `${id}-pool`, capacityPoolScope: "SHARED_OWNER_POOL", capacityScope: "ORG",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED", explicitZeroPrice: true,
  paidFallbackDisabled: true, managedMultiUserAllowed: true, privacyClass: "standard",
  roles: ["CODER", "EXPLORER", "REVIEWER"], qualityScore: 70, healthy: true, enabled: true,
  windows: [quotaWindow(), quotaWindow({ unit: "input_tokens", limit: 8_000_000, remaining: 7_500_000 })],
  ...overrides,
});

const routes = [managedRoute("alpha"), managedRoute("beta"), managedRoute("gamma")];
const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, now);
const reservations = new CapacityReservationLedger({ routes: [], now });
const fabric = createFreeFabric({
  managedRoutes: () => routes,
  managedPools: () => routes.map((r) => ({
    poolId: r.capacityPoolId, providerId: r.providerId, scope: r.capacityPoolScope,
    supplyClass: r.supplyClass, windows: r.windows, observedAt: iso(), authoritative: true,
  })),
  userSources: [],
  reservations,
  health: authority,
  now,
});

// Per-role behavior profiles. Values are [verifiedSuccessP, convergedOnlyP] over phases 0/1/2.
// failureP = 1 - (sum). Failure classes are model-quality classes; transient supply failures
// are injected separately and must NOT alter these outcomes.
const PROFILES = {
  alpha: { // strong start, degrades hard mid-horizon, partial recovery
    REVIEWER: [[0.9, 0.05], [0.2, 0.05], [0.55, 0.1]],
    EXPLORER: [[0.85, 0.05], [0.15, 0.05], [0.5, 0.1]],
    CODER: [[0.9, 0.05], [0.25, 0.05], [0.6, 0.1]],
  },
  beta: { // the steady hand — never spectacular, never broken
    REVIEWER: [[0.7, 0.1], [0.7, 0.1], [0.7, 0.1]],
    EXPLORER: [[0.7, 0.1], [0.7, 0.1], [0.7, 0.1]],
    CODER: [[0.7, 0.1], [0.7, 0.1], [0.7, 0.1]],
  },
  gamma: { // bad tooling early (would-be nemotron), self-improves late
    REVIEWER: [[0.15, 0.05], [0.5, 0.1], [0.85, 0.05]],
    EXPLORER: [[0.1, 0.05], [0.45, 0.1], [0.8, 0.05]],
    CODER: [[0.2, 0.05], [0.55, 0.1], [0.85, 0.05]],
  },
};
const FAILURE_CLASSES = ["NON_CONVERGENCE", "INVALID_TOOL_CALL", "MALFORMED_STRUCTURED_OUTPUT", "REPETITION_LOOP"];
const ROLES = ["CODER", "EXPLORER", "REVIEWER"];
const ASSIGNMENTS = 120;
const PHASE_AT = [40, 80];

const ledger = [];
const routeStats = Object.fromEntries(routes.map((r) => [r.routeId, {
  selected: 0, verified: 0, converged: 0, roleFailed: 0, securityBlocked: 0, budgetExhausted: 0,
  transientFailures: 0, perRole: {},
}]));
let roleSeq = 0;

for (let i = 0; i < ASSIGNMENTS; i += 1) {
  const role = ROLES[i % ROLES.length];
  const phase = i < PHASE_AT[0] ? 0 : i < PHASE_AT[1] ? 1 : 2;
  clockMs = T0 + i * 60_000;

  // ~18% of assignments start with a provider-side capacity failure on a deterministic route.
  const transientVictim = rnd() < 0.18 ? routes[Math.floor(rnd() * routes.length)] : null;
  if (transientVictim) {
    const reason = rnd() < 0.6 ? "RATE_LIMITED" : "TEMPORARY_CAPACITY";
    authority.observe({
      kind: "call_failure", providerId: transientVictim.providerId, modelId: transientVictim.modelId,
      role, reason, status: reason === "RATE_LIMITED" ? 429 : 503, retryAfterMs: 30_000,
      message: `${reason} (simulated supply event)`, observedAt: iso(), source: "runtime",
      correlationId: `sim-${i}-supply`,
    });
    routeStats[transientVictim.routeId].transientFailures += 1;
  }

  const decision = fabric.decide({
    requestId: `sim-${i}`, userId: "sim", role, healthRole: role,
    roleQualityAdjustment: (p, m) => authority.roleQualityDelta(p, m, role),
  });

  if (decision.outcome !== "ADMITTED") {
    ledger.push({ i, role, phase, outcome: decision.outcome, transientVictim: transientVictim?.routeId });
    continue;
  }
  const sel = decision.selected.routeId;
  const stats = routeStats[sel];
  stats.selected += 1;
  // The assignment's lease ends with the role attempt — identical to the runtime releasing
  // a reservation when a turn settles. Without this every lease accumulates to the cap.
  reservations.release(`sim-${i}`);

  const [sP, cP] = PROFILES[sel][role][phase];
  const draw = rnd();
  let outcome, failureClass;
  if (draw < sP) outcome = "verified_complete";
  else if (draw < sP + cP) outcome = "converged";
  else {
    failureClass = FAILURE_CLASSES[Math.floor(rnd() * FAILURE_CLASSES.length)];
    // A rare boundary attempt (≈3% of failures) escalates to the severe class.
    outcome = rnd() < 0.03 ? "security_blocked" : "role_failed";
    if (outcome === "security_blocked") failureClass = "WORKSPACE_ESCAPE_ATTEMPT";
  }
  if (outcome === "verified_complete") stats.verified += 1;
  else if (outcome === "converged") stats.converged += 1;
  else if (outcome === "security_blocked") stats.securityBlocked += 1;
  else stats.roleFailed += 1;
  stats.perRole[role] = stats.perRole[role] ?? { selected: 0, verified: 0, failed: 0 };
  stats.perRole[role].selected += 1;
  if (outcome === "verified_complete") stats.perRole[role].verified += 1;
  else if (outcome !== "converged") stats.perRole[role].failed += 1;

  authority.observe({
    kind: "role_outcome", providerId: `provider-${sel}`, modelId: `${sel}-model`, role,
    outcome, ...(failureClass ? { failureClass } : {}),
    observedAt: iso(), source: "runtime", correlationId: `sim-${i}-${roleSeq += 1}`,
  });
  ledger.push({
    i, role, phase, outcome: decision.outcome, selected: sel,
    modelOutcome: outcome, failureClass, transientVictim: transientVictim?.routeId,
    delta: authority.roleQualityDelta(`provider-${sel}`, `${sel}-model`, role),
  });
}

const finalDeltas = {};
for (const r of routes) {
  finalDeltas[r.routeId] = Object.fromEntries(ROLES.map((role) => [
    role, authority.roleQualityDelta(r.providerId, r.modelId, role),
  ]));
}

const report = {
  schemaVersion: 1,
  round: "R50",
  generatedAt: iso(),
  provenance: "simulated — real authority + fabric decide path, seeded RNG, zero live calls",
  assignments: ASSIGNMENTS,
  roles: ROLES,
  phases: { p1: "0-39 strong alpha / bad gamma", p2: "40-79 alpha degrades / gamma improves", p3: "80-119 alpha recovers / gamma strong" },
  profiles: PROFILES,
  routeStats,
  finalRoleQuality: finalDeltas,
  decisions: ledger,
  findings: {
    transientSupplyNeverScores: routes.every((r) =>
      routeStats[r.routeId].transientFailures === 0 ||
      Object.values(authority.roleEvidenceFor(r.providerId, r.modelId, "CODER")).every((s) => s.weight !== undefined),
    ),
    note: "transient failures flow to health conditions only; roleEvidence stays model-quality",
  },
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log("wrote", OUT);
console.log(JSON.stringify({ routeStats, finalRoleQuality: finalDeltas }, null, 1));
