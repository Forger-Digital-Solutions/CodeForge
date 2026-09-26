// R46 §6 free supply inventory — live refresh of every credentialed provider, enriched dump
// of ForgeZero records + route health + role suitability, lifecycle classification, and the
// independent quota-pool count (§27: 20 OpenRouter :free models behind one account = 1 pool).
//
//   node scripts/r46-supply-inventory.mjs [out.json]
import fs from "node:fs";
import { createProviderCatalog, createProviderAdapterById, createOpenRouterAdapter, CloudflareNeuronBudgetGuard, GraphqlCloudflareUsageSource, InMemoryCloudflareNeuronBudgetStore } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { createEightBitRuntime } from "../packages/eight-bit/dist/index.js";
import { createFreeModelCatalogRefresh } from "../packages/model-registry/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r46-free-supply-resilience/R46-FREE-SUPPLY-INVENTORY.json";
const NULL_PERSISTENCE = { upsertWorkItem: async () => {}, getWorkItem: async () => null, deleteWorkItem: async () => {}, listWorkItems: async () => [], getWorkItems: async () => [], getWorkItemsByKind: async () => [], close: async () => {} };

// Every provider with credentials in this environment. cerebras is inventoried but its
// PROMOTIONAL_CREDIT class keeps it out of managed Free (§24).
const CANDIDATES = ["openrouter", "groq", "mistral", "google", "cloudflare-workers-ai", "cerebras"];

const catalog = createProviderCatalog();
const adapters = [];
const adapterStatus = [];
for (const id of CANDIDATES) {
  // cloudflare-workers-ai's env aliases don't match the computed <ID>_API_KEY convention —
  // pass the documented env values through explicitly.
  const opts = id === "cloudflare-workers-ai"
    ? {
        apiKey: process.env.CLOUDFLARE_API_KEY,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        // The default guard's usage source is deliberately blind (always unknown -> fail
        // closed). Wire the real GraphQL analytics source so the daily-neuron budget can
        // actually be measured against the 10k/day free allocation.
        cloudflareNeuronGuard: new CloudflareNeuronBudgetGuard({
          store: new InMemoryCloudflareNeuronBudgetStore(),
          usageSource: new GraphqlCloudflareUsageSource({
            resolveToken: () => process.env.CLOUDFLARE_API_KEY,
            resolveAccountId: () => process.env.CLOUDFLARE_ACCOUNT_ID,
          }),
        }),
      }
    : {};
  const a = id === "openrouter" ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" }) : createProviderAdapterById(id, opts);
  if (!a) { console.log(`${id}: no adapter`); continue; }
  try {
    const models = await a.listModels();
    console.log(`${id}: adapter ok, ${models.length} catalog models`);
    adapters.push(a);
    adapterStatus.push({ provider: id, catalogReachable: true, catalogModels: models.length });
  } catch (e) {
    console.log(`${id}: listModels failed — ${String(e?.message).slice(0, 120)}`);
    adapters.push(a); // still register so refresh can classify the failure
    adapterStatus.push({ provider: id, catalogReachable: false, error: String(e?.code ?? e?.message).slice(0, 200), message: String(e?.message).replace(/\s+/g, " ").slice(0, 200) });
  }
}
for (const a of adapters) catalog.register(a);

const firewall = new ForgeZero();
const eightBit = createEightBitRuntime({ firewall, persistence: NULL_PERSISTENCE });
const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, maxAllowanceProbes: 2, requireCredentials: true });
const t = Date.now();
const r = await refresh.refresh();
console.log(`refresh: ${r.registered} registered, ${r.failed} failed, ${r.errors.length} errors, ${Math.round((Date.now() - t) / 1000)}s`);

const ROLES = ["EXPLORER", "PLANNER", "CODER", "REVIEWER", "FORGE_VERIFY"];
const PROMO = { cerebras: "PROMOTIONAL_CREDIT — not managed Free (§24)" };

