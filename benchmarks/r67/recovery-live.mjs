import { writeFile } from 'node:fs/promises';
import { createKiloFreeDirectAdapter, createAiHordeCommunityAdapter } from '@codeforge/providers';
import { reverifyKiloPolicy, reverifyHordePolicy } from '@codeforge/model-registry';

const output = { startedAt: new Date().toISOString(), status: 'RUNNING', evidenceClass: 'LIVE_ANONYMOUS_FREE_BOUNDED_TRANSPORT_RECOVERY', observations: [], rounds: [], limitations: ['Transport recovery does not establish recovery of every role or a completed task. No failures are manufactured.'] };
const persist = () => writeFile('docs/evidence/r67-everyday-completion-reliability/R67-PROVIDER-RECOVERY-LIVE.json', `${JSON.stringify(output, null, 2)}\n`);
const onResponse = (observation) => output.observations.push({ at: new Date(observation.observedAt).toISOString(), providerId: observation.providerId, modelId: observation.modelId, status: observation.status, capacityHeaders: observation.headers.filter(([name]) => /^(x-capacity-|x-ratelimit-|retry-after$)/i.test(name)) });
for (let round = 0; round < 4; round++) {
  for (const [adapter, policyFn, target] of [[createKiloFreeDirectAdapter({ onResponse }), reverifyKiloPolicy, 'kilo-auto/free'], [createAiHordeCommunityAdapter({ onResponse }), reverifyHordePolicy, 'google/gemma-4-31b']]) {
    const row = { round, providerId: adapter.providerId, modelId: target, at: new Date().toISOString() };
    output.rounds.push(row);
    const started = Date.now();
    try {
      const policy = await policyFn(row.at);
      if (policy.status !== 'VERIFIED') throw new Error('FREE_POLICY_UNVERIFIED');
      const models = await adapter.listModels();
      if (!models.some((model) => model.modelId === target && model.isFree && model.freeStatus === 'verified_free')) throw new Error('VERIFIED_FREE_MODEL_ABSENT');
      row.events = [];
      for await (const event of adapter.streamChat({ model: target, messages: [{ role: 'user', content: 'Reply exactly OK.' }], maxTokens: 16, temperature: 0 }, AbortSignal.timeout(45000))) row.events.push(event);
      row.status = row.events.some((event) => event.type === 'error') ? 'PROVIDER_ERROR' : row.events.some((event) => event.type === 'text_delta') ? 'RESPONSE_OBSERVED' : 'NO_TEXT';
    } catch (error) { row.status = 'PROVIDER_ERROR'; row.error = String(error).slice(0, 500); }
    row.wallTimeMs = Date.now() - started;
    await persist();
    console.log(JSON.stringify({ round, providerId: row.providerId, status: row.status, wallTimeMs: row.wallTimeMs }));
  }
  if (round < 3) await new Promise((resolve) => setTimeout(resolve, 300000));
}
output.status = 'MEASURED';
output.finishedAt = new Date().toISOString();
await persist();
