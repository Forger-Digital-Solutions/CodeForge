import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { CapacityReservationLedger } from '@codeforge/forge-zero';
import { createFreeFabric, createEightBitRouteHealthAuthority } from '@codeforge/eight-bit';

const observed = Date.now();
let now = observed;
const iso = () => new Date(now).toISOString();
const receipt = { sourceDocumentation: 'simulation:provider-docs', termsEvidence: 'simulation:terms', priceEvidence: 'simulation:zero', privacyEvidence: 'simulation:public', verifiedAt: iso(), recheckAt: new Date(now + 86400000).toISOString(), qualificationAt: iso() };
const common = { lifecycle: 'APPROVED', explicitZeroPrice: true, paidFallbackDisabled: true, managedMultiUserAllowed: true, privacyClass: 'permissive', dataPolicyProfile: 'PUBLIC_CODE_ONLY', marginalCostToCodeForge: 0, egressMode: 'CLIENT_DIRECT', freePrivacyClass: 'DATA_COLLECTION_ALLOWED', trainingUse: 'YES', admissionReceipt: receipt, enabled: true, healthy: true, roles: ['CODER', 'EXPLORER', 'PLANNER', 'REVIEWER'], qualityScore: 80, contextWindow: 32768 };
const concurrency = { unit: 'concurrency', limit: 500, remaining: 500, scope: 'GLOBAL', observedAt: iso(), resetAt: new Date(now + 86400000).toISOString(), authoritative: true, period: 'UNKNOWN' };
const horde = { ...common, routeId: 'community', providerId: 'ai-horde', gateway: 'ai-horde', modelId: 'simulated-qualified-model', canonicalModelId: 'simulated-qualified-model', family: 'simulation', supplyClass: 'COMMUNITY_ANONYMOUS_FREE', capacityPoolId: 'shared:ai-horde', capacityPoolScope: 'SHARED_OWNER_POOL', capacityScope: 'GLOBAL', quotaDomainType: 'GLOBAL_SHARED', quotaDomainId: 'shared:ai-horde', windows: [concurrency] };
const kilo = { ...common, routeId: 'kilo', providerId: 'kilo-free-direct', gateway: 'kilo-free-direct', modelId: 'kilo-auto/free', canonicalModelId: 'kilo-auto/free', family: 'simulation', supplyClass: 'PACKAGED_FREE_DIRECT', capacityPoolId: 'kilo:simulation-egress', capacityPoolScope: 'PER_USER_POOL', capacityScope: 'SOURCE_IP', quotaDomainType: 'PUBLIC_IP', quotaDomainId: 'kilo:simulation-egress', capacityIdentity: 'heavy', windows: [{ ...concurrency, unit: 'requests', scope: 'SOURCE_IP', limit: 10000, remaining: 10000, period: 'DAILY_RESET' }] };
let routes = [kilo, horde];
const reservations = new CapacityReservationLedger({ routes: [], pools: [], now: () => now });
const health = createEightBitRouteHealthAuthority({ now: () => now });
const fabric = createFreeFabric({ managedRoutes: () => routes, managedPools: () => routes.map((route) => ({ poolId: route.capacityPoolId, providerId: route.providerId, scope: route.capacityPoolScope, supplyClass: route.supplyClass, windows: route.windows, observedAt: iso(), authoritative: true, capacityIdentity: route.capacityIdentity })), health, reservations, now: () => now });
const context = { dataClass: 'PUBLIC_CODE', userConsented: true };
const decide = (user, id, extra = {}) => fabric.decide({ requestId: id, userId: user, userIdentities: [user], role: 'CODER', dataContext: context, demand: { requests: 1, promptTokens: 200, outputTokens: 300 }, ...extra });
const output = { generatedAt: new Date().toISOString(), evidenceClass: 'DETERMINISTIC_SIMULATION_NO_LIVE_INFERENCE', profiles: [], falseWaits: 0, privateLeaks: 0, paidSelections: 0, providerRecovery: [], fairness: {}, latencyMs: [], reservationsAfter: null };
for (const users of [10, 25, 50, 100]) {
  const started = performance.now();
  const admitted = [];
  for (let user = 0; user < users; user++) for (let task = 0; task < 3; task++) {
    const decision = decide(`user-${user}`, `wave-${users}-${user}-${task}`);
    assert.equal(decision.outcome, 'ADMITTED');
    admitted.push(decision.selected.reservationId);
  }
  assert.equal(reservations.snapshot().activeReservations, users * 3);
  for (const reservation of admitted) reservations.release(reservation);
  output.profiles.push({ concurrentUsers: users, overlappingReservations: admitted.length, queued: 0, released: admitted.length, wallMs: performance.now() - started });
}
let dailyTasks = 0;
for (let user = 0; user < 373; user++) for (let task = 0; task < 2; task++) {
  const decision = decide(`daily-${user}`, `daily-${user}-${task}`);
  assert.equal(decision.outcome, 'ADMITTED');
  reservations.release(decision.selected.reservationId);
  dailyTasks++;
}
output.dailyProfile = { users: 373, tasksPerUser: 2, scheduledTasks: dailyTasks, liveUsers: 0, arrivalPattern: 'Sequential daily arrivals; separate peak overlap profiles above. No upstream throughput extrapolation.' };
routes = [horde];
const heavy = Array.from({ length: 3 }, (_, index) => decide('heavy', `heavy-${index}`));
assert.equal(decide('heavy', 'heavy-fourth').outcome, 'QUEUED_FOR_CAPACITY');
const lights = ['B', 'C', 'D'].map((user) => decide(user, `light-${user}`));
assert.ok(lights.every((decision) => decision.outcome === 'ADMITTED'));
for (const decision of [...heavy, ...lights]) reservations.release(decision.selected.reservationId);
output.fairness = { heavyAdmitted: 3, heavyFourth: 'QUEUED_FOR_CAPACITY', lightUsers: 3, lightAdmitted: 3, starvationObserved: 0, scope: 'Local overlapping reservations, not upstream community scheduling' };
for (let round = 0; round < 250; round++) {
  routes = round % 2 === 0 ? [{ ...kilo, healthy: false }, horde] : [kilo, { ...horde, healthy: false }];
  const started = performance.now();
  const decision = decide('heavy', `degradation-${round}`);
  output.latencyMs.push(performance.now() - started);
  if (decision.outcome !== 'ADMITTED') output.falseWaits++;
  assert.equal(decision.outcome, 'ADMITTED');
  assert.equal(decision.selected.providerId, round % 2 === 0 ? 'ai-horde' : 'kilo-free-direct');
  reservations.release(decision.selected.reservationId);
}
for (const provider of ['kilo-free-direct', 'ai-horde']) {
  const modelId = provider === 'ai-horde' ? horde.modelId : kilo.modelId;
  health.observe({ kind: 'call_failure', providerId: provider, modelId, observedAt: iso(), source: 'runtime', reason: 'RATE_LIMIT', retryAfterMs: 2000 });
  const failed = health.assess(provider, modelId);
  now += 120000;
  health.observe({ kind: 'call_success', providerId: provider, modelId, observedAt: iso(), source: 'probe', latencyMs: 12 });
  const recovered = health.assess(provider, modelId);
  assert.equal(recovered.hardExclude, false);
  output.providerRecovery.push({ provider, failed, recovered, simulated: true });
}
routes = [{ ...kilo, healthy: false }, horde];
for (let attempt = 0; attempt < 250; attempt++) {
  const denied = decide('private-user', `private-${attempt}`, { dataContext: { dataClass: 'PRIVATE_CODE', userConsented: true } });
  if (denied.selected?.providerId === 'ai-horde') output.privateLeaks++;
  assert.equal(denied.outcome, 'DENIED_NO_SUPPLY');
}
routes = [{ ...horde, lifecycle: 'INERT', roles: [] }];
assert.equal(decide('new-model', 'inert').outcome, 'DENIED_NO_SUPPLY');
output.newCandidate = { status: 'INERT', admitted: false, qualificationLoopProven: false };
routes = [kilo, { ...horde, marginalCostToCodeForge: 1 }];
assert.equal(decide('other-user', 'paid').selected, undefined);
output.reservationsAfter = reservations.snapshot();
assert.equal(output.reservationsAfter.activeReservations, 0);
output.status = 'PASS';
await writeFile('docs/evidence/r66-everyday-free-readiness/R66-SCALE-SIMULATION.json', `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ status: output.status, profiles: output.profiles.map(({ concurrentUsers }) => concurrentUsers), dailyTasks, falseWaits: output.falseWaits, privateLeaks: output.privateLeaks }));
