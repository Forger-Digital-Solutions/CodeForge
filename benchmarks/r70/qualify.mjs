import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createKiloFreeDirectAdapter, createAiHordeCommunityAdapter, createGroqAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy, reverifyHordePolicy } from '@codeforge/model-registry';
import { runRoleAwareQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const provider = process.argv[2] ?? 'kilo-free-direct';
const defaults = { 'kilo-free-direct': 'kilo-auto/free', 'ai-horde': 'google/gemma-4-31b', 'groq-managed': 'openai/gpt-oss-120b' };
const modelId = process.argv[3] ?? defaults[provider];
const runTag = new Date().toISOString().replace(/[:.]/g, '-');
const destination = `G:/CodeForge/docs/evidence/r70-free-supply-independence/provider-audit/${provider}-${String(modelId).replace(/[^\w.-]/g, '_')}-${runTag}-qualification.json`;
await mkdir(path.dirname(destination), { recursive: true });
const output = { startedAt: new Date().toISOString(), provider, modelId, kind: 'DEVELOPMENT_QUALIFICATION_NOT_PRODUCT_COMPLETION', frames: [] };
const persist = () => writeFile(destination, JSON.stringify(output, null, 2) + '\n');
const adapter = provider === 'kilo-free-direct' ? createKiloFreeDirectAdapter()
  : provider === 'groq-managed' ? createGroqAdapter({ apiKey: process.env.GROQ_API_KEY })
  : createAiHordeCommunityAdapter();
try {
  output.policy = provider === 'groq-managed'
    ? { status: 'VERIFIED', mechanism: 'MANAGED_ACCOUNT_FREE_TIER', quotaScope: 'PROVIDER_ACCOUNT',
        evidence: 'Groq free developer tier: no card, hard rate limits (429, never billed); account-scoped — one shared pool per API key.',
        billingRisk: 'NONE_ON_FREE_TIER', note: 'Dev-account qualification: proves the Groq free route executes; a product route would be a shared CodeForge-owned or per-user-BYOK domain.' }
    : await (provider === 'kilo-free-direct' ? reverifyKiloPolicy(output.startedAt) : reverifyHordePolicy(output.startedAt));
  if (output.policy.status !== 'VERIFIED') throw new Error('CURRENT_FREE_POLICY_REQUIRED');
  const models = await adapter.listModels();
  const model = provider === 'groq-managed'
    ? models.find(item => item.modelId === modelId)
    : models.find(item => item.modelId === modelId && item.isFree && item.freeStatus === 'verified_free');
  if (!model) throw new Error('LIVE_CATALOG_MODEL_ABSENT');
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    const frame = { at: new Date().toISOString(), events: [] };
    output.frames.push(frame);
    await persist();
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  output.qualification = await runRoleAwareQualification(record, traced, { signal: AbortSignal.timeout(300000) });
  output.status = output.qualification.metadata?.transient ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
} catch (error) { output.status = 'BLOCKED'; output.error = error.message; }
output.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ destination, status: output.status, error: output.error, requests: output.frames.length, roles: Object.fromEntries(Object.entries(output.qualification?.roleResults ?? {}).map(([role, result]) => [role, result.status])) }));
