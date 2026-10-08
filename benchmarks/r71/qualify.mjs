import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createKiloFreeDirectAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy } from '@codeforge/model-registry';
import { runRoleAwareQualification } from '@codeforge/eight-bit';
import { createGenericFreeRecord } from '@codeforge/forge-zero';

const provider = 'kilo-free-direct';
const modelId = process.argv[2] ?? 'cohere/north-mini-code:free';
const runTag = new Date().toISOString().replace(/[:.]/g, '-');
const destination = `docs/evidence/r71-packaged-free-supply-expansion/${provider}-${String(modelId).replace(/[^\w.-]/g, '_')}-${runTag}-qualification.json`;
await mkdir(path.dirname(destination), { recursive: true });
const output = { startedAt: new Date().toISOString(), provider, modelId, kind: 'DEVELOPMENT_QUALIFICATION_NOT_PRODUCT_COMPLETION', frames: [] };
const persist = () => writeFile(destination, JSON.stringify(output, null, 2) + '\n');
const adapter = createKiloFreeDirectAdapter();
try {
  output.policy = await reverifyKiloPolicy(output.startedAt);
  if (output.policy.status !== 'VERIFIED') throw new Error('CURRENT_FREE_POLICY_REQUIRED');
  const models = await adapter.listModels();
  const model = models.find(item => item.modelId === modelId && item.isFree && item.freeStatus === 'verified_free');
  if (!model) throw new Error('LIVE_CATALOG_MODEL_ABSENT');
  const record = { ...createGenericFreeRecord({ providerId: adapter.providerId, modelId, displayName: model.displayName }), accessClass: 'FREE_ROUTED', capabilities: model.capabilities, contextWindow: model.contextWindow };
  const traced = { providerId: adapter.providerId, isTestProvider: false, async *streamChat(request, signal) {
    const frame = { at: new Date().toISOString(), events: [] };
    output.frames.push(frame);
    await persist();
    try { for await (const event of adapter.streamChat(request, signal)) { frame.events.push(event); yield event; } }
    catch (error) { frame.failure = { code: error.code, httpStatus: error.status, rateLimitScope: error.rateLimitScope, retryAfterMs: error.retryAfterMs }; throw error; }
    finally { frame.finishedAt = new Date().toISOString(); await persist(); }
  } };
  output.qualification = await runRoleAwareQualification(record, traced, { signal: AbortSignal.timeout(300000) });
  output.status = output.qualification.metadata?.transient ? 'INCONCLUSIVE_PROVIDER_FAILURE' : 'MEASURED';
} catch (error) { output.status = 'BLOCKED'; output.error = error.message; }
output.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ destination, status: output.status, error: output.error, requests: output.frames.length, roles: Object.fromEntries(Object.entries(output.qualification?.roleResults ?? {}).map(([role, result]) => [role, result.status])) }));
