import { writeFile, readFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter, createAiHordeCommunityAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy, reverifyHordePolicy } from '@codeforge/model-registry';
import { runRoleAwareQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const directory = 'docs/evidence/r67-everyday-completion-reliability';
const provider = process.argv[2] ?? 'kilo-free-direct';
const label = process.argv[3] ?? 'before';
const startedAt = new Date().toISOString();
const adapter = provider === 'kilo-free-direct' ? createKiloFreeDirectAdapter() : createAiHordeCommunityAdapter();
const frames = [];
const output = { startedAt, providerId: adapter.providerId, status: 'RUNNING', frames };
const persist = () => writeFile(`${directory}/R67-${provider === 'kilo-free-direct' ? 'KILO' : 'HORDE'}-ROLE-QUALITY-${label}.json`, `${JSON.stringify(output, null, 2)}\n`);
try {
  output.policy = await (provider === 'kilo-free-direct' ? reverifyKiloPolicy(startedAt) : reverifyHordePolicy(startedAt));
  if (output.policy.status !== 'VERIFIED') throw new Error('CURRENT_FREE_POLICY_REQUIRED');
  const models = await adapter.listModels();
  output.catalog = models.map(({ modelId, isFree, freeStatus, contextWindow }) => ({ modelId, isFree, freeStatus, contextWindow }));
  const prior = provider === 'kilo-free-direct' ? undefined : JSON.parse(await readFile('docs/evidence/free-capacity-fabric/R65-HORDE-QUALIFICATION-google_gemma-4-31b.json', 'utf8'));
  const model = models.find((entry) => entry.isFree && entry.freeStatus === 'verified_free' && entry.modelId === (process.argv[4] ?? (provider === 'kilo-free-direct' ? 'kilo-auto/free' : prior.modelId)));
  if (!model) throw new Error('CURRENT_QUALIFIED_MODEL_ABSENT_REQUIRES_NEW_QUALIFICATION');
  output.modelId = model.modelId;
  const traced = {
    providerId: adapter.providerId, isTestProvider: false,
    streamChat: async function* (request, signal) {
      const frame = { at: new Date().toISOString(), rolePrompt: request.messages[0]?.content, maxTokens: request.maxTokens, messages: structuredClone(request.messages), events: [] };
      frames.push(frame);
      await persist();
      try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
      finally { frame.finishedAt = new Date().toISOString(); await persist(); }
    },
  };
  const base = createGenericFreeRecord({ providerId: adapter.providerId, modelId: model.modelId, displayName: model.displayName });
  const record = { ...base, accessClass: 'FREE_ROUTED', freeStatus: 'verified_free', capabilities: model.capabilities, contextWindow: model.contextWindow };
  output.qualification = await runRoleAwareQualification(record, traced, { signal: AbortSignal.timeout(900_000) });
  output.status = output.qualification.metadata?.transient ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
  output.policyRelaxed = false;
  output.sourceContent = 'Only frozen public qualification fixtures; no user source';
  output.costState = 'UNKNOWN';
} catch (error) { output.status = 'BLOCKED'; output.error = String(error); }
output.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: output.status, roles: Object.fromEntries(Object.entries(output.qualification?.roleResults ?? {}).map(([role, result]) => [role, result.status])), requests: frames.length, error: output.error }));
if (output.status === 'BLOCKED') process.exitCode = 1;
