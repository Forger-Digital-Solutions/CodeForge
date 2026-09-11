import type { ForgeGreenLedgerRecord } from "./ledger.js";
import {
  MEASUREMENT_NORMALIZATION_SCHEMA_VERSION,
  type MetricCoverageClass,
  type NormalizedIdentity,
  type NormalizedMeasurementInput,
  type NormalizedTiming,
} from "./sustainability-types.js";

/**
 * FG-8 normalization boundary (hardening #1). These "raw" shapes are deliberately LOOSE and
 * FG-8-owned — every field optional, structurally matched rather than nominally imported from
 * `@codeforge/agent` / `@codeforge/tools` / `@codeforge/eight-bit`. This is what lets historical
 * receipts stay interpretable even as those upstream types evolve: normalization never depends on
 * a specific upstream version, and it never throws on a missing or unexpected field — absence
 * becomes `undefined` + `"unavailable"` coverage, never a fabricated `0`.
 */
export interface RawAgentUsageLike {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  provider?: unknown;
  model?: unknown;
  requestCount?: unknown;
}

export interface RawToolExecutionLike {
  success?: unknown;
  readOnly?: unknown;
  durationMs?: unknown;
}

export interface RawRouteReceiptRefLike {
  receiptId?: unknown;
  taskId?: unknown;
  selectedRoute?: { providerId?: unknown; modelId?: unknown } | null;
}

export interface RawFinancialReceiptRefLike {
  receiptId?: unknown;
  taskId?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  pricingEvidence?: { isFree?: unknown } | null;
  forgeZeroDecision?: unknown;
}

/**
 * FG-8R: the REAL live routing/financial authority. `createRouteReceipt`/`createFinancialReceipt`
 * (`packages/eight-bit/src/receipts.ts`) are unused in production (confirmed by repo-wide search —
 * called nowhere outside their own definition file). The live authority ForgeZero/8-Bit actually
 * use is a `FreeModelRecord` (`packages/forge-zero`, read via `firewall.getModel(providerId,
 * modelId)`) for the model that actually executed, optionally cross-checked against any persisted
 * `DecisionReceipt`s (`packages/eight-bit/src/types.ts`) for this run — which exist only when a
 * rotation/failover actually happened, not on every run. */
export interface RawFreeModelRecordLike {
  providerId?: unknown;
  modelId?: unknown;
  accessClass?: unknown;
  freeStatus?: unknown;
  costProfile?: { isFree?: unknown; paidFallbackPossible?: unknown; paidFallbackDisabled?: unknown; source?: unknown } | null;
}

export interface RawDecisionReceiptLike {
  receiptId?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  action?: unknown;
  reasonCodes?: unknown;
  selected?: { providerId?: unknown; modelId?: unknown } | null;
  previous?: { providerId?: unknown; modelId?: unknown } | null;
  createdAt?: unknown;
}

export interface NormalizedDecisionReceiptRef {
  receiptId: string;
  action: string | undefined;
  selectedProviderId: string | undefined;
  selectedModelId: string | undefined;
  reasonCodes: string[];
}

export interface NormalizedLiveRoutingFinancial {
  providerId: string | undefined;
  modelId: string | undefined;
  accessClass: string | undefined;
  freeStatus: string | undefined;
  isFree: boolean | undefined;
  paidFallbackPossible: boolean | undefined;
  paidFallbackDisabled: boolean | undefined;
  costSource: string | undefined;
  decisionReceipts: NormalizedDecisionReceiptRef[];
  coverage: MetricCoverageClass;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalizes the live routing/financial evidence available inside `AgentRuntime` at the point a
 * sustainability receipt is built — never thrown, absence becomes `undefined`/`"unavailable"`. */
export function normalizeLiveRoutingFinancial(params: {
  freeModelRecord?: RawFreeModelRecordLike;
  decisionReceipts?: RawDecisionReceiptLike[];
}): NormalizedLiveRoutingFinancial {
  const record = params.freeModelRecord;
  const decisions = params.decisionReceipts ?? [];
  return {
    providerId: record ? strOrUndefined(record.providerId) : undefined,
    modelId: record ? strOrUndefined(record.modelId) : undefined,
    accessClass: record ? strOrUndefined(record.accessClass) : undefined,
    freeStatus: record ? strOrUndefined(record.freeStatus) : undefined,
    isFree: record?.costProfile ? boolOrUndefined(record.costProfile.isFree) : undefined,
    paidFallbackPossible: record?.costProfile ? boolOrUndefined(record.costProfile.paidFallbackPossible) : undefined,
    paidFallbackDisabled: record?.costProfile ? boolOrUndefined(record.costProfile.paidFallbackDisabled) : undefined,
    costSource: record?.costProfile ? strOrUndefined(record.costProfile.source) : undefined,
    decisionReceipts: decisions
      .map((d): NormalizedDecisionReceiptRef | undefined => {
        const receiptId = strOrUndefined(d.receiptId);
        if (!receiptId) return undefined;
        return {
          receiptId,
          action: strOrUndefined(d.action),
          selectedProviderId: d.selected ? strOrUndefined(d.selected.providerId) : undefined,
          selectedModelId: d.selected ? strOrUndefined(d.selected.modelId) : undefined,
          reasonCodes: strArrayOrEmpty(d.reasonCodes),
        };
      })
      .filter((d): d is NormalizedDecisionReceiptRef => d !== undefined),
    coverage: record ? "derived_from_authoritative_telemetry" : "unavailable",
  };
}

export interface NormalizeMeasurementInputParams {
  identity: NormalizedIdentity;
  ledgerRecord?: ForgeGreenLedgerRecord;
  usage?: RawAgentUsageLike;
  toolExecutions?: RawToolExecutionLike[];
  wallClockMs?: unknown;
  routeReceipt?: RawRouteReceiptRefLike;
  financialReceipt?: RawFinancialReceiptRefLike;
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sumOptional(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => typeof v === "number");
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a + b, 0);
}

