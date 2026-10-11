import { writeFile } from "node:fs/promises";
import { PROVIDER_DEFINITIONS, termsForModel, reverifyKiloPolicy, reverifyBlockRunPolicy, reverifyHordePolicy } from "@codeforge/model-registry";
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter, createAiHordeCommunityAdapter } from "@codeforge/providers";

const directory = "docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review";
const output = `${directory}/capacity-audit-${Date.now()}.json`;
const receipt = { startedAt: new Date().toISOString(), inferenceRequests: 0, credentialsRead: false, providers: [], publicCatalogs: [] };
receipt.providers = Object.values(PROVIDER_DEFINITIONS).map((definition) => ({
  providerId: definition.id, implemented: definition.implemented, authClasses: definition.authClasses,
  freeAccess: definition.freeAccess, terms: definition.terms, modelTerms: definition.modelTerms, privacy: definition.privacy,
  zeroTouchCandidate: definition.authClasses.includes("ZERO_TOUCH"),
  admissionStatus: "NOT_PROVEN_BY_REGISTRY_DEFINITION",
}));
for (const [adapter, verifyPolicy] of [[createKiloFreeDirectAdapter({ timeoutMs: 15000 }), reverifyKiloPolicy], [createBlockRunFreeAdapter({ timeoutMs: 15000 }), reverifyBlockRunPolicy], [createAiHordeCommunityAdapter({ timeoutMs: 15000 }), reverifyHordePolicy]]) {
  const source = { providerId: adapter.providerId, checkedAt: new Date().toISOString(), status: "RUNNING", models: [] };
  receipt.publicCatalogs.push(source);
  try {
    source.policy = await verifyPolicy(new Date().toISOString());
    source.models = (await adapter.listModels()).map((model) => ({ modelId: model.modelId, isFree: model.isFree, contextWindow: model.contextWindow, capabilities: model.capabilities, terms: termsForModel(PROVIDER_DEFINITIONS[adapter.providerId], model.modelId), inferenceCapacityProven: false }));
    source.status = "CATALOG_OBSERVED_NOT_INFERENCE_CAPACITY";
  } catch (error) { source.status = "BLOCKED"; source.error = String(error); }
  await writeFile(output, JSON.stringify(receipt, null, 2));
}
receipt.finishedAt = new Date().toISOString();
await writeFile(output, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt.publicCatalogs.map((source) => ({ providerId: source.providerId, status: source.status, policy: source.policy?.status, models: source.models.length, error: source.error }))));
