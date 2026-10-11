import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCampaign } from './campaign-metrics.mjs';

test('physical dispatches count once; cumulative usage is not double counted', () => {
  const report = summarizeCampaign({ tasks: [{ id: 'a', inferenceFramesStart: 0, status: 'completed', wallTimeMs: 10, result: { completion: { outcome: 'completed' }, review: { passed: true } }, testsAfter: { exitCode: 0 } }], inferenceFrames: [{ events: [{ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }, { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, costUsd: 0 } }] }] });
  assert.equal(report.physicalRequests, 1);
  assert.equal(report.inputTokens, 4);
  assert.equal(report.outputTokens, 6);
  assert.equal(report.providerReportedCostUsd, 0);
  assert.equal(report.completed, 1);
  assert.equal(report.costPerCompletedProjectUsd, null);
});

test('missing usage, retries and completion evidence remain unknown or incomplete', () => {
  const report = summarizeCampaign({ tasks: [{ id: 'a', inferenceFramesStart: 0, status: 'completed', wallTimeMs: 10, result: { review: { passed: true } }, testsAfter: { exitCode: 0 } }], inferenceFrames: [{ events: [] }] });
  assert.equal(report.completed, 0);
  assert.equal(report.inputTokens, null);
  assert.equal(report.outputTokens, null);
  assert.equal(report.providerReportedCostUsd, null);
  assert.equal(report.retryTelemetryUnavailableTasks, 1);
});
