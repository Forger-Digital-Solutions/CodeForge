import type {
  ContextComparisonPopulation,
  NormalizedIdentity,
  NormalizedMeasurementInput,
} from "./sustainability-types.js";
import { MEASUREMENT_NORMALIZATION_SCHEMA_VERSION } from "./sustainability-types.js";

/**
 * FG-8 realistic-workload fixtures (spec §16). Deterministic, hand-built, synthetic — NO network
 * calls and NO live model dispatch are used to manufacture this data, per the phase's zero-cash
 * requirement. Each fixture is a plausible shape for its named workload, not a captured trace.
 */
export interface SustainabilityWorkloadFixture {
  workloadId: string;
  description: string;
  identity: NormalizedIdentity;
  normalized: NormalizedMeasurementInput;
  contextPopulation?: ContextComparisonPopulation;
}

function identity(runId: string): NormalizedIdentity {
  return {
    runId,
    sessionId: `fixture-session-${runId}`,
    agentId: "fixture-agent",
    taskId: `fixture-task-${runId}`,
    namespace: "fixture-workspace",
    executionRevision: "rev-1",
  };
}

function baseNormalized(id: NormalizedIdentity, overrides: Partial<NormalizedMeasurementInput> = {}): NormalizedMeasurementInput {
  return {
    normalizationVersion: MEASUREMENT_NORMALIZATION_SCHEMA_VERSION,
    identity: id,
    tokens: {
      inputTokens: undefined,
      outputTokens: undefined,
      cachedInputTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: undefined,
      requestCount: undefined,
      provider: undefined,
      model: undefined,
      coverage: "unavailable",
    },
    tools: {
      toolCallCount: undefined,
      toolFailureCount: undefined,
      readOnlyToolCallCount: undefined,
      mutatingToolCallCount: undefined,
      duplicateActionsSuppressed: undefined,
      noProgressInterruptions: undefined,
      toolWallClockMs: undefined,
      coverage: "unavailable",
    },
    verification: {
      obligationsGenerated: undefined,
      targetedSuitesUsed: undefined,
      fullSuitesAvoided: undefined,
      fullSuitesRequired: undefined,
      evidenceReused: undefined,
      rerunsAvoided: undefined,
      staleEvidenceRejected: undefined,
      blockedEvents: undefined,
      coverage: "unavailable",
    },
    routing: {
      modelFailoverRotations: undefined,
      modelFailoverBlockedDispatches: undefined,
      fallbackEvents: undefined,
      routeReceiptId: undefined,
      financialReceiptId: undefined,
      coverage: "unavailable",
    },
    context: {
      contextPagesReused: undefined,
      contextPagesPulled: undefined,
      tokensAvoidedMeasured: undefined,
      bytesAvoidedMeasured: undefined,
      coverage: "unavailable",
    },
    timing: { wallClockMs: undefined, coverage: "unavailable" },
    sourceLedgerId: `fixture-ledger-${id.runId}`,
    sourceLedgerPolicyVersion: "fixture-1",
    ...overrides,
  };
}

