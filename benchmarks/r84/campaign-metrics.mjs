export function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

export function summarizeCampaign(campaign) {
  const frames = campaign.inferenceFrames ?? [];
  const rows = campaign.tasks.map((task, index) => {
    const requests = frames.slice(task.inferenceFramesStart, campaign.tasks[index + 1]?.inferenceFramesStart ?? frames.length);
    const usage = requests.map(frame => frame.response?.usage ?? frame.events?.filter(event => event.type === 'usage').at(-1)?.usage);
    const measured = field => usage.every(value => typeof value?.[field] === 'number') ? usage.reduce((sum, value) => sum + value[field], 0) : null;
    return {
      id: task.id, status: task.status, wallTimeMs: task.wallTimeMs,
      completed: task.status === 'completed' && task.result?.completion?.outcome === 'completed' && task.result?.review?.passed === true && task.testsAfter?.exitCode === 0,
      physicalRequests: requests.length, missingUsageRequests: usage.filter(value => !value).length,
      inputTokens: measured('inputTokens'), outputTokens: measured('outputTokens'), cachedInputTokens: measured('cachedInputTokens'), providerReportedCostUsd: measured('costUsd'),
      toolCalls: requests.reduce((sum, frame) => sum + (frame.events?.filter(event => event.type === 'tool_call_completed').length ?? frame.response?.choices?.reduce((count, choice) => count + (choice.message?.toolCalls?.length ?? 0), 0) ?? 0), 0),
      retries: Number.isInteger(task.result?.counters?.taskAttempts) && task.result.counters.taskAttempts > 0 ? task.result.counters.taskAttempts - 1 : null,
      verificationRetries: Number.isInteger(task.result?.counters?.verificationAttempts) && task.result.counters.verificationAttempts > 0 ? task.result.counters.verificationAttempts - 1 : null,
      reviewRepairRounds: task.result?.counters?.reviewRounds ?? null,
      providerErrors: requests.filter(frame => frame.error || frame.events?.some(event => event.type === 'error')).map(frame => frame.error?.code ?? frame.events.find(event => event.type === 'error')?.code ?? 'UNKNOWN'),
      capacityExhaustions: requests.filter(frame => frame.error?.status === 429 || frame.error?.code === 'RATE_LIMITED' || frame.events?.some(event => event.type === 'error' && event.code === 'RATE_LIMITED')).length,
      reviewAccepted: task.result?.review?.passed ?? null,
      identities: [...new Set((task.turns ?? []).map(turn => `${turn.servedProviderId}/${turn.servedModelId}::${turn.quotaDomainId ?? 'UNKNOWN'}`))],
    };
  });
  const distribution = values => ({ samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) });
  const completed = rows.filter(row => row.completed);
  const tokens = rows.filter(row => row.inputTokens !== null && row.outputTokens !== null);
  const costs = rows.filter(row => row.providerReportedCostUsd !== null);
  return {
    evidenceClass: 'OBSERVED_INTERNAL_PUBLIC_ENGINEERING_FIXTURES_NOT_PROJECT_CAPACITY_GUARANTEE',
    quantileMethod: 'nearest rank; tiny sample, no population inference',
    retryDefinition: 'Durable parent taskAttempts minus one; provider-level retries are not inferred from model turns.',
    attempted: rows.length, completed: completed.length, completionRate: rows.length ? completed.length / rows.length : null,
    physicalRequests: frames.length, toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
    inputTokens: tokens.length === rows.length ? tokens.reduce((sum, row) => sum + row.inputTokens, 0) : null,
    outputTokens: tokens.length === rows.length ? tokens.reduce((sum, row) => sum + row.outputTokens, 0) : null,
    tokensPerAttempt: distribution(tokens.map(row => row.inputTokens + row.outputTokens)),
    tokensPerCompletion: distribution(completed.filter(row => row.inputTokens !== null && row.outputTokens !== null).map(row => row.inputTokens + row.outputTokens)),
    completionTimeMs: distribution(completed.map(row => row.wallTimeMs)),
    retryCounts: distribution(rows.filter(row => row.retries !== null).map(row => row.retries)),
    retryTelemetryUnavailableTasks: rows.filter(row => row.retries === null).length,
    providerReportedCostUsd: costs.length === rows.length ? costs.reduce((sum, row) => sum + row.providerReportedCostUsd, 0) : null,
    costPerAttemptUsd: costs.length === rows.length && rows.length ? costs.reduce((sum, row) => sum + row.providerReportedCostUsd, 0) / rows.length : null,
    costPerCompletedProjectUsd: null,
    costPerCompletedProjectReason: 'Engineering fixtures are not complete modest projects.',
    reviewerAcceptanceRate: rows.length ? rows.filter(row => row.reviewAccepted === true).length / rows.length : null,
    rows,
  };
}
