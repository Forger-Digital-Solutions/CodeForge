import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createKiloFreeDirectAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime } from "@codeforge/server";

const startedAt = new Date().toISOString();
const qualification = JSON.parse(await fs.readFile(path.resolve("docs/evidence/free-capacity-fabric/kilo-live-qualification.json"), "utf8"));
if (qualification.providerId !== "kilo-free-direct" || qualification.modelId !== "kilo-auto/free" || qualification.roleResults.CODER?.status !== "QUALIFIED" || Date.now() - Date.parse(qualification.completedAt) > 86_400_000) throw new Error("A current real Coder qualification receipt is required");
const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-kilo-direct-"));
const persistence = createSessionPersistence({ dbPath: ":memory:" });
await persistence.init();
const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const providerId = "kilo-free-direct";
const modelId = "kilo-auto/free";
const model = createGenericFreeRecord({ providerId, modelId, displayName: "Kilo Auto Free" });
firewall.register({ ...model, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...model.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...model.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
const catalog = new InMemoryProviderCatalog();
catalog.register(createKiloFreeDirectAdapter());
const receipt = {
  sourceDocumentation: "https://kilo.ai/docs/gateway/models-and-providers", termsEvidence: "https://kilo.ai/terms",
  priceEvidence: "https://kilo.ai/docs/gateway/usage-and-billing", privacyEvidence: "https://kilo.ai/docs/getting-started/using-kilo-for-free",
  verifiedAt: "2026-10-01T00:00:00Z", recheckAt: "2026-10-08T00:00:00Z", qualificationAt: qualification.completedAt,
};
const poolId = "kilo-direct:dogfood-ip";
const route = {
  routeId: "fabric:kilo-auto-free", providerId, modelId, canonicalModelId: modelId, family: "kilo-auto", gateway: providerId,
  supplyClass: "PACKAGED_FREE_DIRECT", quotaDomainType: "PUBLIC_IP", quotaDomainId: poolId,
  egressMode: "CLIENT_DIRECT", marginalCostToCodeForge: 0, freePrivacyClass: "DATA_COLLECTION_ALLOWED", trainingUse: "YES", admissionReceipt: receipt,
  capacityPoolId: poolId, capacityPoolScope: "PER_USER_POOL", capacityScope: "SOURCE_IP", capacityIdentity: "dogfood-user",
  dataPolicyProfile: "PUBLIC_CODE_ONLY", lifecycle: "APPROVED", explicitZeroPrice: true, paidFallbackDisabled: true,
  managedMultiUserAllowed: true, privacyClass: "permissive", roles: ["PRIMARY_CODING_AGENT", "PLANNER", "REVIEWER", "SUBAGENT", "FAST_REASONER"],
  qualityScore: 70, healthy: true, enabled: true,
  windows: [{ unit: "requests", limit: 1, remaining: 1, resetAt: startedAt, scope: "SOURCE_IP", observedAt: startedAt, authoritative: false, period: "UNKNOWN" }],
};
const health = createEightBitRouteHealthAuthority();
const eventStore = new EventStore();
const fabric = createFreeFabric({
  managedRoutes: () => [],
  userSources: [{ routesForUser: (userId) => userId === "dogfood-user" ? [route] : [], poolsForUser: () => [] }],
  health, reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
});
const sessionId = "kilo-direct-dogfood";
const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog,
  workspacePath, userId: "dogfood-user", routeHealth: health, freeFabric: fabric,
  fabricContext: () => ({ userId: "dogfood-user", userIdentities: ["dogfood-user"], dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }),
});
await fs.writeFile(path.join(workspacePath, "README.md"), "# Public synthetic fixture\n\nAdd a tiny TypeScript function.\n");
await runtime.init();
const turnId = await runtime.startTurn("In this public synthetic workspace, create add.ts exporting function add(a: number, b: number): number that returns their sum. Then verify it with a command if available. Report what you changed.");
let state;
for (let i = 0; i < 180; i++) {
  state = runtime.getTurn(turnId);
  if (state?.status === "completed" || state?.status === "failed") break;
  if (state?.status === "waiting_for_approval") {
    for (const item of await persistence.getWorkItems(sessionId)) {
      if (item.kind === "approval" && item.turnId === turnId && !item.decision) await runtime.resolveApproval(item.id, "allow_once");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const files = await fs.readdir(workspacePath);
const outcome = eventStore.getAll().findLast((event) => event.type === "run.outcome")?.payload;
const output = { startedAt, finishedAt: new Date().toISOString(), status: state?.status ?? "TIMEOUT", workspacePath, files,
  addTs: files.includes("add.ts") ? await fs.readFile(path.join(workspacePath, "add.ts"), "utf8") : null,
  turnId, route: { providerId: state?.providerId, modelId: state?.modelId, capacityPoolId: state?.capacityPoolId }, outcome };
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
await persistence.close();
if (state?.status !== "completed") process.exitCode = 1;
