import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, '../../../..');
const r32Dir = join(root, 'docs/evidence/r32-autonomy-perfection/10-live-acceptance');
const config = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8'));
const source = readFileSync(join(r32Dir, 'summary.json'));
const summary = JSON.parse(source);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw Error('Cannot compute a median from no observations');
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const requiredNumber = (value, path) => {
  if (!Number.isFinite(value) || value < 0) throw Error(`${path} must be a nonnegative number`);
  return value;
};

if (summary.schema !== 'r32-live-task-summary-1') throw Error('Unexpected R32 receipt schema');
const observations = summary.entries.map(entry => {
  const raw = readFileSync(join(r32Dir, entry.receipt));
  const receipt = JSON.parse(raw);
  if (receipt.runId !== entry.runId || receipt.task?.taskClass !== entry.taskClass) {
    throw Error(`Receipt and index disagree: ${entry.receipt}`);
  }
  const provider = receipt.provider;
  const requests = provider.requests ?? [];
  const knownRequests = requests.filter(r => Number.isFinite(r.inputTokens) && Number.isFinite(r.outputTokens));
  const input = knownRequests.reduce((n, r) => n + r.inputTokens, 0);
  const output = knownRequests.reduce((n, r) => n + r.outputTokens, 0);
  if (input !== entry.inputTokens || output !== entry.outputTokens) {
    throw Error(`Provider request token sum and R32 summary disagree: ${entry.receipt}`);
  }
  return {
    runId: entry.runId,
    taskClass: entry.taskClass,
    status: entry.workflowStatus,
    requests: requiredNumber(entry.modelRequests, 'modelRequests'),
    inputTokensObserved: input,
    outputTokensObserved: output,
    tokenUsageUnknownRequests: entry.tokenUsageUnknownRequests,
    durationSeconds: entry.wallClockMs / 1000,
    toolCalls: entry.toolCalls,
    observedGenerationSeconds: round(requests.filter(r => r.outcome === 'completed').reduce((n, r) => n + r.elapsedMs, 0) / 1000),
    source: `docs/evidence/r32-autonomy-perfection/10-live-acceptance/${entry.receipt}`,
    sha256: sha256(raw)
  };
});

const measuredProfiles = Object.entries(config.measuredProfileMap).map(([id, taskClasses]) => {
  const rows = observations.filter(o => taskClasses.includes(o.taskClass));
  if (!rows.length) throw Error(`No receipts for ${id}`);
  return {
    id,
    basis: 'R32 live receipt median; observed tokens are lower bounds when usage is unknown',
    sampleSize: rows.length,
    sourceRunIds: rows.map(r => r.runId),
    unknownTokenUsageRequests: rows.reduce((n, r) => n + r.tokenUsageUnknownRequests, 0),
    requests: median(rows.map(r => r.requests)),
    inputTokens: median(rows.map(r => r.inputTokensObserved)),
    outputTokens: median(rows.map(r => r.outputTokensObserved)),
    durationSeconds: median(rows.map(r => r.durationSeconds)),
    toolCalls: median(rows.map(r => r.toolCalls)),
    observedGenerationSeconds: median(rows.map(r => r.observedGenerationSeconds))
  };
});
const profileById = Object.fromEntries(measuredProfiles.map(p => [p.id, p]));
const assumedProfiles = config.assumedProfiles.map(spec => {
  if (!spec.multiplyMeasuredProfile) return { ...spec, sampleSize: 0 };
  const measured = profileById[spec.multiplyMeasuredProfile];
  if (!measured || !Number.isFinite(spec.factor) || spec.factor <= 0) throw Error(`Invalid assumption ${spec.id}`);
  return Object.fromEntries([
    ['id', spec.id], ['basis', spec.basis], ['sampleSize', 0],
    ...['requests', 'inputTokens', 'outputTokens', 'durationSeconds', 'toolCalls', 'observedGenerationSeconds']
      .map(key => [key, round(measured[key] * spec.factor)])
  ]);
});
const profiles = [...measuredProfiles, ...assumedProfiles];
for (const p of profiles) {
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'durationSeconds', 'toolCalls']) requiredNumber(p[key], `${p.id}.${key}`);
  if (!p.durationSeconds) throw Error(`Zero duration in ${p.id}`);
}

