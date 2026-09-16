import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import crypto from "node:crypto";

/** R0's measurement truth is deliberately separate from the older FG-8 coverage vocabulary. */
export type ForgeGreenR0MeasurementSource = "OBSERVED" | "DERIVED" | "ESTIMATED" | "UNKNOWN";
export type ForgeGreenR0MeasurementOrigin = "PROVIDER" | "RUNTIME" | "LOCAL" | "SIMULATION";

export interface ForgeGreenR0Metric<T> {
  value?: T;
  source: ForgeGreenR0MeasurementSource;
  origin?: ForgeGreenR0MeasurementOrigin;
  evidenceRef?: string;
}

export const FORGE_GREEN_R0_TELEMETRY_SCHEMA_VERSION = "forgegreen-r0-telemetry-1";
export const FORGE_GREEN_R0_POLICY_VERSION = "forgegreen-r0-measurement-1";
export const FORGE_GREEN_R0_TELEMETRY_WORK_ITEM_KIND = "forgegreen_r0_telemetry" as const;

export interface ForgeGreenR0RunIdentity {
  runId: string;
  sessionId: string;
  workspaceId: string;
  agentId?: string;
  taskId?: string;
  workflowId?: string;
  repositoryRevision?: string;
  repositoryGeneration?: number;
  policyRevision?: string;
}

export interface ForgeGreenR0RouteObservation {
  providerId: string;
  modelId: string;
  routeClass: string;
  attempts: ForgeGreenR0Metric<number>;
}

export interface ForgeGreenR0ModelAccounting {
  providerAttempts: ForgeGreenR0Metric<number>;
  modelAttempts: ForgeGreenR0Metric<number>;
  inputTokens: ForgeGreenR0Metric<number>;
  cachedInputTokens: ForgeGreenR0Metric<number>;
  outputTokens: ForgeGreenR0Metric<number>;
  totalTokens: ForgeGreenR0Metric<number>;
  effectiveUncachedInputTokens: ForgeGreenR0Metric<number>;
  stablePromptCacheHits: ForgeGreenR0Metric<number>;
  providerPromptCacheReports: ForgeGreenR0Metric<number>;
}

export interface ForgeGreenR0ToolAccounting {
  toolCalls: ForgeGreenR0Metric<number>;
  executedToolCalls: ForgeGreenR0Metric<number>;
  failedToolCalls: ForgeGreenR0Metric<number>;
  duplicateEquivalentToolCalls: ForgeGreenR0Metric<number>;
  rawToolOutputBytes: ForgeGreenR0Metric<number>;
  bytesDeliveredToModelContext: ForgeGreenR0Metric<number>;
  toolDurationMs: ForgeGreenR0Metric<number>;
  compression: {
    originalBytes: ForgeGreenR0Metric<number>;
    deliveredBytes: ForgeGreenR0Metric<number>;
    bytesAvoided: ForgeGreenR0Metric<number>;
    ratio: ForgeGreenR0Metric<number>;
  };
  byTool: Array<{
    toolName: string;
    calls: ForgeGreenR0Metric<number>;
    executed: ForgeGreenR0Metric<number>;
    suppressed: ForgeGreenR0Metric<number>;
  }>;
}

export interface ForgeGreenR0RetryAccounting {
  retryCount: ForgeGreenR0Metric<number>;
  reasons: Array<{ reason: string; count: ForgeGreenR0Metric<number> }>;
}

export interface ForgeGreenR0ProviderFailureAccounting {
  providerFailures: ForgeGreenR0Metric<number>;
  rateLimitSignals: ForgeGreenR0Metric<number>;
  failureCodes: Array<{ code: string; count: ForgeGreenR0Metric<number> }>;
}

export interface ForgeGreenR0ContextAccounting {
  initialContextBytes: ForgeGreenR0Metric<number>;
  modelContextBytes: ForgeGreenR0Metric<number>;
  stablePromptBytes: ForgeGreenR0Metric<number>;
  sourceCategories: Record<string, ForgeGreenR0Metric<number>>;
}

export interface ForgeGreenR0AuthorityObservation {
  status: "PASS" | "FAIL" | "BLOCKED" | "UNKNOWN";
  source: ForgeGreenR0MeasurementSource;
  evidenceRef?: string;
}

