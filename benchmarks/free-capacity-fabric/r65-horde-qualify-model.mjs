import fs from "node:fs/promises";
import path from "node:path";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createAiHordeCommunityAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";
import { createEightBitRouteHealthAuthority, runRoleAwareQualification } from "@codeforge/eight-bit";

/** Standalone live qualification for one AI Horde community model — anonymous, paced by the
 * suite itself. Usage: node r65-horde-qualify-model.mjs <modelId> */
const modelId = process.argv[2];
if (!modelId) { console.error("usage: r65-horde-qualify-model.mjs <modelId>"); process.exit(2); }
const evidenceDir = path.resolve("docs/evidence/free-capacity-fabric");
const startedAt = new Date().toISOString();
const providerId = "ai-horde";
const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const providerCatalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
let freeCloud;
const adapter = createAiHordeCommunityAdapter({ onResponse: (obs) => freeCloud?.onProviderResponse(obs) });
providerCatalog.register(adapter);
let listed;
for (let attempt = 1; attempt <= 4; attempt++) {
  try { listed = await adapter.listModels(); break; }
  catch (e) {
    process.stdout.write(`listModels attempt ${attempt} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
    if (attempt === 4) throw e;
    await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
  }
}
const entry = listed.find((model) => model.modelId === modelId && model.isFree && model.freeStatus === "verified_free");
if (!entry) throw new Error(`model ${modelId} not in the live verified-free community catalog`);
const base = createGenericFreeRecord({ providerId, modelId, displayName: `AI Horde ${modelId}` });
firewall.register({ ...base, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...base.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...base.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
freeCloud = new FreeCloudService({ firewall, providerCatalog, registry: new NormalizedModelRegistry(), routeHealth: health });
freeCloud.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "COMMUNITY_ANONYMOUS_FREE", authState: "ok" });
process.stdout.write(`qualifying ${modelId} on the anonymous community pool\n`);
const qualification = await runRoleAwareQualification(firewall.getModel(providerId, modelId), adapter, { signal: AbortSignal.timeout(900_000) });
const safeName = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
await fs.writeFile(path.join(evidenceDir, `R65-HORDE-QUALIFICATION-${safeName}.json`), JSON.stringify({ ...qualification, qualifiedAt: startedAt }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ qualification: qualification.qualificationState, roles: Object.fromEntries(Object.entries(qualification.roleResults).map(([role, result]) => [role, result.status])) }) + "\n");
if (qualification.qualificationState === "HARD_FAILURE") process.exitCode = 1;
