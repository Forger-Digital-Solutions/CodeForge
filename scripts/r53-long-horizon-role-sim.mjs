import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { CapacityReservationLedger } from "@codeforge/forge-zero";
import { createFreeFabric, EightBitRouteHealthAuthority, DEFAULT_ROUTE_HEALTH_POLICY } from "@codeforge/eight-bit";

const start = Date.parse("2026-09-27T12:00:00.000Z");
let now = start;
const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, () => now);
const window = (unit, limit, remaining) => ({ unit, limit, remaining, resetAt: new Date(start + 24 * 60 * 60_000).toISOString(), scope: "ORG", observedAt: new Date(start - 60_000).toISOString(), authoritative: true, period: "DAILY_RESET" });
const route = (name, qualityScore = 70) => ({
  routeId: name,
  providerId: `provider-${name}`,
  modelId: `${name}-model`,
  canonicalModelId: `${name}-model`,
  family: name,
  gateway: `provider-${name}`,
  supplyClass: "PURE_MANAGED_FREE",
  capacityPoolId: `${name}-pool`,
  capacityPoolScope: "SHARED_OWNER_POOL",
  capacityScope: "ORG",
  dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
  lifecycle: "APPROVED",
  explicitZeroPrice: true,
  paidFallbackDisabled: true,
  managedMultiUserAllowed: true,
  privacyClass: "standard",
  roles: ["CODER", "REVIEWER"],
  qualityScore,
  healthy: true,
  enabled: true,
  windows: [window("requests", 1000, 900), window("input_tokens", 2_000_000, 1_500_000)],
});
const alpha = route("alpha");
const beta = route("beta");
const gamma = route("gamma", 68);
const routes = [alpha, beta];
const observations = [];
const decisions = [];

function observe(target, role, outcome, failureClass) {
  now += 1000;
  const sample = { kind: "role_outcome", providerId: target.providerId, modelId: target.modelId, role, outcome, observedAt: new Date(now).toISOString(), source: "runtime", correlationId: `sim-${observations.length}`, ...(failureClass ? { failureClass } : {}) };
  authority.observe(sample);
  observations.push({ route: target.routeId, role, outcome, failureClass: failureClass ?? null, at: sample.observedAt });
}

function decide(label, role, override = {}) {
  now += 30_000;
  const current = routes.map((candidate) => candidate.routeId === override.exhaustedRoute
    ? { ...candidate, windows: [window("requests", 1000, 0), window("input_tokens", 2_000_000, 1_500_000)] }
    : candidate);
  const reservations = new CapacityReservationLedger({ routes: [], now: () => now });
  const fabric = createFreeFabric({
    managedRoutes: () => current,
    managedPools: () => current.map((candidate) => ({ poolId: candidate.capacityPoolId, providerId: candidate.providerId, scope: candidate.capacityPoolScope, supplyClass: candidate.supplyClass, windows: candidate.windows, observedAt: new Date(start - 60_000).toISOString(), authoritative: true })),
    userSources: [],
    reservations,
    now: () => now,
  });
  const outcome = fabric.decide({
    requestId: `sim-${decisions.length}`,
    userId: "sim-user",
    role,
    roleQualityAdjustment: (providerId, modelId) => authority.roleQualityDelta(providerId, modelId, role),
  });
  const selected = outcome.selected?.routeId ?? null;
  decisions.push({ label, role, selected, outcome: outcome.outcome, score: Object.fromEntries(current.map((candidate) => [candidate.routeId, authority.roleQualityDelta(candidate.providerId, candidate.modelId, role)])), exhaustedRoute: override.exhaustedRoute ?? null });
  assert.equal(outcome.outcome, "ADMITTED", `${label} must retain a free route`);
  return selected;
}

assert.equal(decide("cold-start", "CODER"), "alpha");
for (let i = 0; i < 4; i++) {
  observe(alpha, "CODER", "verified_complete");
  decide(`strong-${i}`, "CODER");
}
for (let i = 0; i < 6; i++) {
  observe(alpha, "CODER", "role_failed", "NON_CONVERGENCE");
  decide(`degrade-${i}`, "CODER");
}
assert.equal(decisions.at(-1).selected, "beta", "repeated Coder failure must move work to beta");
const qualityBeforeCapacity = authority.roleQualityDelta(alpha.providerId, alpha.modelId, "CODER", now + 30_000);
assert.equal(decide("capacity-denied", "CODER", { exhaustedRoute: "alpha" }), "beta");
const qualityAfterCapacity = authority.roleQualityDelta(alpha.providerId, alpha.modelId, "CODER");
assert.equal(qualityAfterCapacity.samples, qualityBeforeCapacity.samples);
assert.equal(qualityAfterCapacity.netEvidence, qualityBeforeCapacity.netEvidence);
for (let i = 0; i < 8; i++) {
  observe(alpha, "CODER", "verified_complete");
  decide(`recover-${i}`, "CODER");
}
assert.equal(decisions.at(-1).selected, "alpha", "verified Coder work must restore alpha");
for (let i = 0; i < 4; i++) {
  observe(alpha, "REVIEWER", "role_failed", "NON_CONVERGENCE");
  observe(beta, "REVIEWER", "verified_complete");
  decide(`role-mix-${i}`, "REVIEWER");
}
assert.equal(decisions.at(-1).selected, "beta", "Reviewer evidence must choose beta");
assert.equal(decide("coder-isolated", "CODER"), "alpha", "Reviewer failures must not demote Coder");
routes.push(gamma);
for (let i = 0; i < 8; i++) decide(`new-route-${i}`, i % 2 ? "CODER" : "REVIEWER");
now += DEFAULT_ROUTE_HEALTH_POLICY.windowMs + 60_000;
const afterExpiry = decide("expired-evidence", "CODER");
assert.equal(authority.roleQualityDelta(alpha.providerId, alpha.modelId, "CODER").samples, 0);

const winnerFlips = decisions.slice(1).filter((entry, index) => entry.role === decisions[index].role && entry.selected !== decisions[index].selected).length;
const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "production EightBitRouteHealthAuthority and createFreeFabric",
  simulatedTaskDecisions: decisions.length,
  winnerFlips,
  capacityQualityContamination: qualityAfterCapacity.netEvidence !== qualityBeforeCapacity.netEvidence,
  roleIsolation: true,
  expiredEvidenceSamples: authority.roleQualityDelta(alpha.providerId, alpha.modelId, "CODER").samples,
  afterExpiry,
  observations,
  decisions,
  caveat: "Deterministic route-decision replay; it does not invoke providers, role qualification, or ForgeVerify. Each task gets a fresh capacity ledger to isolate role ranking from concurrency.",
};
await writeFile("docs/evidence/r53-role-intelligence/R53-LONG-HORIZON-ROLE-SIM.json", `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`R53 role simulation: ${decisions.length} decisions, ${winnerFlips} adjacent-role winner flips, 0 capacity-quality contamination`);