export interface ForgeGreenR0Telemetry {
  schemaVersion: string;
  policyVersion: string;
  telemetryId: string;
  generatedAt: string;
  identity: ForgeGreenR0RunIdentity;
  routeClass: ForgeGreenR0Metric<string>;
  routes: ForgeGreenR0RouteObservation[];
  model: ForgeGreenR0ModelAccounting;
  tools: ForgeGreenR0ToolAccounting;
  context: ForgeGreenR0ContextAccounting;
  retries: ForgeGreenR0RetryAccounting;
  providerFailures: ForgeGreenR0ProviderFailureAccounting;
  wallTimeMs: ForgeGreenR0Metric<number>;
  actualProviderCost: ForgeGreenR0Metric<number>;
  effectiveProviderCost: ForgeGreenR0Metric<number>;
  forgeVerify: ForgeGreenR0AuthorityObservation;
  completionGate: ForgeGreenR0AuthorityObservation;
  taskCompletionStatus: ForgeGreenR0Metric<string>;
  stopReason: ForgeGreenR0Metric<string>;
  forgeGreenOverheadMs: ForgeGreenR0Metric<number>;
}

export interface ForgeGreenR0ToolObservation {
  toolName: string;
  durationMs?: number;
  success?: boolean;
  rawOutputBytes?: number;
  deliveredBytes?: number;
  originalBytes?: number;
  compressedBytes?: number;
}

export interface ForgeGreenR0ModelResponseObservation {
  providerId: string;
  modelId: string;
  routeClass: string;
  usageSource: "PROVIDER_REPORTED" | "UNKNOWN";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  stablePromptCacheHit?: boolean;
}

function metric<T>(value: T, origin: ForgeGreenR0MeasurementOrigin, evidenceRef?: string): ForgeGreenR0Metric<T> {
  return { value, source: "OBSERVED", origin, ...(evidenceRef ? { evidenceRef } : {}) };
}

function unknown<T>(): ForgeGreenR0Metric<T> {
  return { source: "UNKNOWN" };
}

function derived<T>(value: T, origin: ForgeGreenR0MeasurementOrigin = "LOCAL"): ForgeGreenR0Metric<T> {
  return { value, source: "DERIVED", origin };
}

function finiteNonnegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeReason(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "UNKNOWN";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32);
}

function emptyToolAccounting(): ForgeGreenR0ToolAccounting {
  return {
    toolCalls: metric(0, "RUNTIME"),
    executedToolCalls: metric(0, "RUNTIME"),
    failedToolCalls: metric(0, "RUNTIME"),
    duplicateEquivalentToolCalls: metric(0, "RUNTIME"),
    rawToolOutputBytes: metric(0, "RUNTIME"),
    bytesDeliveredToModelContext: metric(0, "RUNTIME"),
    toolDurationMs: metric(0, "RUNTIME"),
    compression: {
      originalBytes: metric(0, "RUNTIME"),
      deliveredBytes: metric(0, "RUNTIME"),
      bytesAvoided: metric(0, "RUNTIME"),
      ratio: derived(1),
    },
    byTool: [],
  };
}

/**
 * Bounded, observational R0 collector. It records sizes and classifications, not content. The
 * collector has no methods that can select a route, waive verification, or change completion.
 */
export class ForgeGreenR0TelemetryCollector {
  private collectionOverheadMs = 0;
  private providerAttempts = 0;
  private modelAttempts = 0;
  private inputTokens?: number;
  private cachedInputTokens?: number;
  private outputTokens?: number;
  private providerTotalTokens?: number;
  private stablePromptCacheHits = 0;
  private providerPromptCacheReports = 0;
  private readonly routes = new Map<string, { providerId: string; modelId: string; routeClass: string; attempts: number }>();
  private readonly tools = new Map<string, { calls: number; executed: number; suppressed: number }>();
  private executedToolCalls = 0;
  private failedToolCalls = 0;
  private rawToolOutputBytes = 0;
  private rawToolOutputBytesKnown = true;
  private bytesDeliveredToModelContext = 0;
  private bytesDeliveredToModelContextKnown = true;
  private toolDurationMs = 0;
  private toolDurationKnown = true;
  private compressionOriginalBytes = 0;
  private compressionDeliveredBytes = 0;
  private compressionKnown = true;
  private duplicateEquivalentToolCalls = 0;
  private initialContextBytes?: number;
  private modelContextBytes = 0;
  private stablePromptBytes = 0;
  private readonly sourceCategories = new Map<string, number>();
  private retryCount = 0;
  private readonly retryReasons = new Map<string, number>();
  private providerFailures = 0;
  private rateLimitSignals = 0;
  private readonly failureCodes = new Map<string, number>();
  private taskCompletionStatus?: string;
  private stopReason?: string;
  private routeClassValue?: string;

