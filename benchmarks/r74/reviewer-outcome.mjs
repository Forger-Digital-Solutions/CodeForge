export function classifyReviewerOutcome(result, frames) {
  const upstreamFailure = frames.some(frame => frame.error !== undefined || frame.events.some(event => event.type === "error"));
  if (upstreamFailure) return "INCONCLUSIVE_PROVIDER_FAILURE";
  const tests = Object.values(result?.roleResults ?? {}).flatMap(role => role?.testCases ?? []);
  if (tests.some(test => /R41_BOUND/.test(test.error ?? ""))) return "INCONCLUSIVE_LOCAL_REQUEST_BOUND";
  if (result?.transientCases) return "INCONCLUSIVE_TRANSIENT";
  return "MEASURED";
}
