import { z } from "zod";

/**
 * R23 efficiency-proof run record (protocol §6.4, §8).
 *
 * One record per (task, arm, repetition) run. Every quantity that can be UNKNOWN carries a source
 * label instead of a silent zero: token totals come from provider-reported usage only, costs from
 * a frozen pricing snapshot, local resources from the harness process. Summaries are recomputed
 * from these records — a summary number that cannot be traced to a field here does not exist.
 */

export const R23_RUN_RECORD_SCHEMA_VERSION = "r23-run-record-1" as const;
export const R23_BENCHMARK_VERSION = "CodeForge-EfficiencyBench-R23" as const;
export const R23_PROTOCOL_ID = "codeforge-efficiency-protocol-r23" as const;

export const MetricSourceSchema = z.enum(["OBSERVED", "DERIVED", "ESTIMATED", "UNKNOWN"]);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

export const MetricOriginSchema = z.enum(["PROVIDER", "RUNTIME", "HARNESS", "VERIFIER", "SNAPSHOT"]);
export type MetricOrigin = z.infer<typeof MetricOriginSchema>;

/** A number that knows where it came from. `value` is absent exactly when `source === "UNKNOWN"`. */
export const MeasuredNumberSchema = z
  .object({
    value: z.number().finite().optional(),
    source: MetricSourceSchema,
    origin: MetricOriginSchema.optional(),
    note: z.string().max(240).optional(),
  })
  .refine((m) => (m.source === "UNKNOWN") === (m.value === undefined), {
    message: "value must be present iff source is not UNKNOWN",
  });
export type MeasuredNumber = z.infer<typeof MeasuredNumberSchema>;

export function measured(value: number, origin: MetricOrigin, note?: string): MeasuredNumber {
  return { value, source: "OBSERVED", origin, ...(note ? { note } : {}) };
}
export function derived(value: number, origin: MetricOrigin = "HARNESS", note?: string): MeasuredNumber {
  return { value, source: "DERIVED", origin, ...(note ? { note } : {}) };
}
export function estimated(value: number, origin: MetricOrigin = "HARNESS", note?: string): MeasuredNumber {
  return { value, source: "ESTIMATED", origin, ...(note ? { note } : {}) };
}
export function unknownMetric(note?: string): MeasuredNumber {
  return { source: "UNKNOWN", ...(note ? { note } : {}) };
}

export const ArmIdSchema = z.enum(["control", "optimized"]);
export type ArmId = z.infer<typeof ArmIdSchema>;

/** Terminal classification (protocol §7). Exactly one per run. */
export const RunClassificationSchema = z.enum([
  "verified_complete",
  "false_complete",
  "verification_failed",
  "budget_exhausted",
  "provider_failure",
  "tool_failure",
  "security_blocked",
  "timeout",
  "harness_error",
  "infrastructure_void",
]);
export type RunClassification = z.infer<typeof RunClassificationSchema>;

export const UsageSourceSchema = z.enum(["PROVIDER_REPORTED", "UNKNOWN"]);

/** One model call as observed at the provider boundary by the recording adapter. */
export const ModelCallRecordSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  /** Provider id and the model id CodeForge requested. */
  providerId: z.string(),
  requestedModelId: z.string(),
  /** Model id the provider reported serving (when the response carries one). */
  servedModelId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** Wall time from request start to stream end (ms). */
  latencyMs: z.number().nonnegative(),
  /** Request start → first stream event (ms); absent when the call produced no event. */
  timeToFirstEventMs: z.number().nonnegative().optional(),
  /** Serialized request body size the harness handed to the adapter (messages + tools), bytes. */
  requestBytes: z.number().int().nonnegative(),
  /** Bytes of text/tool-call payload received on the stream. */
  responseBytes: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  messageCountByRole: z.record(z.number().int().nonnegative()),
  toolDefinitionCount: z.number().int().nonnegative(),
  usageSource: UsageSourceSchema,
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedPromptTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Provider-reported charge for this call (USD). Absent = not reported. */
  providerReportedCostUsd: z.number().nonnegative().optional(),
  finishReason: z.enum(["stop", "tool_calls", "length", "content_filter", "error"]).optional(),
  toolCallsEmitted: z.number().int().nonnegative(),
  outcome: z.enum(["ok", "error", "aborted"]),
  errorCode: z.string().optional(),
  /** Provider/transport failure text — secret-redacted, truncated (§13 taxonomy evidence). */
  errorMessage: z.string().max(400).optional(),
  httpStatus: z.number().int().optional(),
  retryable: z.boolean().optional(),
  rateLimited: z.boolean(),
  /** Provider-advised wait attached to a 429 (ms after the call ended), when supplied. */
  retryAfterMs: z.number().nonnegative().optional(),
  /** sha256 over the ordered message content hashes — identifies the exact conversation prefix. */
  conversationDigest: z.string(),
});
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;

