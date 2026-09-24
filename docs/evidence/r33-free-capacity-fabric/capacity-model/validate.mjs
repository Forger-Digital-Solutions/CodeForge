import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(readFileSync(join(base, 'results.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8'));

assert.equal(result.schema, 'r33-capacity-model-1');
assert.equal(result.source.receiptCount, 7);
assert.equal(new Set(result.observations.map(o => o.runId)).size, 7);
assert.equal(result.profiles.length, 6);
assert.equal(result.scenarios.length, result.profiles.length * config.concurrencyLevels.length * config.activeDutyCycles.length);
assert.equal(result.certifiedSupply.domainCount, 0);
assert(result.scenarios.every(s => s.certifiedSupply.status === 'NOT_CERTIFIED'));
assert(result.observations.some(o => o.tokenUsageUnknownRequests > 0));

for (const profile of result.profiles) {
  for (const dutyCycle of config.activeDutyCycles) {
    const scenarios = result.scenarios.filter(s => s.profile === profile.id && s.dutyCycle === dutyCycle);
    assert.deepEqual(scenarios.map(s => s.activeUsers), config.concurrencyLevels);
    for (let i = 1; i < scenarios.length; i++) {
      assert(scenarios[i].requestsPerMinute > scenarios[i - 1].requestsPerMinute);
      assert(scenarios[i].tokensPerDay > scenarios[i - 1].tokensPerDay);
      assert(scenarios[i].requiredParallelGenerationsAtAssumedLatency >= scenarios[i - 1].requiredParallelGenerationsAtAssumedLatency);
    }
    for (const s of scenarios) {
      assert(s.illustrativeMonthlyGpuUsd.every(cost => cost.monthlyUsd >= 0));
      assert(s.illustrativeMonthlyApiUsd.every(cost => cost.usd >= 0));
      assert(s.estimatedGpusByOutputRate.every(fleet => Number.isInteger(fleet.gpus)));
    }
  }
}

assert(result.economics.illustrativeCreditRunway.every(x => x.status === 'UNSECURED_SENSITIVITY_ONLY'));
console.log('R33 capacity model validation passed');
