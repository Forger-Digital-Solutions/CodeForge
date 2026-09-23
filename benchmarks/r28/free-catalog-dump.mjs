// Dump current verified-free OpenRouter models with context windows for R28 route selection.
import { PROVIDER_DEFINITIONS } from "../../packages/model-registry/dist/provider-definitions.js";
import { EnvironmentCredentialStore, createProviderAdapterFromDefinition } from "../../packages/providers/dist/index.js";

const definition = PROVIDER_DEFINITIONS["openrouter"];
const credentialStore = new EnvironmentCredentialStore();
const inner = createProviderAdapterFromDefinition(definition, { credentialStore, timeoutMs: 30_000 });
const models = await inner.listModels();
const free = models.filter((m) => m.isFree && m.freeStatus === "verified_free");
console.log(`verified_free: ${free.length}`);
for (const m of free) {
  console.log(`${m.modelId} | ctx=${m.contextWindow} | tools=${m.capabilities?.toolCalling ?? "?"} | struct=${m.capabilities?.structuredOutput ?? "?"}`);
}