/** Composition of one call's prompt by message category (bytes). */
export const ContextCompositionSchema = z.object({
  systemBytes: z.number().int().nonnegative(),
  userTaskBytes: z.number().int().nonnegative(),
  assistantBytes: z.number().int().nonnegative(),
  toolResultBytes: z.number().int().nonnegative(),
  toolResultBytesByTool: z.record(z.number().int().nonnegative()),
  otherBytes: z.number().int().nonnegative(),
});
export type ContextComposition = z.infer<typeof ContextCompositionSchema>;

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(R23_RUN_RECORD_SCHEMA_VERSION),
  identity: z.object({
    benchmarkVersion: z.literal(R23_BENCHMARK_VERSION),
    protocolId: z.literal(R23_PROTOCOL_ID),
    protocolVersion: z.string(),
    protocolDigest: z.string().length(64),
    harnessVersion: z.string(),
    campaignId: z.string(),
    phase: z.enum(["dry_run", "qualification", "pilot", "main", "variance", "ablation", "replication", "public_benchmark", "chaos", "fixture"]),
    runId: z.string(),
    pairId: z.string(),
    taskId: z.string(),
    taskClass: z.string(),
    taskLanguage: z.string(),
    repoSizeClass: z.enum(["small", "medium", "large"]),
    arm: ArmIdSchema,
    armConfigurationDigest: z.string(),
    pairOrder: z.enum(["control-first", "optimized-first"]),
    repetition: z.number().int().positive(),
    codeforgeCommit: z.string(),
    codeforgeTreeDirty: z.boolean(),
    dirtyFiles: z.array(z.string()).optional(),
    startingTreeHash: z.string(),
    endingTreeHash: z.string(),
    taskDigest: z.string(),
    modelId: z.string(),
    providerId: z.string(),
    routeClass: z.string(),
    forgeGreenEnabled: z.boolean(),
    subagentsEnabled: z.boolean(),
    topology: z.string(),
    environmentFingerprint: z.string(),
    startedAt: z.string(),
    endedAt: z.string(),
  }),
  outcome: z.object({
    runtimeStatus: z.enum(["completed", "blocked", "cancelled", "failed"]),
    stopReason: z.string(),
    claimedComplete: z.boolean(),
    verifierRan: z.boolean(),
    verifierPassed: z.boolean().optional(),
    verifierExitCode: z.number().int().optional(),
    verifierDurationMs: z.number().nonnegative().optional(),
    completionAuthority: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
    completionBlockers: z.array(z.string()),
    forbiddenActionObserved: z.boolean(),
    verifiedComplete: z.boolean(),
    falseComplete: z.boolean(),
    classification: RunClassificationSchema,
    completionReason: z.string(),
    testsPassed: z.number().int().nonnegative().optional(),
    testsFailed: z.number().int().nonnegative().optional(),
    filesChanged: z.array(z.string()),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    runtimeError: z.string().optional(),
  }),
  inference: z.object({
    totalInputTokens: MeasuredNumberSchema,
    totalOutputTokens: MeasuredNumberSchema,
    totalTokens: MeasuredNumberSchema,
    cachedInputTokens: MeasuredNumberSchema,
    uncachedInputTokens: MeasuredNumberSchema,
    reasoningTokens: MeasuredNumberSchema,
    modelCalls: z.number().int().nonnegative(),
    callsWithProviderUsage: z.number().int().nonnegative(),
    failedModelCalls: z.number().int().nonnegative(),
    retriedModelCalls: z.number().int().nonnegative(),
    rateLimitedCalls: z.number().int().nonnegative(),
    providerFailovers: z.number().int().nonnegative(),
    modelFailovers: z.number().int().nonnegative(),
    duplicateRequestsSuppressed: z.number().int().nonnegative(),
    calls: z.array(ModelCallRecordSchema),
  }),
  context: z.object({
    /** Σ over calls of the request bytes actually sent (what the provider had to read). */
    transmittedContextBytes: z.number().int().nonnegative(),
    /** Bytes of the final call's messages — the conversation's true size. */
    finalConversationBytes: z.number().int().nonnegative(),
    /** transmitted − final: the provider-statelessness re-send cost. NOT waste (protocol §10). */
    providerStatelessnessRepeatBytes: z.number().int().nonnegative(),
    /** Exact-hash duplicate tool results / bootstrap-then-reread bytes (protocol §10). */
    avoidableDuplicateBytes: z.number().int().nonnegative(),
    avoidableDuplicateTokens: MeasuredNumberSchema,
    avoidableDuplicateEvents: z.array(z.object({ kind: z.enum(["duplicate_tool_result", "bootstrap_then_reread"]), tool: z.string(), argumentsDigest: z.string(), bytes: z.number().int().nonnegative(), firstCallIndex: z.number().int(), repeatCallIndex: z.number().int(), firstRole: z.string().optional(), repeatRole: z.string().optional(), crossRole: z.boolean().optional() })),
    /** §10 duplicates split by whether the repeat came from a different agent role (topology handoff cost) or the same role. */
    avoidableDuplicateBytesWithinRole: z.number().int().nonnegative().optional(),
    avoidableDuplicateBytesCrossRole: z.number().int().nonnegative().optional(),
    /** Composition of the final conversation (bytes by category). */
    finalComposition: ContextCompositionSchema,
    bootstrapContextBytes: z.number().int().nonnegative(),
    bootstrapSelectedFiles: z.number().int().nonnegative(),
    bootstrapCandidateFiles: z.number().int().nonnegative(),
    contextPagesReused: z.number().int().nonnegative().optional(),
    contextPagesPulled: z.number().int().nonnegative().optional(),
    canonicalCacheHits: z.number().int().nonnegative(),
    canonicalCacheMisses: z.number().int().nonnegative(),
    toolOutputBytesAvoidedByCompression: z.number().int().nonnegative(),
    /** Provider prompt-cache: number of calls where the provider reported cached tokens > 0. */
    providerCacheHitCalls: z.number().int().nonnegative(),
    /** Provider prompt-token/byte ratio used to convert bytes → DERIVED tokens for this run. */
    promptTokensPerByte: z.number().nonnegative().optional(),
  }),
  activity: z.object({
    role: z.string(),
    toolCallsRequested: z.number().int().nonnegative(),
    toolCallsExecuted: z.number().int().nonnegative(),
    toolCallsFailed: z.number().int().nonnegative(),
    duplicateActionsSuppressed: z.number().int().nonnegative(),
    byTool: z.record(z.object({ requested: z.number().int(), executed: z.number().int(), suppressed: z.number().int() })),
    fileReads: z.number().int().nonnegative(),
    fileWrites: z.number().int().nonnegative(),
    searches: z.number().int().nonnegative(),
    listings: z.number().int().nonnegative(),
    shellCalls: z.number().int().nonnegative(),
    browserCalls: z.number().int().nonnegative(),
    mcpCalls: z.number().int().nonnegative(),
    pluginCalls: z.number().int().nonnegative(),
    subagentCount: z.number().int().nonnegative(),
    subagentModelCalls: z.number().int().nonnegative(),
  }),
  time: z.object({
    wallClockMs: z.number().nonnegative(),
    /** wall − rate-limit waits − verification. */
    activeAgentMs: z.number().nonnegative(),
    modelWaitMs: z.number().nonnegative(),
    toolMs: MeasuredNumberSchema,
    verificationMs: z.number().nonnegative(),
    rateLimitWaitMs: z.number().nonnegative(),
    /** Time spent in the shared provider capacity governor's proactive pacing (RPM/TPM/concurrency) before calls were sent. */
    pacingWaitMs: z.number().nonnegative().optional(),
    forgeGreenOverheadMs: MeasuredNumberSchema,
  }),
  economics: z.object({
    pricingSnapshotId: z.string(),
    /** Σ provider-reported call costs (USD) when every call reported one; else derived from the route's listed unit price; UNKNOWN otherwise. */
    actualCostUsd: MeasuredNumberSchema,
    /** Same tokens at the frozen snapshot's price for the same model's paid listing (or its declared proxy). */
    equivalentPublicApiCostUsd: MeasuredNumberSchema,
    equivalentPublicApiPriceRef: z.string(),
    /** Same tokens at the snapshot's reference frontier-model price — a reference, never a saving. */
    equivalentMarketCostUsd: MeasuredNumberSchema,
    equivalentMarketPriceRef: z.string(),
  }),
  resources: z.object({
    cpuUserMs: MeasuredNumberSchema,
    cpuSystemMs: MeasuredNumberSchema,
    peakRssBytes: MeasuredNumberSchema,
    providerResponseBytes: MeasuredNumberSchema,
    providerRequestBytes: MeasuredNumberSchema,
    gpuPowerDrawWattsIdleSample: MeasuredNumberSchema,
    sampler: z.string(),
  }),
  telemetry: z.object({
    forgeGreenR0TelemetryId: z.string().optional(),
    efficiencyReasonCodes: z.array(z.string()),
  }),
  notes: z.array(z.string()),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function validateRunRecord(record: unknown): RunRecord {
  return RunRecordSchema.parse(record);
}

