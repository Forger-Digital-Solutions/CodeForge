import { mkdir, writeFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter, InMemoryProviderCatalog } from '@codeforge/providers';
import { ForgeZero } from '@codeforge/forge-zero';
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy } from '@codeforge/model-registry';
import { createEightBitRouteHealthAuthority } from '@codeforge/eight-bit';

const directory = 'docs/evidence/r71-packaged-free-supply-expansion';
const health = createEightBitRouteHealthAuthority();
const service = new FreeCloudService({ firewall: new ForgeZero(), providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), routeHealth: health });
service.setConnection({ providerId: 'kilo-free-direct', connected: true, credentialSource: 'ANONYMOUS_DIRECT', authState: 'ok', ownerUserId: 'r71-public-fixture' });
const observations = [];
const adapter = createKiloFreeDirectAdapter({ timeoutMs: 45000, onResponse: observation => { observations.push(observation); service.onProviderResponse(observation); } });
const report = { startedAt: new Date().toISOString(), kind: 'LIVE_TRANSPORT_AND_PRODUCTION_HEALTH_NOT_CODING_COMPLETION', calls: [], observations };
await mkdir(directory, { recursive: true });
const tag = report.startedAt.replace(/[:.]/g, '-');
const persist = () => writeFile(`${directory}/live-failover-${tag}.json`, JSON.stringify(report, null, 2) + '\n');
try {
  report.policy = await reverifyKiloPolicy(report.startedAt);
  if (report.policy.status !== 'VERIFIED') throw new Error('CURRENT_FREE_POLICY_REQUIRED');
  const models = await adapter.listModels();
  for (const model of ['kilo-auto/free', 'cohere/north-mini-code:free']) {
    if (!models.some(candidate => candidate.modelId === model && candidate.isFree)) continue;
    const call = { modelId: model, startedAt: new Date().toISOString() };
    report.calls.push(call);
    try {
      const response = await adapter.chat({ model, messages: [{ role: 'user', content: 'Public synthetic fixture. What is 2 + 3? Respond with the number only.' }], maxTokens: 128 });
      const content = response.choices[0]?.message.content;
      Object.assign(call, { status: content?.trim() === '5' ? 'ANSWER_VERIFIED' : 'NO_VERIFIED_ANSWER', content, usage: response.usage });
    } catch (error) {
      Object.assign(call, { status: 'FAILURE', code: error.code, httpStatus: error.status, rateLimitScope: error.rateLimitScope, retryAfterMs: error.retryAfterMs });
    }
    call.finishedAt = new Date().toISOString();
    report.health = health.snapshot();
    await persist();
    // An account/IP limit applies to every sibling; a direct follow-up would waste quota.
    if (call.httpStatus === 429 && call.rateLimitScope !== 'model') break;
  }
  report.status = 'RECORDED';
} catch (error) { report.status = 'BLOCKED'; report.error = error.message; }
report.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: report.status, calls: report.calls }));
