// Micro-benchmark for CapacityReservationLedger.reserve() cost as active reservations grow.
// Measures the production control-plane primitive the synthetic harness does not exercise.
// Indexed ledger target: O(1) admission — flat reserve() latency from 1k to 1M actives.
import { CapacityReservationLedger } from "../packages/forge-zero/dist/capacity-reservations.js";

const NOW = Date.now();
const RESET = new Date(NOW + 86_400_000).toISOString();
const windows = [
  { unit: "requests", limit: 10_000_000, remaining: 10_000_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
  { unit: "input_tokens", limit: 10_000_000_000, remaining: 10_000_000_000, resetAt: RESET, scope: "ORG", observedAt: new Date(NOW).toISOString(), authoritative: true },
];
const route = {
  routeId: "r1", providerId: "p1", modelId: "m1", canonicalModelId: "m1", family: "f", gateway: "p1",
  supplyClass: "PURE_MANAGED_FREE", capacityPoolId: "shared:p1", capacityPoolScope: "SHARED_OWNER_POOL",
  capacityScope: "ORG", dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED",
  explicitZeroPrice: true, paidFallbackDisabled: true, managedMultiUserAllowed: true,
  privacyClass: "standard", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 70, healthy: true, enabled: true, windows,
};
const pool = { poolId: "shared:p1", providerId: "p1", scope: "SHARED_OWNER_POOL", supplyClass: "PURE_MANAGED_FREE", windows, observedAt: new Date(NOW).toISOString(), authoritative: true };

const ledger = new CapacityReservationLedger({ routes: [route], pools: [pool], maxActiveReservationsPerUser: 5, now: () => NOW });
let seq = 0;
const req = () => ({
  reservationId: `res-${seq}`, userId: `u${seq}`, routeIds: ["r1"], role: "PRIMARY_CODING_AGENT",
  taskKind: "task", requests: 1, inputTokens: 4000, outputTokens: 1000,
  priority: "normal", createdAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + 300_000).toISOString(),
});

let active = 0;
for (const target of [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]) {
  const fillStart = performance.now();
  while (active < target) {
    const d = ledger.reserve(req());
    if (!d.admitted) { console.log(`DENIED at ${active}: ${d.reason}`); break; }
    active++;
    seq++;
  }
  const fillMs = performance.now() - fillStart;
  const t0 = performance.now();
  const N = 500;
  for (let i = 0; i < N; i++) { ledger.reserve(req()); seq++; }
  const ms = (performance.now() - t0) / N;
  console.log(`active=${ledger.snapshot().activeReservations}  reserve() avg ${ms.toFixed(3)} ms  (fill ${fillMs.toFixed(0)} ms, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB)`);
}