const models = firewall.allModels();
const routes = models.map((m) => {
  let health = null;
  try { health = eightBit.routeHealth?.assess?.(m.providerId, m.modelId, { role: "CODER" }) ?? null; } catch {}
  const roleSuitability = m.roleSuitability ?? {};
  const lifecycle =
    PROMO[m.providerId] ? "QUARANTINED" :
    m.freeStatus === "verified_free" ? "VERIFIED_FREE" :
    m.freeStatus === "expired" ? "STALE" :
    m.freeStatus === "temporarily_unavailable" ? "UNAVAILABLE" :
    m.freeStatus === "paid" ? "QUARANTINED" : "PROBATION";
  return {
    provider: m.providerId, model: m.modelId, displayName: m.displayName,
    family: m.family ?? null, accessClass: m.accessClass ?? null,
    upstreamSource: m.upstreamSource ?? null,
    freeStatus: m.freeStatus, verifiedAt: m.freeStatusVerifiedAt ?? m.lastVerified ?? null,
    contextWindow: m.contextWindow ?? null,
    capabilities: m.capabilities,
    costProfile: m.costProfile ?? null,
    roleSuitability,
    healthSnapshot: health ? { tier: health.tier ?? health.state ?? null, hardExclude: health.hardExclude ?? null, confidence: health.confidence ?? null } : null,
    cooldown: m.health?.cooldownUntil ?? null,
    deprecated: m.deprecated ?? false,
    qualificationVersion: m.qualificationVersion ?? null,
    empiricalStatus: m.empiricalStatus ?? null,
    capacityEvidence: m.capacityEvidence ?? null,
    quarantine: PROMO[m.providerId] ?? (m.freeStatus === "paid" ? "paid record" : null),
    lifecycle,
    paidFallbackPossible: false, // ForgeZero gate: paid records are never registered eligible
    paidFallbackDisabled: true,
  };
});

// §27 independent pools: provider+account granularity. Each direct provider = one account pool;
// all OpenRouter :free models share the account-level window.
const pools = {};
for (const rt of routes) {
  const key = rt.provider; // one credentialed account per provider in this deployment
  (pools[key] ??= { provider: rt.provider, routes: [], verified: 0 }).routes.push(rt.model);
  if (rt.lifecycle === "VERIFIED_FREE") pools[key].verified++;
}
const roleCoverage = {};
for (const role of ROLES) roleCoverage[role] = { qualifiedPools: [], total: 0 };
for (const rt of routes.filter((x) => x.lifecycle === "VERIFIED_FREE")) {
  for (const role of ROLES) {
    const s = rt.roleSuitability?.[role];
    const state = typeof s === "string" ? s : s?.state ?? s?.status;
    if (state === "qualified" || state === "QUALIFIED" || rt.roleSuitability?.[role] === true) {
      roleCoverage[role].total++;
      if (!roleCoverage[role].qualifiedPools.includes(rt.provider)) roleCoverage[role].qualifiedPools.push(rt.provider);
    }
  }
}

const providerOutcomes = CANDIDATES.map((id) => {
  const st = adapterStatus.find((s) => s.provider === id) ?? { provider: id, catalogReachable: false, error: "no adapter" };
  const registered = routes.filter((x) => x.provider === id);
  return {
    provider: id,
    ...st,
    registeredRoutes: registered.length,
    verifiedFree: registered.filter((x) => x.lifecycle === "VERIFIED_FREE").length,
    lifecycle: PROMO[id] ? "QUARANTINED"
      : registered.some((x) => x.lifecycle === "VERIFIED_FREE") ? "VERIFIED_POOL"
      : "UNAVAILABLE",
    note: PROMO[id] ?? null,
  };
});

const out = {
  at: new Date().toISOString(),
  refreshMs: Date.now() - t,
  providersQueried: adapters.map((a) => a.providerId),
  providerOutcomes,
  refresh: { registered: r.registered, failed: r.failed, errors: r.errors.slice(0, 20), driftEvents: r.driftEvents?.length ?? 0 },
  counts: {
    catalogRoutes: routes.length,
    verifiedFree: routes.filter((x) => x.lifecycle === "VERIFIED_FREE").length,
    probation: routes.filter((x) => x.lifecycle === "PROBATION").length,
    stale: routes.filter((x) => x.lifecycle === "STALE").length,
    unavailable: routes.filter((x) => x.lifecycle === "UNAVAILABLE").length,
    quarantined: routes.filter((x) => x.lifecycle === "QUARANTINED").length,
    independentPools: Object.keys(pools).filter((p) => pools[p].verified > 0).length,
  },
  pools, roleCoverage, routes,
};
fs.mkdirSync("docs/evidence/r46-free-supply-resilience", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log("counts:", JSON.stringify(out.counts));
console.log(`wrote ${OUT}`);
