import { writeFile, mkdir } from 'node:fs/promises';
import { createKiloFreeDirectAdapter, createBlockRunFreeAdapter, createAiHordeCommunityAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy, reverifyBlockRunPolicy, reverifyHordePolicy } from '@codeforge/model-registry';

const directory = 'docs/evidence/r76-free-supply-recovery-and-reliability';
await mkdir(directory, { recursive: true });
const startedAt = new Date().toISOString();
const observations = [];
const fetcher = async (target, init) => {
  const response = await fetch(target, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  const body = await response.clone().text();
  const file = `supply-http-${observations.length}.txt`;
  observations.push({ url: String(target), method: init?.method ?? 'GET', httpStatus: response.status, file });
  await writeFile(`${directory}/${file}`, body);
  return response;
};
const providers = [
  { id: 'kilo-free-direct', policy: reverifyKiloPolicy, create: createKiloFreeDirectAdapter },
  { id: 'blockrun-free-direct', policy: reverifyBlockRunPolicy, create: createBlockRunFreeAdapter },
  { id: 'ai-horde', policy: reverifyHordePolicy, create: createAiHordeCommunityAdapter },
];
const supply = [];
for (const provider of providers) {
  const policy = await provider.policy(startedAt, { fetcher });
  const adapter = provider.create({ fetchFn: fetcher });
  const row = { providerId: provider.id, policy, inferenceRequests: 0 };
  try { row.models = await adapter.listModels(); } catch (error) { row.catalogError = { code: error.code ?? error.cause?.code, message: String(error) }; }
  supply.push(row);
}
const receipt = { startedAt, finishedAt: new Date().toISOString(), evidenceClass: 'CURRENT_OFFICIAL_POLICY_AND_CATALOG_NO_INFERENCE', supply, observations };
await writeFile(`${directory}/supply.json`, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ supply: supply.map(row => ({ providerId: row.providerId, policy: row.policy.status, models: row.models?.map(model => ({ modelId: model.modelId, contextWindow: model.contextWindow, capabilities: model.capabilities })), catalogError: row.catalogError })) }));