const domainIds = new Set();
for (const d of config.certifiedQuotaDomains) {
  if (domainIds.has(d.id)) throw Error(`Duplicate quota domain ${d.id}`);
  domainIds.add(d.id);
  if (d.verifiedUsable !== true || d.commercialUseApproved !== true || !d.evidence) {
    throw Error(`Uncertified quota domain ${d.id} in certified list`);
  }
  for (const key of ['requestsPerMinute', 'requestsPerDay', 'tokensPerMinute', 'tokensPerDay', 'maxConcurrency']) {
    requiredNumber(d[key], `${d.id}.${key}`);
  }
}
const certifiedSupply = {
  domainCount: config.certifiedQuotaDomains.length,
  requestsPerMinute: config.certifiedQuotaDomains.reduce((n, d) => n + d.requestsPerMinute, 0),
  requestsPerDay: config.certifiedQuotaDomains.reduce((n, d) => n + d.requestsPerDay, 0),
  tokensPerMinute: config.certifiedQuotaDomains.reduce((n, d) => n + d.tokensPerMinute, 0),
  tokensPerDay: config.certifiedQuotaDomains.reduce((n, d) => n + d.tokensPerDay, 0),
  maxConcurrency: config.certifiedQuotaDomains.reduce((n, d) => n + d.maxConcurrency, 0)
};

const scenarios = profiles.flatMap(profile => config.concurrencyLevels.flatMap(activeUsers => config.activeDutyCycles.map(dutyCycle => {
  const taskStartsPerSecond = activeUsers * dutyCycle / profile.durationSeconds;
  const requestsPerSecond = taskStartsPerSecond * profile.requests;
  const inputTokensPerSecond = taskStartsPerSecond * profile.inputTokens;
  const outputTokensPerSecond = taskStartsPerSecond * profile.outputTokens;
  const tokensPerSecond = inputTokensPerSecond + outputTokensPerSecond;
  const requestsPerMinute = requestsPerSecond * 60;
  const tokensPerMinute = tokensPerSecond * 60;
  const requestsPerDay = requestsPerSecond * 86400;
  const tokensPerDay = tokensPerSecond * 86400;
  const parallelGenerations = Math.ceil(requestsPerSecond * config.requestLatencySeconds);
  const generationLowerBound = profile.observedGenerationSeconds
    ? Math.ceil(taskStartsPerSecond * profile.observedGenerationSeconds) : null;
  const model = {
    profile: profile.id,
    activeUsers,
    dutyCycle,
    taskStartsPerSecond: round(taskStartsPerSecond, 6),
    requestsPerSecond: round(requestsPerSecond, 6),
    requestsPerMinute: round(requestsPerMinute, 3),
    requestsPerDay: round(requestsPerDay),
    inputTokensPerSecond: round(inputTokensPerSecond, 3),
    outputTokensPerSecond: round(outputTokensPerSecond, 3),
    tokensPerMinute: round(tokensPerMinute),
    tokensPerHour: round(tokensPerSecond * 3600),
    tokensPerDay: round(tokensPerDay),
    requiredParallelGenerationsAtAssumedLatency: parallelGenerations,
    observedParallelGenerationLowerBound: generationLowerBound,
    estimatedGpusByOutputRate: config.gpuOutputTokensPerSecond.map(rate => ({
      outputTokensPerSecondPerGpu: rate,
      gpus: Math.ceil(outputTokensPerSecond / (rate * config.gpuUtilization))
    })),
    illustrativeMonthlyApiUsd: config.illustrativeApiPricesUsdPerMillion.map(price => ({
      priceScenario: price.label,
      usd: round((inputTokensPerSecond * price.input + outputTokensPerSecond * price.output) * config.monthlyHours * 3600 / 1e6, 2)
    })),
    certifiedSupply: certifiedSupply.domainCount ? {
      status: 'PARTIAL_NUMERIC_COMPARISON_ONLY',
      uncoveredRequestsPerMinute: round(Math.max(0, requestsPerMinute - certifiedSupply.requestsPerMinute)),
      uncoveredTokensPerMinute: round(Math.max(0, tokensPerMinute - certifiedSupply.tokensPerMinute)),
      uncoveredParallelGenerations: Math.max(0, parallelGenerations - certifiedSupply.maxConcurrency),
      uncoveredRequestsPerDay: round(Math.max(0, requestsPerDay - certifiedSupply.requestsPerDay)),
      uncoveredTokensPerDay: round(Math.max(0, tokensPerDay - certifiedSupply.tokensPerDay))
    } : { status: 'NOT_CERTIFIED', reason: 'No verified commercially permitted quota domains with complete limits supplied' }
  };
  model.illustrativeMonthlyGpuUsd = model.estimatedGpusByOutputRate.flatMap(fleet =>
    config.gpuHourlyUsd.map(hourlyUsd => ({
      outputTokensPerSecondPerGpu: fleet.outputTokensPerSecondPerGpu,
      hourlyUsd,
      monthlyUsd: round(fleet.gpus * hourlyUsd * config.monthlyHours, 2)
    })));
  return model;
})));

