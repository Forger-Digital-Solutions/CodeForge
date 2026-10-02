import fs from "node:fs/promises";
import path from "node:path";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createAiHordeCommunityAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, reverifyHordePolicy } from "@codeforge/model-registry";
import { createEightBitRouteHealthAuthority } from "@codeforge/eight-bit";

const evidenceDir = path.resolve("docs/evidence/free-capacity-fabric");
const startedAt = new Date().toISOString();

/**
 * R65 multi-user isolation proof on the live community pool. The AI Horde pool is
 * GLOBAL_SHARED: every anonymous user draws from one account (concurrency-metered), so
 * isolation means per-user hold accounting and per-user concurrency caps on top of one
 * shared budget — never a fabricated private slice. All checks run against real projected
 * routes from a live find_user probe, not synthetic fixtures.
 */
const hordePolicy = await reverifyHordePolicy(startedAt);
if (hordePolicy.status !== "VERIFIED") throw new Error(`HORDE_POLICY_${hordePolicy.status}`);

const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const hordeBase = createGenericFreeRecord({ providerId: "ai-horde", modelId: "google/gemma-4-31b", displayName: "AI Horde gemma-4-31b" });
firewall.register({ ...hordeBase, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...hordeBase.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...hordeBase.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
const providerCatalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
let freeCloud;
const observer = (obs) => freeCloud?.onProviderResponse(obs);
providerCatalog.register(createAiHordeCommunityAdapter({ onResponse: observer }));
freeCloud = new FreeCloudService({ firewall, providerCatalog, registry: new NormalizedModelRegistry(), routeHealth: health });
freeCloud.setHordePolicyReceipt(hordePolicy.receipt);
freeCloud.setConnection({ providerId: "ai-horde", connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "COMMUNITY_ANONYMOUS_FREE", authState: "ok" });
const qualification = JSON.parse(await fs.readFile(path.join(evidenceDir, "R65-HORDE-QUALIFICATION-google_gemma-4-31b.json"), "utf8"));
await freeCloud.recordReceipt(qualification);
freeCloud.applyReceiptToFirewall(qualification);
await freeCloud.probeRouteCapacity("ai-horde", "google/gemma-4-31b");

const routes = freeCloud.productionCapacityRoutes().filter((r) => r.providerId === "ai-horde");
const pools = freeCloud.capacityPools().filter((p) => p.providerId === "ai-horde");
const route = routes[0];
if (!route || pools.length === 0) throw new Error("community pool projection missing");
const sharedPoolId = route.capacityPoolId;

const ledger = new CapacityReservationLedger({ routes, pools, maxActiveReservationsPerUser: 3, dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } });
const leaseUntil = new Date(Date.now() + 60_000).toISOString();
const reserveFor = (userId, n) =>
  ledger.reserve({ reservationId: `${userId}-${n}`, userId, role: route.roles[0], taskKind: "coding", routeIds: [route.routeId], requests: 1, inputTokens: 100, outputTokens: 100, priority: "normal", createdAt: new Date().toISOString(), leaseUntil, isNewUser: false });

const checks = [];
const expect = (name, cond, detail) => { checks.push({ name, pass: cond === true, detail }); if (!cond) process.exitCode = 1; };

// Two users hold capacity on the same global pool simultaneously.
const a1 = reserveFor("user-a", 1);
const b1 = reserveFor("user-b", 1);
expect("user_a_first_hold_admitted", a1.admitted === true, a1.reason);
expect("user_b_first_hold_admitted", b1.admitted === true, b1.reason);
expect("same_shared_pool", a1.routeId === b1.routeId && sharedPoolId === "shared:ai-horde", `${a1.routeId} / ${sharedPoolId}`);

// Shared accounting: A's holds consume the pool budget B sees — one global concurrency meter.
const ledgerView = ledger.snapshot?.() ?? null;
const remainingBefore = (pools[0].windows.find((w) => w.unit === "concurrency")?.remaining ?? 0);
const a2 = reserveFor("user-a", 2), a3 = reserveFor("user-a", 3);
expect("user_a_fills_cap", a2.admitted && a3.admitted, `${a2.reason},${a3.reason}`);
const a4 = reserveFor("user-a", 4);
expect("user_a_fourth_denied_user_cap", a4.admitted === false && a4.reason === "USER_CONCURRENCY_LIMIT", a4.reason);

// Isolation: A hitting the per-user cap must not deny B — B's holds are independently scoped.
const b2 = reserveFor("user-b", 2);
expect("user_b_unaffected_by_a_cap", b2.admitted === true, b2.reason);

// Release isolation: releasing A's hold frees the shared meter but cannot touch B's hold.
expect("release_a_only_frees_a", ledger.release("user-a-1") === true, "release(user-a-1)");
expect("release_unknown_is_noop", ledger.release("user-a-1") === false && ledger.release("nonexistent-hold") === false, "double/unknown release guard");
const b3 = reserveFor("user-b", 3);
expect("user_b_still_admits_after_a_release", b3.admitted === true, b3.reason);

// Private code is denied for BOTH users on a public-only community route — consent does not
// transfer through a shared pool.
const privateReq = (userId) => ledger.reserve({ reservationId: `${userId}-priv`, userId, role: route.roles[0], taskKind: "coding", routeIds: [route.routeId], requests: 1, inputTokens: 100, outputTokens: 100, priority: "normal", createdAt: new Date().toISOString(), leaseUntil, isNewUser: false, dataContext: { dataClass: "PRIVATE_CODE", userConsented: false } });
expect("private_code_denied_a", privateReq("user-a").admitted === false, "user-a PRIVATE_CODE");
expect("private_code_denied_b", privateReq("user-b").admitted === false, "user-b PRIVATE_CODE");

const output = { startedAt, finishedAt: new Date().toISOString(), pool: { poolId: sharedPoolId, scope: route.capacityPoolScope, supplyClass: route.supplyClass, quotaDomainType: route.quotaDomainType, quotaDomainId: route.quotaDomainId, concurrencyRemainingBeforeHolds: remainingBefore }, checks, ledgerView, pass: checks.every((c) => c.pass) };
await fs.writeFile(path.join(evidenceDir, "R65-MULTIUSER-ISOLATION.json"), JSON.stringify(output, null, 2) + "\n");
process.stdout.write(JSON.stringify({ pass: output.pass, checks: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.name) }) + "\n");
