// R49 admission diagnosis: rebuild the mission's exact fabric stack and dump every
// candidate's verdict per role — explains a live mission's denials without re-running it.
//   node scripts/r49-admission-diagnosis.mjs [--qual-db=<path>]
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForgeZero, CapacityReservationLedger } from "@codeforge/forge-zero";
import {
  createProviderCatalog,
  createProviderAdapterById,
  createOpenRouterAdapter,
  defaultCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  createEightBitRouteHealthAuthority,
  FreeFabric,
  SqliteQualificationPersistence,
  FABRIC_MODEL_ROLE,
} from "@codeforge/eight-bit";
import { createFreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const qualDbPath = option("qual-db", join(tmpdir(), "r46-qualification.db"));
const PROVIDERS = ["groq", "mistral", "openrouter"];
const ENV_KEY = { groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY" };

const present = PROVIDERS.filter((id) => (process.env[ENV_KEY[id]] ?? "").trim().length > 0);
const persistence = createSessionPersistence({ dbPath: ":memory:" });
const eventStore = new EventStore();
const firewall = new ForgeZero();
const routeHealth = createEightBitRouteHealthAuthority();
const registry = new NormalizedModelRegistry();
const catalog = createProviderCatalog();
const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry, routeHealth });

for (const id of present) freeCloud.registerManagedPool(id, `live-acct-${id}`);
const adapters = [];
for (const id of present) {
  const adapter = id === "openrouter"
    ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1", onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) })
    : createProviderAdapterById(id, { onResponse: freeCloud.managedAccountObserver(id, `live-acct-${id}`) });
  if (adapter) adapters.push(adapter);
}
for (const adapter of adapters) catalog.register(adapter);
await freeCloud.createCatalogRefresh({ maxAllowanceProbes: 8, requireCredentials: true }).refresh();
for (const adapter of adapters) {
  freeCloud.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ENVIRONMENT", authState: "ok", planAttested: true });
}
const qualDb = createSessionPersistence({ dbPath: qualDbPath });
await qualDb.init();
freeCloud.attachQualificationStore(new SqliteQualificationPersistence(qualDb));
console.log(`[diag] receipts restored: ${await freeCloud.loadQualification()}`);

const freeFabric = new FreeFabric({
  managedRoutes: () => freeCloud.capacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
  managedPools: () => freeCloud.capacityPools().filter((pool) => pool.scope !== "PER_USER_POOL"),
  userSources: [{ routesForUser: (userId) => freeCloud.routesForUser(userId), poolsForUser: (userId) => freeCloud.poolsForUser(userId) }],
  health: routeHealth,
  reservations: new CapacityReservationLedger({ routes: [], pools: [], maxActiveReservationsPerUser: 8 }),
  tokenizerRatioFor: (providerId) =>
    defaultCapacityGovernor.tokenizerRatio(providerId) ?? defaultCapacityGovernor.maxObservedTokenizerRatio(),
});
const userId = "r49-live-operator";
const userIdentities = freeCloud.capacityIdentitiesFor(userId);

// Mirror AgentRuntime.roleRouteFilter / roleQualificationTierCallback exactly.
const roleQualificationStatus = (providerId, modelId, role) => {
  const receipt = freeCloud.getQualificationReceipt(providerId, modelId);
  return receipt?.roleResults?.[role]?.status;
};
const roleRouteFilter = (role) => (providerId, modelId) => {
  if (!freeCloud.isForgeAutoEligible(providerId, modelId)) return false;
  const status = roleQualificationStatus(providerId, modelId, role);
  return status === undefined || status === "QUALIFIED" || status === "PROBATION";
};
const tierFor = (role) => (providerId, modelId) => {
  const status = roleQualificationStatus(providerId, modelId, role);
  return status === "QUALIFIED" ? "QUALIFIED" : status === "PROBATION" ? "PROBATION" : "NOT_TESTED";
};

const decide = (eightBitRole, extra = {}) => freeFabric.decide({
  requestId: `diag:${eightBitRole}:${Math.random().toString(36).slice(2, 8)}`,
  userId,
  userIdentities,
  role: FABRIC_MODEL_ROLE[eightBitRole],
  healthRole: eightBitRole,
  taskKind: "diagnosis",
  demand: { requests: 1, estimatedPromptTokens: 4_096, outputTokens: 2_048 },
  routeAdmission: roleRouteFilter(eightBitRole),
  roleQualificationTierFor: tierFor(eightBitRole),
  ...extra,
});

const report = (label, decision) => {
  console.log(`\n=== ${label} → ${decision.outcome} ===`);
  if (decision.selected) {
    console.log(`  selected: ${decision.selected.providerId}/${decision.selected.modelId} pool=${decision.selected.capacityPoolId}`);
    if (decision.selected.reservationId) freeFabric.release(decision.selected.reservationId);
  }
  if (decision.nextAvailableAt) console.log(`  nextAvailableAt: ${decision.nextAvailableAt}`);
  console.log(`  explanation: ${decision.explanation?.summary ?? "-"}`);
  for (const c of decision.explanation?.candidates ?? []) {
    console.log(`  ${c.status.padEnd(18)} ${c.providerId}/${c.modelId} pool=${c.capacityPoolId} score=${c.effectiveScore ?? "?"} reasons=${(c.reasonCodes ?? []).join(",")}`);
  }
};

const explorer = decide("EXPLORER");
report("EXPLORER", explorer);
const coder = decide("CODER");
report("CODER", coder);
const coderPool = coder.selected?.capacityPoolId;
const reviewer = decide("REVIEWER", coderPool ? { preferIndependentFromPoolId: coderPool } : {});
report(`REVIEWER (preferIndependentFrom=${coderPool})`, reviewer);
const planner = decide("PLANNER");
report("PLANNER", planner);
const toolAgent = decide("TOOL_AGENT");
report("TOOL_AGENT", toolAgent);

persistence.close();
qualDb.close?.();