  constructor(private readonly identity: ForgeGreenR0RunIdentity) {}

  private measure<T>(operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.collectionOverheadMs += Math.max(0, performance.now() - startedAt);
    }
  }

  setRouteClass(routeClass: string): void {
    this.measure(() => {
      if (!this.routeClassValue) this.routeClassValue = safeReason(routeClass);
    });
  }

  recordRepositoryGeneration(generation: number | undefined): void {
    this.measure(() => {
      const value = finiteNonnegative(generation);
      if (value !== undefined && this.identity.repositoryGeneration === undefined) {
        this.identity.repositoryGeneration = Math.floor(value);
      }
    });
  }

  recordModelAttempt(input: { providerId?: string; modelId?: string; routeClass: string; contextBytes?: number; stablePromptBytes?: number }): void {
    this.measure(() => {
      this.modelAttempts++;
      this.setRouteClass(input.routeClass);
      const contextBytes = finiteNonnegative(input.contextBytes);
      if (contextBytes !== undefined) this.modelContextBytes += contextBytes;
      const stablePromptBytes = finiteNonnegative(input.stablePromptBytes);
      if (stablePromptBytes !== undefined) this.stablePromptBytes += stablePromptBytes;
    });
  }

  recordProviderAttempt(providerId: string | undefined, modelId: string | undefined, routeClass: string): void {
    this.measure(() => {
      if (!providerId || !modelId) return;
      this.providerAttempts++;
      this.setRouteClass(routeClass);
      const key = `${providerId}\0${modelId}\0${routeClass}`;
      const prior = this.routes.get(key);
      if (prior) prior.attempts++;
      else this.routes.set(key, { providerId, modelId, routeClass: safeReason(routeClass), attempts: 1 });
    });
  }

  recordModelResponse(response: ForgeGreenR0ModelResponseObservation): void {
    this.measure(() => {
      this.setRouteClass(response.routeClass);
      if (response.usageSource !== "PROVIDER_REPORTED") return;
      this.inputTokens = (this.inputTokens ?? 0) + (finiteNonnegative(response.inputTokens) ?? 0);
      this.outputTokens = (this.outputTokens ?? 0) + (finiteNonnegative(response.outputTokens) ?? 0);
      if (response.cachedInputTokens !== undefined) {
        this.cachedInputTokens = (this.cachedInputTokens ?? 0) + (finiteNonnegative(response.cachedInputTokens) ?? 0);
        this.providerPromptCacheReports++;
      }
      if (response.totalTokens !== undefined) {
        this.providerTotalTokens = (this.providerTotalTokens ?? 0) + (finiteNonnegative(response.totalTokens) ?? 0);
      }
      if (response.stablePromptCacheHit) this.stablePromptCacheHits++;
    });
  }

  recordRetry(reason: string): void {
    this.measure(() => {
      this.retryCount++;
      const safe = safeReason(reason);
      this.retryReasons.set(safe, (this.retryReasons.get(safe) ?? 0) + 1);
    });
  }

  recordProviderFailure(input: { providerId?: string; modelId?: string; routeClass: string; code: string; rateLimited?: boolean }): void {
    this.measure(() => {
      this.providerFailures++;
      if (input.rateLimited) this.rateLimitSignals++;
      this.failureCodes.set(safeReason(input.code), (this.failureCodes.get(safeReason(input.code)) ?? 0) + 1);
      this.recordProviderAttempt(input.providerId, input.modelId, input.routeClass);
    });
  }

  recordToolCall(toolName: string): void {
    this.measure(() => {
      const prior = this.tools.get(toolName);
      if (prior) prior.calls++;
      else this.tools.set(toolName, { calls: 1, executed: 0, suppressed: 0 });
    });
  }

  recordToolExecution(observation: ForgeGreenR0ToolObservation): void {
    this.measure(() => {
      const entry = this.tools.get(observation.toolName) ?? { calls: 0, executed: 0, suppressed: 0 };
      entry.executed++;
      this.tools.set(observation.toolName, entry);
      this.executedToolCalls++;
      if (observation.success === false) this.failedToolCalls++;
      const rawBytes = finiteNonnegative(observation.rawOutputBytes);
      if (rawBytes === undefined) this.rawToolOutputBytesKnown = false;
      else if (this.rawToolOutputBytesKnown) this.rawToolOutputBytes += rawBytes;
      const deliveredBytes = finiteNonnegative(observation.deliveredBytes);
      if (deliveredBytes === undefined) this.bytesDeliveredToModelContextKnown = false;
      else if (this.bytesDeliveredToModelContextKnown) this.bytesDeliveredToModelContext += deliveredBytes;
      const durationMs = finiteNonnegative(observation.durationMs);
      if (durationMs === undefined) this.toolDurationKnown = false;
      else if (this.toolDurationKnown) this.toolDurationMs += durationMs;
      const originalBytes = finiteNonnegative(observation.originalBytes);
      const compressedBytes = finiteNonnegative(observation.compressedBytes);
      if (originalBytes !== undefined && compressedBytes !== undefined) {
        this.compressionOriginalBytes += originalBytes;
        this.compressionDeliveredBytes += compressedBytes;
      } else {
        const delivered = finiteNonnegative(observation.deliveredBytes);
        if (delivered !== undefined) {
          this.compressionOriginalBytes += delivered;
          this.compressionDeliveredBytes += delivered;
        } else this.compressionKnown = false;
      }
    });
  }

  recordDuplicateEquivalentToolCall(toolName: string, deliveredBytes?: number): void {
    this.measure(() => {
      const entry = this.tools.get(toolName) ?? { calls: 0, executed: 0, suppressed: 0 };
      entry.suppressed++;
      this.tools.set(toolName, entry);
      this.duplicateEquivalentToolCalls++;
      const bytes = finiteNonnegative(deliveredBytes);
      if (bytes === undefined) this.bytesDeliveredToModelContextKnown = false;
      else if (this.bytesDeliveredToModelContextKnown) this.bytesDeliveredToModelContext += bytes;
    });
  }

  recordContext(input: { initialContextBytes?: number; sourceCategories?: Record<string, number> }): void {
    this.measure(() => {
      const initial = finiteNonnegative(input.initialContextBytes);
      if (initial !== undefined) this.initialContextBytes = initial;
      for (const [category, count] of Object.entries(input.sourceCategories ?? {})) {
        const value = finiteNonnegative(count);
        if (value !== undefined) this.sourceCategories.set(safeReason(category), value);
      }
    });
  }

  recordResult(status: string, stopReason: string): void {
    this.measure(() => {
      this.taskCompletionStatus = status;
      this.stopReason = stopReason;
    });
  }

  finalize(input: { wallTimeMs: number; forgeVerify?: ForgeGreenR0AuthorityObservation; completionGate?: ForgeGreenR0AuthorityObservation }): ForgeGreenR0Telemetry {
    const finalizeStartedAt = performance.now();
    const inputMetric = this.inputTokens === undefined ? unknown<number>() : metric(this.inputTokens, "PROVIDER");
    const cachedMetric = this.cachedInputTokens === undefined ? unknown<number>() : metric(this.cachedInputTokens, "PROVIDER");
    const outputMetric = this.outputTokens === undefined ? unknown<number>() : metric(this.outputTokens, "PROVIDER");
    const totalMetric = this.providerTotalTokens !== undefined
      ? metric(this.providerTotalTokens, "PROVIDER")
      : this.inputTokens !== undefined && this.outputTokens !== undefined
        ? derived(this.inputTokens + this.outputTokens)
        : unknown<number>();
    const effectiveUncached = this.inputTokens !== undefined && this.cachedInputTokens !== undefined && this.cachedInputTokens <= this.inputTokens
      ? derived(this.inputTokens - this.cachedInputTokens)
      : unknown<number>();
    const toolAccounting = emptyToolAccounting();
    toolAccounting.toolCalls = metric([...this.tools.values()].reduce((sum, entry) => sum + entry.calls, 0), "RUNTIME");
    toolAccounting.executedToolCalls = metric(this.executedToolCalls, "RUNTIME");
    toolAccounting.failedToolCalls = metric(this.failedToolCalls, "RUNTIME");
    toolAccounting.duplicateEquivalentToolCalls = metric(this.duplicateEquivalentToolCalls, "RUNTIME");
    toolAccounting.rawToolOutputBytes = this.rawToolOutputBytesKnown ? metric(this.rawToolOutputBytes, "RUNTIME") : unknown<number>();
    toolAccounting.bytesDeliveredToModelContext = this.bytesDeliveredToModelContextKnown ? metric(this.bytesDeliveredToModelContext, "RUNTIME") : unknown<number>();
    toolAccounting.toolDurationMs = this.toolDurationKnown ? metric(this.toolDurationMs, "RUNTIME") : unknown<number>();
    toolAccounting.compression.originalBytes = this.compressionKnown ? metric(this.compressionOriginalBytes, "RUNTIME") : unknown<number>();
    toolAccounting.compression.deliveredBytes = this.compressionKnown ? metric(this.compressionDeliveredBytes, "RUNTIME") : unknown<number>();
    toolAccounting.compression.bytesAvoided = this.compressionKnown
      ? derived(Math.max(0, this.compressionOriginalBytes - this.compressionDeliveredBytes))
      : unknown<number>();
    toolAccounting.compression.ratio = this.compressionKnown
      ? this.compressionOriginalBytes > 0
        ? derived(this.compressionDeliveredBytes / this.compressionOriginalBytes)
        : derived(1)
      : unknown<number>();
    toolAccounting.byTool = [...this.tools.entries()].map(([toolName, entry]) => ({
      toolName,
      calls: metric(entry.calls, "RUNTIME"),
      executed: metric(entry.executed, "RUNTIME"),
      suppressed: metric(entry.suppressed, "RUNTIME"),
    }));
    const routeClass = this.routeClassValue
      ? metric(this.routeClassValue, "RUNTIME")
      : unknown<string>();
    const providerAttempts = metric(this.providerAttempts, "RUNTIME");
    const modelAttempts = metric(this.modelAttempts, "RUNTIME");
    const retryReasons = [...this.retryReasons.entries()].map(([reason, count]) => ({ reason, count: metric(count, "RUNTIME") }));
    const failureCodes = [...this.failureCodes.entries()].map(([code, count]) => ({ code, count: metric(count, "RUNTIME") }));
    const overheadMs = this.collectionOverheadMs + Math.max(0, performance.now() - finalizeStartedAt);
    const telemetry: Omit<ForgeGreenR0Telemetry, "telemetryId"> = {
      schemaVersion: FORGE_GREEN_R0_TELEMETRY_SCHEMA_VERSION,
      policyVersion: FORGE_GREEN_R0_POLICY_VERSION,
      generatedAt: new Date().toISOString(),
      identity: { ...this.identity },
      routeClass,
      routes: [...this.routes.values()].map((route) => ({ ...route, attempts: metric(route.attempts, "RUNTIME") })),
      model: {
        providerAttempts,
        modelAttempts,
        inputTokens: inputMetric,
        cachedInputTokens: cachedMetric,
        outputTokens: outputMetric,
        totalTokens: totalMetric,
        effectiveUncachedInputTokens: effectiveUncached,
        stablePromptCacheHits: metric(this.stablePromptCacheHits, "RUNTIME"),
        providerPromptCacheReports: metric(this.providerPromptCacheReports, "RUNTIME"),
      },
      tools: toolAccounting,
      context: {
        initialContextBytes: this.initialContextBytes === undefined ? unknown<number>() : metric(this.initialContextBytes, "RUNTIME"),
        modelContextBytes: metric(this.modelContextBytes, "RUNTIME"),
        stablePromptBytes: metric(this.stablePromptBytes, "RUNTIME"),
        sourceCategories: Object.fromEntries([...this.sourceCategories.entries()].map(([key, value]) => [key, metric(value, "RUNTIME")])),
      },
      retries: { retryCount: metric(this.retryCount, "RUNTIME"), reasons: retryReasons },
      providerFailures: {
        providerFailures: metric(this.providerFailures, "RUNTIME"),
        rateLimitSignals: metric(this.rateLimitSignals, "RUNTIME"),
        failureCodes,
      },
      wallTimeMs: metric(Math.max(0, input.wallTimeMs), "RUNTIME"),
      actualProviderCost: unknown<number>(),
      effectiveProviderCost: unknown<number>(),
      forgeVerify: input.forgeVerify ?? { status: "UNKNOWN", source: "UNKNOWN" },
      completionGate: input.completionGate ?? { status: "UNKNOWN", source: "UNKNOWN" },
      taskCompletionStatus: this.taskCompletionStatus === undefined ? unknown<string>() : metric(this.taskCompletionStatus, "RUNTIME"),
      stopReason: this.stopReason === undefined ? unknown<string>() : metric(this.stopReason, "RUNTIME"),
      forgeGreenOverheadMs: metric(overheadMs, "LOCAL"),
    };
    return {
      ...telemetry,
      telemetryId: `fg-r0-${digest({ ...telemetry, generatedAt: undefined })}`,
    };
  }
}