const normal = profileById.normal_coding;
const economics = {
  disclaimer: 'All prices, GPU rates, credit amounts, active:MAU ratio, and conversion margins below are illustrative inputs, not provider quotes, secured credits, or revenue.',
  normalCodingTokensPerTask: { input: normal.inputTokens, output: normal.outputTokens },
  illustrativeCreditRunway: config.illustrativeUnsecuredCreditUsd.flatMap(creditUsd => config.illustrativeApiPricesUsdPerMillion.map(price => {
    const dollarsPerTask = (normal.inputTokens * price.input + normal.outputTokens * price.output) / 1e6;
    return {
      status: 'UNSECURED_SENSITIVITY_ONLY', creditUsd, priceScenario: price.label,
      estimatedTokensPerUsdAtObservedMix: round((normal.inputTokens + normal.outputTokens) / dollarsPerTask),
      estimatedNormalCodingTasks: Math.floor(creditUsd / dollarsPerTask),
      runwayDaysAtOneTaskPerDau: [100, 1000, 10000, 100000, 1000000].map(dau => ({ dau, days: round(creditUsd / dollarsPerTask / dau, 3) }))
    };
  })),
  illustrativePaidConversion: scenarios.filter(s => s.profile === 'normal_coding' && s.dutyCycle === 1).flatMap(s =>
    s.illustrativeMonthlyApiUsd.flatMap(cost => config.paidContributionUsdPerMonth.map(margin => ({
      activeUsers: s.activeUsers,
      assumedMau: s.activeUsers * config.activeToMonthlyUserRatio,
      priceScenario: cost.priceScenario,
      paidContributionUsdPerMonth: margin,
      requiredPaidConversionPercent: round(100 * cost.usd / (s.activeUsers * config.activeToMonthlyUserRatio * margin), 2)
    }))))
};

const output = {
  schema: 'r33-capacity-model-1',
  source: { r32Summary: 'docs/evidence/r32-autonomy-perfection/10-live-acceptance/summary.json', sha256: sha256(source), receiptCount: observations.length },
  limitations: [
    `R32 observations are seven task attempts over ${new Set(summary.entries.map(entry => entry.taskId)).size} distinct source tasks, all OpenRouter; zero autonomous acceptance passes.`,
    'Measured token counts are lower bounds when a request omitted usage; no imputation is performed.',
    'Observed wall times include tool and waiting time, and are not a validated production arrival distribution.',
    'Measured task class proxies and multiplied profiles are not population estimates.',
    'Parallel generation, GPU throughput and hourly cost, API price, duty cycle, and credit calculations are sensitivities, not measured provider capacity or quotes.',
    'Zero certified domains means no capacity has been certified in this model, not that actual provider supply is zero.'
  ],
  config,
  observations,
  profiles,
  certifiedSupply,
  scenarios,
  economics
};

