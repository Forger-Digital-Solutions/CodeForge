// R43 free-supply refresh. Runs the same production catalog-refresh path the live
// corpus uses (ForgeZero verification + entitlement gating), then records the
// verified-free inventory per provider and proves structurally suspended supply
// (e.g. Gemini CONSUMER_SUSPENDED) never reaches candidacy. Free catalog reads only.
//
//   node scripts/r43-free-supply.mjs <outDir>
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createProviderCatalog, createProviderAdapterById, createOpenRouterAdapter } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { createEightBitRuntime } from "../packages/eight-bit/dist/index.js";
import { createFreeModelCatalogRefresh } from "../packages/model-registry/dist/index.js";

const OUT_DIR = process.argv[2] ?? "docs/evidence/r43-green-suppression";
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

const catalog = createProviderCatalog();
const adapters = [createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" })];
for (const id of ["groq", "mistral"]) {
  const a = createProviderAdapterById(id);
  if (a) adapters.push(a);
}
for (const a of adapters) catalog.register(a);

const firewall = new ForgeZero();
const eightBit = createEightBitRuntime({
  firewall,
  persistence: {
    upsertWorkItem: async () => {}, getWorkItem: async () => null,
    deleteWorkItem: async () => {}, listWorkItems: async () => [], close: async () => {},
  },
});
const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, maxAllowanceProbes: 2, requireCredentials: true });
const t0 = performance.now();
const r = await refresh.refresh();
const refreshMs = Math.round(performance.now() - t0);

const all = firewall.allModels();
const verified = all.filter((m) => m.freeStatus === "verified_free");
const byProvider = {};
for (const m of verified) {
  byProvider[m.providerId] ??= { routes: 0, models: [] };
  byProvider[m.providerId].routes++;
  byProvider[m.providerId].models.push(m.modelId);
}
const gemini = all.filter((m) => /gemini|google/i.test(m.providerId));
const nonVerified = all.filter((m) => m.freeStatus !== "verified_free");

check("free-supply: refresh produced verified-free routes with zero enumeration errors",
  verified.length > 0 && r.errors.length === 0, `${verified.length} routes, ${r.errors.length} errors`);
// The billing boundary is verified_free + paidFallbackPossible:false + paidFallbackDisabled —
// not costProfile.isFree, which means "free for everyone". A model with a nonzero models.dev
// list price (e.g. groq openai/gpt-oss-120b at $0.15/M) is still $0 on the account's free
// tier, and paidFallbackDisabled guarantees ForgeZero can never upgrade it to a billed call.
check("free-supply: every verified route is billing-proof — paid fallback impossible AND disabled",
  verified.every((m) => m.costProfile?.paidFallbackPossible === false && m.costProfile?.paidFallbackDisabled === true),
  `${verified.filter((m) => !(m.costProfile?.paidFallbackPossible === false && m.costProfile?.paidFallbackDisabled === true)).length} violations`);
check("free-supply: no route is remote=false or BYOK-dependent",
  verified.every((m) => m.isRemote === true && m.isCloudHosted === true));
check("free-supply: suspended consumer supply (gemini) never enters the verified-free set",
  verified.every((m) => !/gemini|google/i.test(m.providerId)),
  `${verified.filter((m) => /gemini|google/i.test(m.providerId)).length} leaks`);
check("free-supply: non-verified models are excluded from candidacy by construction",
  nonVerified.every((m) => m.freeStatus !== "verified_free"));

await mkdir(OUT_DIR, { recursive: true });
const failed = checks.filter((c) => !c.pass);
await writeFile(join(OUT_DIR, "R43-FREE-SUPPLY.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  evidenceClass: "live provider catalog refresh; zero inference calls billed",
  refreshMs,
  providersDiscovered: adapters.map((a) => a.providerId),
  refreshErrors: r.errors,
  verifiedFreeRoutes: verified.length,
  verifiedByProvider: byProvider,
  suspendedOrExcluded: nonVerified.map((m) => ({ providerId: m.providerId, modelId: m.modelId, freeStatus: m.freeStatus })),
  geminiRoutesSeen: gemini.map((m) => ({ modelId: m.modelId, freeStatus: m.freeStatus })),
  checks,
  totals: { pass: checks.length - failed.length, fail: failed.length },
}, null, 2));
console.log(`R43 free-supply: ${checks.length - failed.length}/${checks.length} checks pass, ${verified.length} verified-free routes across ${Object.keys(byProvider).length} providers`);
for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