/** Builds the FG-8-owned normalized measurement input. Pure, defensive, never throws — this is
 * the ONLY function `createSustainabilityReceipt` reads upstream data through. */
export function normalizeMeasurementInput(params: NormalizeMeasurementInputParams): NormalizedMeasurementInput {
  const totals = params.ledgerRecord?.totals;
  const usage = params.usage;
  const tools = params.toolExecutions ?? [];
  const hasToolData = params.toolExecutions !== undefined;

  const inputTokens = usage ? numOrUndefined(usage.inputTokens) : undefined;
  const outputTokens = usage ? numOrUndefined(usage.outputTokens) : undefined;

  const timing: NormalizedTiming = {
    wallClockMs: numOrUndefined(params.wallClockMs),
    coverage: numOrUndefined(params.wallClockMs) !== undefined ? "directly_measured" : "unavailable",
  };

  return {
    normalizationVersion: MEASUREMENT_NORMALIZATION_SCHEMA_VERSION,
    identity: params.identity,
    tokens: {
      inputTokens,
      outputTokens,
      cachedInputTokens: usage ? numOrUndefined(usage.cachedTokens) : undefined,
      cacheWriteTokens: usage ? numOrUndefined(usage.cacheWriteTokens) : undefined,
      reasoningTokens: usage ? numOrUndefined(usage.reasoningTokens) : undefined,
      totalTokens: sumOptional(inputTokens, outputTokens),
      requestCount: usage ? numOrUndefined(usage.requestCount) : undefined,
      provider: usage ? strOrUndefined(usage.provider) : undefined,
      model: usage ? strOrUndefined(usage.model) : undefined,
      coverage: usage ? "provider_reported" : "unavailable",
    },
    tools: {
      toolCallCount: hasToolData ? tools.length : undefined,
      toolFailureCount: hasToolData ? tools.filter((t) => t.success === false).length : undefined,
      readOnlyToolCallCount: hasToolData ? tools.filter((t) => t.readOnly === true).length : undefined,
      mutatingToolCallCount: hasToolData ? tools.filter((t) => t.readOnly === false).length : undefined,
      duplicateActionsSuppressed: numOrUndefined(totals?.duplicateActionsSuppressed),
      noProgressInterruptions: numOrUndefined(totals?.noProgressInterruptions),
      toolWallClockMs: hasToolData
        ? tools.reduce<number | undefined>((acc, t) => {
            const d = numOrUndefined(t.durationMs);
            if (d === undefined) return acc;
            return (acc ?? 0) + d;
          }, undefined)
        : undefined,
      coverage: hasToolData ? "directly_measured" : "unavailable",
    },
    verification: {
      obligationsGenerated: numOrUndefined(totals?.verificationObligationsGenerated),
      targetedSuitesUsed: numOrUndefined(totals?.verificationTargetedSuitesUsed),
      fullSuitesAvoided: numOrUndefined(totals?.verificationFullSuitesAvoided),
      fullSuitesRequired: numOrUndefined(totals?.verificationFullSuitesRequired),
      evidenceReused: numOrUndefined(totals?.verificationEvidenceReused),
      rerunsAvoided: numOrUndefined(totals?.verificationRerunsAvoided),
      staleEvidenceRejected: numOrUndefined(totals?.verificationStaleEvidenceRejected),
      blockedEvents: numOrUndefined(totals?.verificationBlockedEvents),
      coverage: totals ? "derived_from_authoritative_telemetry" : "unavailable",
    },
    routing: {
      modelFailoverRotations: numOrUndefined(totals?.modelFailoverRotations),
      modelFailoverBlockedDispatches: numOrUndefined(totals?.modelFailoverBlockedDispatches),
      fallbackEvents: numOrUndefined(totals?.fallbackEvents),
      routeReceiptId: strOrUndefined(params.routeReceipt?.receiptId),
      financialReceiptId: strOrUndefined(params.financialReceipt?.receiptId),
      coverage: totals ? "derived_from_authoritative_telemetry" : "unavailable",
    },
    context: {
      contextPagesReused: numOrUndefined(totals?.contextPagesReused),
      contextPagesPulled: numOrUndefined(totals?.contextPagesPulled),
      tokensAvoidedMeasured: numOrUndefined(totals?.tokensAvoidedMeasured),
      bytesAvoidedMeasured: numOrUndefined(totals?.bytesAvoidedMeasured),
      coverage: totals ? "derived_from_authoritative_telemetry" : "unavailable",
    },
    timing,
    sourceLedgerId: strOrUndefined(params.ledgerRecord?.ledgerId),
    sourceLedgerPolicyVersion: strOrUndefined(params.ledgerRecord?.policyVersion),
  };
}