const json = JSON.stringify(output, null, 2) + '\n';
writeFileSync(join(base, 'results.json'), json);
const lines = [
  '# R33 executable capacity and economics model', '',
  `Source: R32 summary SHA-256 \`${output.source.sha256}\`; ${observations.length} receipts.`, '',
  'Run: `node docs/evidence/r33-free-capacity-fabric/capacity-model/run.mjs`.', '',
  '## Evidence and limits', '',
  ...output.limitations.map(x => `- ${x}`), '',
  'Input parameters are in `config.json`; all outputs are in `results.json`. The default scenario is 100% continuously active users. The 25% and 5% duty cycles are sensitivity checks, not alternative meanings of simultaneous active users.', '',
  '## Workload profiles', '',
  '| Profile | Basis | Samples | Requests/task | Input tokens/task | Output tokens/task | Duration (s) | Unknown-usage requests |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...profiles.map(p => `| ${p.id} | ${p.sampleSize ? 'R32 receipt median' : 'assumption'} | ${p.sampleSize} | ${round(p.requests)} | ${round(p.inputTokens)} | ${round(p.outputTokens)} | ${round(p.durationSeconds)} | ${p.unknownTokenUsageRequests ?? 'N/A'} |`), '',
  '## Normal coding at continuous concurrency', '',
  '| Active users | Requests/min | Input tokens/s | Output tokens/s | Tokens/day | Parallel generations (12 s assumption) | GPUs at 300 output tok/s, 70% use | Monthly API cost, middle illustration | Certified supply |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...scenarios.filter(s => s.profile === 'normal_coding' && s.dutyCycle === 1).map(s => `| ${s.activeUsers.toLocaleString('en-US')} | ${s.requestsPerMinute.toLocaleString('en-US')} | ${s.inputTokensPerSecond.toLocaleString('en-US')} | ${s.outputTokensPerSecond.toLocaleString('en-US')} | ${s.tokensPerDay.toLocaleString('en-US')} | ${s.requiredParallelGenerationsAtAssumedLatency.toLocaleString('en-US')} | ${s.estimatedGpusByOutputRate[1].gpus.toLocaleString('en-US')} | $${s.illustrativeMonthlyApiUsd[1].usd.toLocaleString('en-US')} | ${s.certifiedSupply.status} |`), '',
  '## Reading the figures', '',
  'The model computes steady-state task starts as active users × duty cycle ÷ observed task duration. It then multiplies by requests and tokens per observed task. It assumes 24-hour continuous arrival for daily demand and 730 hours for monthly cost. Required parallel generations use Little’s law with a configurable 12-second request occupancy. GPU counts are output-throughput lower bounds and omit prefill, memory, context, scheduler, redundancy, and network constraints. They are not deployable fleet sizing.', '',
  'The certified-supply list is empty pending live organization quota evidence and commercial multi-user permission. Consequently the model cannot honestly answer how many simultaneous users CodeForge can serve today. It can quantify demand; the inventory and live probe must quantify supply.', '',
  'The price examples, $1,000/$50,000/$350,000 credit amounts, GPU rates and paid conversion margins are unverified sensitivity inputs. No credits or paid revenue are claimed. Credit runway assumes one normal coding task per DAU and the observed R32 token mix; results are not a promise of autonomy or task success.', ''
];
writeFileSync(join(base, 'REPORT.md'), lines.join('\n'));
console.log(`Wrote ${join(base, 'results.json')} and REPORT.md`);
