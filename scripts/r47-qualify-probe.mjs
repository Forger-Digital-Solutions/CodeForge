// R47 §10: bounded qualification probe — one staged cycle against pending routes of ONE
// provider. Goal: add a second independent explorer-capable account (mistral is the only
// untested account with plausible candidates). No missions run; receipts persist durably.
//
//   node scripts/r47-qualify-probe.mjs [providerId] [budget]
import os from "node:os";
import path from "node:path";
import { createProviderCatalog, createProviderAdapterById, createOpenRouterAdapter } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { createEightBitRouteHealthAuthority } from "../packages/eight-bit/dist/index.js";
import { createFreeCloudService, NormalizedModelRegistry } from "../packages/model-registry/dist/index.js";
import { createSessionPersistence } from "../packages/sessions/dist/index.js";
import { SqliteQualificationPersistence } from "../packages/eight-bit/dist/index.js";

const PROVIDER = process.argv[2] ?? "mistral";
const BUDGET = Number(process.argv[3] ?? 2);
const QUAL_DB = process.env.R47_QUAL_DB ?? path.join(os.tmpdir(), "r46-qualification.db");

const catalog = createProviderCatalog();
const firewall = new ForgeZero();
const routeHealth = createEightBitRouteHealthAuthority();
const registry = new NormalizedModelRegistry();
const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth });

for (const id of ["openrouter", "groq", "mistral"]) {
  freeCloud.registerManagedPool(id, `live-acct-${id}`);
}
const adapters = [createOpenRouterAdapter({
  baseUrl: "https://openrouter.ai/api/v1",
  onResponse: freeCloud.managedAccountObserver("openrouter", "live-acct-openrouter"),
})];
for (const id of ["groq", "mistral"]) {
  const a = createProviderAdapterById(id, { onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) });
  if (a) adapters.push(a);
}
for (const a of adapters) catalog.register(a);
console.log("providers:", adapters.map((a) => a.providerId).join(", "));

const refresh = freeCloud.createCatalogRefresh({ maxAllowanceProbes: 0, requireCredentials: true });
const r = await refresh.refresh();
console.log(`refresh: ${r.errors.length} errors`);

for (const a of adapters) {
  freeCloud.setConnection({ providerId: a.providerId, connected: true, credentialSource: "ENVIRONMENT", authState: "ok", planAttested: true });
}

const qualDb = createSessionPersistence({ dbPath: QUAL_DB });
await qualDb.init();
freeCloud.attachQualificationStore(new SqliteQualificationPersistence(qualDb));
console.log(`qualification receipts restored: ${await freeCloud.loadQualification()}`);

const pending = freeCloud.pendingQualification();
console.log(`pending routes: ${pending.length}; pending for ${PROVIDER}: ${pending.filter((p) => p.providerId === PROVIDER).length}`);
for (const p of pending.filter((x) => x.providerId === PROVIDER).slice(0, 8)) {
  console.log(`  candidate: ${p.providerId}/${p.providerModelId} health=${p.health} ctx=${p.contextWindow}`);
}

console.log(`\nqualifyPending({ budget: ${BUDGET}, providerId: "${PROVIDER}" }) — staged, durable`);
const receipts = await freeCloud.qualifyPending({ budget: BUDGET, providerId: PROVIDER });
for (const rec of receipts) {
  const roles = Object.entries(rec.roleResults ?? {}).map(([role, rr]) => `${role}=${rr.status}`).join(" ");
  console.log(`receipt ${rec.providerId}/${rec.modelId}: ${rec.qualificationState}  ${roles}`);
}
console.log(receipts.length === 0 ? "no receipts produced (transient, budget gate, or cycle interval)" : `${receipts.length} receipt(s) persisted`);