export function createForgeGreenR0TelemetryCollector(identity: ForgeGreenR0RunIdentity): ForgeGreenR0TelemetryCollector {
  return new ForgeGreenR0TelemetryCollector(identity);
}

/**
 * Durable storage for R0 measurements. It uses the existing append-only work-item abstraction;
 * telemetry failures are handled by the caller as non-authoritative best effort.
 */
export class ForgeGreenR0TelemetryStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async save(telemetry: ForgeGreenR0Telemetry): Promise<void> {
    const now = new Date().toISOString();
    const item: WorkItem = {
      kind: FORGE_GREEN_R0_TELEMETRY_WORK_ITEM_KIND,
      id: `forgegreen-r0-telemetry-${telemetry.identity.runId}`,
      sessionId: telemetry.identity.sessionId,
      runId: telemetry.identity.runId,
      record: telemetry as unknown as Record<string, unknown>,
      createdAt: now,
    } as WorkItem;
    await this.persistence.insertIfAbsent(item);
  }

  async loadByRun(sessionId: string, runId: string): Promise<ForgeGreenR0Telemetry | undefined> {
    const item = await this.persistence.getWorkItem(`forgegreen-r0-telemetry-${runId}`);
    if (!item || item.kind !== FORGE_GREEN_R0_TELEMETRY_WORK_ITEM_KIND || item.sessionId !== sessionId) return undefined;
    return item.record as unknown as ForgeGreenR0Telemetry;
  }
}