export function buildSustainabilityWorkloadFixtures(): SustainabilityWorkloadFixture[] {
  return [
    {
      workloadId: "small_bug_fix",
      description: "Single-file bug fix: one targeted read, one edit, one targeted test run.",
      identity: identity("small-bug-fix"),
      normalized: baseNormalized(identity("small-bug-fix"), {
        tokens: { inputTokens: 1800, outputTokens: 600, cachedInputTokens: 400, cacheWriteTokens: undefined, reasoningTokens: undefined, totalTokens: 2400, requestCount: 2, provider: "openrouter", model: "fixture/small-model", coverage: "provider_reported" },
        tools: { toolCallCount: 3, toolFailureCount: 0, readOnlyToolCallCount: 1, mutatingToolCallCount: 2, duplicateActionsSuppressed: 0, noProgressInterruptions: 0, toolWallClockMs: 850, coverage: "directly_measured" },
        verification: { obligationsGenerated: 1, targetedSuitesUsed: 1, fullSuitesAvoided: 1, fullSuitesRequired: 0, evidenceReused: 0, rerunsAvoided: 0, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-small-bug-fix", financialReceiptId: "fin-small-bug-fix", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 1, contextPagesPulled: 1, tokensAvoidedMeasured: 900, bytesAvoidedMeasured: 3600, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 4200, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "repository_search",
      description: "Read-only repository search: many cached/reused structural lookups, no writes.",
      identity: identity("repository-search"),
      normalized: baseNormalized(identity("repository-search"), {
        tokens: { inputTokens: 2600, outputTokens: 900, cachedInputTokens: 1200, cacheWriteTokens: undefined, reasoningTokens: undefined, totalTokens: 3500, requestCount: 3, provider: "openrouter", model: "fixture/small-model", coverage: "provider_reported" },
        tools: { toolCallCount: 8, toolFailureCount: 0, readOnlyToolCallCount: 8, mutatingToolCallCount: 0, duplicateActionsSuppressed: 2, noProgressInterruptions: 0, toolWallClockMs: 1900, coverage: "directly_measured" },
        verification: { obligationsGenerated: 0, targetedSuitesUsed: 0, fullSuitesAvoided: 0, fullSuitesRequired: 0, evidenceReused: 0, rerunsAvoided: 0, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-repo-search", financialReceiptId: "fin-repo-search", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 11, contextPagesPulled: 3, tokensAvoidedMeasured: 5200, bytesAvoidedMeasured: 20800, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 6100, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "multi_file_edit",
      description: "Coordinated edit across several files with dependency-aware context pulls.",
      identity: identity("multi-file-edit"),
      normalized: baseNormalized(identity("multi-file-edit"), {
        tokens: { inputTokens: 9800, outputTokens: 3400, cachedInputTokens: 2200, cacheWriteTokens: 1400, reasoningTokens: undefined, totalTokens: 13200, requestCount: 6, provider: "openrouter", model: "fixture/mid-model", coverage: "provider_reported" },
        tools: { toolCallCount: 14, toolFailureCount: 1, readOnlyToolCallCount: 6, mutatingToolCallCount: 8, duplicateActionsSuppressed: 1, noProgressInterruptions: 0, toolWallClockMs: 5200, coverage: "directly_measured" },
        verification: { obligationsGenerated: 3, targetedSuitesUsed: 2, fullSuitesAvoided: 1, fullSuitesRequired: 0, evidenceReused: 1, rerunsAvoided: 1, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-multi-file", financialReceiptId: "fin-multi-file", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 4, contextPagesPulled: 9, tokensAvoidedMeasured: 2100, bytesAvoidedMeasured: 8400, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 18400, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "tool_heavy_task",
      description: "Many small bounded tool calls dominate over model tokens.",
      identity: identity("tool-heavy-task"),
      normalized: baseNormalized(identity("tool-heavy-task"), {
        tokens: { inputTokens: 4100, outputTokens: 1500, cachedInputTokens: 900, cacheWriteTokens: undefined, reasoningTokens: undefined, totalTokens: 5600, requestCount: 4, provider: "openrouter", model: "fixture/small-model", coverage: "provider_reported" },
        tools: { toolCallCount: 27, toolFailureCount: 2, readOnlyToolCallCount: 20, mutatingToolCallCount: 7, duplicateActionsSuppressed: 4, noProgressInterruptions: 1, toolWallClockMs: 9100, coverage: "directly_measured" },
        verification: { obligationsGenerated: 1, targetedSuitesUsed: 1, fullSuitesAvoided: 0, fullSuitesRequired: 0, evidenceReused: 0, rerunsAvoided: 0, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-tool-heavy", financialReceiptId: "fin-tool-heavy", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 6, contextPagesPulled: 5, tokensAvoidedMeasured: 1800, bytesAvoidedMeasured: 7200, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 15200, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "verification_heavy_task",
      description: "Systemic-risk change requiring a full-system verification suite.",
      identity: identity("verification-heavy-task"),
      normalized: baseNormalized(identity("verification-heavy-task"), {
        tokens: { inputTokens: 6200, outputTokens: 2100, cachedInputTokens: 1100, cacheWriteTokens: undefined, reasoningTokens: undefined, totalTokens: 8300, requestCount: 5, provider: "openrouter", model: "fixture/mid-model", coverage: "provider_reported" },
        tools: { toolCallCount: 9, toolFailureCount: 0, readOnlyToolCallCount: 4, mutatingToolCallCount: 5, duplicateActionsSuppressed: 0, noProgressInterruptions: 0, toolWallClockMs: 3300, coverage: "directly_measured" },
        verification: { obligationsGenerated: 6, targetedSuitesUsed: 2, fullSuitesAvoided: 0, fullSuitesRequired: 1, evidenceReused: 0, rerunsAvoided: 0, staleEvidenceRejected: 1, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-verify-heavy", financialReceiptId: "fin-verify-heavy", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 2, contextPagesPulled: 4, tokensAvoidedMeasured: 700, bytesAvoidedMeasured: 2800, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 41500, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "provider_failure_fallback_task",
      description: "Primary free model becomes unhealthy mid-run; 8-Bit rotates to a backup.",
      identity: identity("provider-failure-fallback-task"),
      normalized: baseNormalized(identity("provider-failure-fallback-task"), {
        tokens: { inputTokens: 5400, outputTokens: 1900, cachedInputTokens: 600, cacheWriteTokens: undefined, reasoningTokens: undefined, totalTokens: 7300, requestCount: 5, provider: "openrouter", model: "fixture/backup-model", coverage: "provider_reported" },
        tools: { toolCallCount: 6, toolFailureCount: 0, readOnlyToolCallCount: 3, mutatingToolCallCount: 3, duplicateActionsSuppressed: 0, noProgressInterruptions: 0, toolWallClockMs: 2400, coverage: "directly_measured" },
        verification: { obligationsGenerated: 1, targetedSuitesUsed: 1, fullSuitesAvoided: 1, fullSuitesRequired: 0, evidenceReused: 0, rerunsAvoided: 0, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 2, modelFailoverBlockedDispatches: 1, fallbackEvents: 2, routeReceiptId: "route-provider-failure", financialReceiptId: "fin-provider-failure", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 3, contextPagesPulled: 2, tokensAvoidedMeasured: 500, bytesAvoidedMeasured: 2000, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 12800, coverage: "directly_measured" },
      }),
    },
    {
      workloadId: "context_heavy_repository_task",
      description: "Large repository task where progressive context delivery matters most.",
      identity: identity("context-heavy-repository-task"),
      normalized: baseNormalized(identity("context-heavy-repository-task"), {
        tokens: { inputTokens: 12400, outputTokens: 3800, cachedInputTokens: 5200, cacheWriteTokens: 2600, reasoningTokens: undefined, totalTokens: 16200, requestCount: 7, provider: "openrouter", model: "fixture/mid-model", coverage: "provider_reported" },
        tools: { toolCallCount: 11, toolFailureCount: 0, readOnlyToolCallCount: 9, mutatingToolCallCount: 2, duplicateActionsSuppressed: 3, noProgressInterruptions: 0, toolWallClockMs: 4600, coverage: "directly_measured" },
        verification: { obligationsGenerated: 2, targetedSuitesUsed: 2, fullSuitesAvoided: 1, fullSuitesRequired: 0, evidenceReused: 1, rerunsAvoided: 1, staleEvidenceRejected: 0, blockedEvents: 0, coverage: "derived_from_authoritative_telemetry" },
        routing: { modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, fallbackEvents: 0, routeReceiptId: "route-context-heavy", financialReceiptId: "fin-context-heavy", coverage: "derived_from_authoritative_telemetry" },
        context: { contextPagesReused: 22, contextPagesPulled: 14, tokensAvoidedMeasured: 18200, bytesAvoidedMeasured: 72800, coverage: "derived_from_authoritative_telemetry" },
        timing: { wallClockMs: 26700, coverage: "directly_measured" },
      }),
      contextPopulation: {
        fullContextDefinition: "All repo-intelligence-indexed files at the workspace's current content generation, excluding binary/generated/gitignored paths.",
        eligibleFileCount: 340,
        excludedFileCount: 58,
        exclusionReasons: { binary: 12, generated: 21, gitignored: 25 },
        eligibleBytes: 2_400_000,
        eligibleTokensEstimate: 620_000,
        actualTransmittedBytes: 291_200,
        actualTransmittedTokens: 72_800,
        naivePolicyBytes: 2_400_000,
        naivePolicyTokens: 620_000,
      },
    },
  ];
}