/**
 * Invariants a record must satisfy beyond its shape (protocol §16 pilot gate). Returned as a list
 * of violations so the harness can refuse to write an inconsistent record.
 */
export function runRecordInvariantViolations(record: RunRecord): string[] {
  const violations: string[] = [];
  const calls = record.inference.calls;
  if (calls.length !== record.inference.modelCalls) violations.push(`modelCalls (${record.inference.modelCalls}) != calls.length (${calls.length})`);
  const reported = calls.filter((c) => c.usageSource === "PROVIDER_REPORTED");
  if (reported.length !== record.inference.callsWithProviderUsage) violations.push("callsWithProviderUsage does not match the ledger");
  const sum = (pick: (c: ModelCallRecord) => number | undefined): number | undefined => {
    let total = 0;
    for (const c of reported) {
      const v = pick(c);
      if (v === undefined) return undefined;
      total += v;
    }
    return total;
  };
  const expectInput = sum((c) => c.promptTokens);
  const expectOutput = sum((c) => c.completionTokens);
  const anyUnknown = reported.length !== calls.length || calls.length === 0;
  if (anyUnknown) {
    if (record.inference.totalInputTokens.source !== "UNKNOWN") violations.push("totalInputTokens must be UNKNOWN when any call lacks provider usage");
    if (record.inference.totalTokens.source !== "UNKNOWN") violations.push("totalTokens must be UNKNOWN when any call lacks provider usage");
  } else {
    if (record.inference.totalInputTokens.value !== expectInput) violations.push(`totalInputTokens (${record.inference.totalInputTokens.value}) != Σ calls.promptTokens (${expectInput})`);
    if (record.inference.totalOutputTokens.value !== expectOutput) violations.push(`totalOutputTokens (${record.inference.totalOutputTokens.value}) != Σ calls.completionTokens (${expectOutput})`);
    if (record.inference.totalTokens.value !== (expectInput ?? 0) + (expectOutput ?? 0)) violations.push("totalTokens != input + output");
  }
  const failed = calls.filter((c) => c.outcome === "error").length;
  if (failed !== record.inference.failedModelCalls) violations.push(`failedModelCalls (${record.inference.failedModelCalls}) != ledger errors (${failed})`);
  const rateLimited = calls.filter((c) => c.rateLimited).length;
  if (rateLimited !== record.inference.rateLimitedCalls) violations.push(`rateLimitedCalls (${record.inference.rateLimitedCalls}) != ledger (${rateLimited})`);
  if (record.outcome.verifiedComplete && !record.outcome.claimedComplete) violations.push("verifiedComplete requires claimedComplete");
  if (record.outcome.verifiedComplete && record.outcome.completionAuthority !== "PASS") violations.push("verifiedComplete requires completionAuthority PASS");
  if (record.outcome.verifiedComplete && record.outcome.verifierPassed !== true) violations.push("verifiedComplete requires verifierPassed");
  if (record.outcome.falseComplete !== (record.outcome.claimedComplete && !record.outcome.verifiedComplete)) violations.push("falseComplete must equal claimedComplete && !verifiedComplete");
  if (record.outcome.verifiedComplete && record.outcome.classification !== "verified_complete") violations.push("classification must be verified_complete when verifiedComplete");
  if (record.outcome.falseComplete && record.outcome.classification !== "false_complete") violations.push("classification must be false_complete when falseComplete");
  const transmitted = calls.reduce((s, c) => s + c.requestBytes, 0);
  if (transmitted !== record.context.transmittedContextBytes) violations.push("transmittedContextBytes != Σ calls.requestBytes");
  if (record.context.providerStatelessnessRepeatBytes !== Math.max(0, record.context.transmittedContextBytes - record.context.finalConversationBytes)) violations.push("providerStatelessnessRepeatBytes != transmitted − final");
  if (record.identity.arm === "control" && record.identity.forgeGreenEnabled) violations.push("control arm must have forgeGreenEnabled=false");
  if (record.identity.arm === "optimized" && !record.identity.forgeGreenEnabled) violations.push("optimized arm must have forgeGreenEnabled=true");
  return violations;
}