export function createForgeGreenR0TelemetryStore(persistence: ISessionPersistence): ForgeGreenR0TelemetryStore {
  return new ForgeGreenR0TelemetryStore(persistence);
}

export function effectiveUncachedInputTokens(inputTokens: number | undefined, cachedInputTokens: number | undefined): number | undefined {
  if (inputTokens === undefined || cachedInputTokens === undefined) return undefined;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens) || inputTokens < 0 || cachedInputTokens < 0 || cachedInputTokens > inputTokens) return undefined;
  return inputTokens - cachedInputTokens;
}

export interface PromptCacheExperimentSample {
  workloadId: string;
  providerId: string;
  modelId: string;
  routeClass?: string;
  toolsetRevision?: string;
  securityPolicyRevision?: string;
  repositoryRevision?: string;
  verificationPolicyRevision: string;
  totalInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  wallTimeMs?: number;
  effectiveProviderCost?: number;
  providerAttempts?: number;
  retryCount?: number;
  forgeGreenOverheadMs?: number;
  forgeVerifyStatus: ForgeGreenR0AuthorityObservation;
  completionGateStatus: ForgeGreenR0AuthorityObservation;
  taskCompletionStatus: string;
}

export interface PromptCacheComparison {
  comparable: boolean;
  reasons: string[];
  control: { uncachedInputTokens?: number };
  experiment: { uncachedInputTokens?: number };
  deltas: {
    uncachedInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    wallTimeMs?: number;
    effectiveProviderCost?: number;
    providerAttempts?: number;
    retryCount?: number;
    forgeGreenOverheadMs?: number;
  };
  verificationParity: boolean;
  completionParity: boolean;
  netPositive: boolean;
}

function sameDefined<T>(left: T | undefined, right: T | undefined): boolean {
  return left !== undefined && right !== undefined;
}

/** Compares a control and cache-shaped run without ever treating missing data as a zero. */
export function comparePromptCacheExperiment(control: PromptCacheExperimentSample, experiment: PromptCacheExperimentSample): PromptCacheComparison {
  const reasons: string[] = [];
  if (control.workloadId !== experiment.workloadId) reasons.push("WORKLOAD_MISMATCH");
  if (control.providerId !== experiment.providerId) reasons.push("PROVIDER_MISMATCH");
  if (control.modelId !== experiment.modelId) reasons.push("MODEL_MISMATCH");
  if (control.routeClass !== experiment.routeClass) reasons.push("ROUTE_CLASS_MISMATCH");
  if (control.toolsetRevision !== experiment.toolsetRevision) reasons.push("TOOLSET_REVISION_MISMATCH");
  if (control.securityPolicyRevision !== experiment.securityPolicyRevision) reasons.push("SECURITY_POLICY_MISMATCH");
  if (control.repositoryRevision !== experiment.repositoryRevision) reasons.push("REPOSITORY_REVISION_MISMATCH");
  if (control.verificationPolicyRevision !== experiment.verificationPolicyRevision) reasons.push("VERIFICATION_POLICY_MISMATCH");
  const controlUncached = effectiveUncachedInputTokens(control.totalInputTokens, control.cachedInputTokens);
  const experimentUncached = effectiveUncachedInputTokens(experiment.totalInputTokens, experiment.cachedInputTokens);
  const verificationParity = control.forgeVerifyStatus.status === experiment.forgeVerifyStatus.status && control.forgeVerifyStatus.status !== "UNKNOWN";
  const completionParity = control.completionGateStatus.status === experiment.completionGateStatus.status && control.completionGateStatus.status !== "UNKNOWN" && control.taskCompletionStatus === experiment.taskCompletionStatus;
  if (!verificationParity) reasons.push("VERIFICATION_PARITY_UNPROVEN");
  if (!completionParity) reasons.push("COMPLETION_PARITY_UNPROVEN");
  const improvements: boolean[] = [];
  if (sameDefined(controlUncached, experimentUncached)) improvements.push(experimentUncached! < controlUncached!);
  else reasons.push("UNCACHED_INPUT_UNKNOWN");
  if (sameDefined(control.wallTimeMs, experiment.wallTimeMs)) improvements.push(experiment.wallTimeMs! < control.wallTimeMs!);
  if (sameDefined(control.effectiveProviderCost, experiment.effectiveProviderCost)) improvements.push(experiment.effectiveProviderCost! < control.effectiveProviderCost!);
  const wallOrCostImproved = improvements.slice(1).some(Boolean);
  const overheadComparable = sameDefined(control.forgeGreenOverheadMs, experiment.forgeGreenOverheadMs);
  if (overheadComparable && experiment.forgeGreenOverheadMs! > control.forgeGreenOverheadMs! && !wallOrCostImproved) {
    reasons.push("FORGEGREEN_OVERHEAD_ERASES_WIN");
  }
  if (improvements.length === 0 || !improvements.some(Boolean)) reasons.push("NET_RESOURCE_WIN_UNPROVEN");
  const deltas = {
    ...(sameDefined(controlUncached, experimentUncached) ? { uncachedInputTokens: experimentUncached! - controlUncached! } : {}),
    ...(sameDefined(control.cachedInputTokens, experiment.cachedInputTokens) ? { cachedInputTokens: experiment.cachedInputTokens! - control.cachedInputTokens! } : {}),
    ...(sameDefined(control.outputTokens, experiment.outputTokens) ? { outputTokens: experiment.outputTokens! - control.outputTokens! } : {}),
    ...(sameDefined(control.wallTimeMs, experiment.wallTimeMs) ? { wallTimeMs: experiment.wallTimeMs! - control.wallTimeMs! } : {}),
    ...(sameDefined(control.effectiveProviderCost, experiment.effectiveProviderCost) ? { effectiveProviderCost: experiment.effectiveProviderCost! - control.effectiveProviderCost! } : {}),
    ...(sameDefined(control.providerAttempts, experiment.providerAttempts) ? { providerAttempts: experiment.providerAttempts! - control.providerAttempts! } : {}),
    ...(sameDefined(control.retryCount, experiment.retryCount) ? { retryCount: experiment.retryCount! - control.retryCount! } : {}),
    ...(sameDefined(control.forgeGreenOverheadMs, experiment.forgeGreenOverheadMs) ? { forgeGreenOverheadMs: experiment.forgeGreenOverheadMs! - control.forgeGreenOverheadMs! } : {}),
  };
  const comparable = reasons.length === 0;
  return {
    comparable,
    reasons,
    control: { uncachedInputTokens: controlUncached },
    experiment: { uncachedInputTokens: experimentUncached },
    deltas,
    verificationParity,
    completionParity,
    netPositive: comparable && improvements.some(Boolean) && !reasons.includes("FORGEGREEN_OVERHEAD_ERASES_WIN"),
  };
}
