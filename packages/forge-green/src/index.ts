import crypto from "node:crypto";

import { FORGE_GREEN_POLICY_VERSION } from "./constants.js";

export { FORGE_GREEN_POLICY_VERSION, FORGE_GREEN_FEATURE_VERSION } from "./constants.js";
export {
  FORGE_GREEN_CACHE_SCHEMA_VERSION,
  canonicalCacheKey,
  type CanonicalCacheIdentity,
} from "./canonical-cache.js";
export {
  FORGE_GREEN_LEDGER_SCHEMA_VERSION,
  ForgeGreenLedgerCollector,
  createForgeGreenLedgerCollector,
  type EfficiencyMeasurement,
  type EfficiencyLedgerEvent,
  type ForgeGreenMechanism,
  type ForgeGreenLedgerIdentity,
  type ForgeGreenLedgerRecord,
  type ForgeGreenLedgerTotals,
} from "./ledger.js";
export * from "./risk.js";
export * from "./verification-policy.js";
export * from "./evidence-resolution.js";
export * from "./coverage-authority.js";

// FG-8: sustainability & resource measurement. Observational only — see docs/forgegreen.md and
// docs/codeforge-forgegreen-measurement-contract.md for the full authority boundary.
export { FORGE_GREEN_SUSTAINABILITY_POLICY_VERSION } from "./constants.js";
export * from "./sustainability-types.js";
export * from "./measurement-normalization.js";
export * from "./waste-taxonomy.js";
export * from "./hardware-telemetry.js";
export * from "./energy-estimator.js";
export * from "./baseline.js";
export * from "./sustainability-receipt.js";
export * from "./sustainability-summary.js";
export * from "./sustainability-persistence.js";
export * from "./sustainability-fixtures.js";
export * from "./live-context-adapter.js";

// FG-9: ForgeGreen optimization & efficiency policy (Phase 4). Narrowly scoped resource-control
// authority only — see docs/codeforge-forgegreen-optimization-policy.md.
export * from "./optimization-types.js";
export * from "./optimization-policy.js";
export * from "./optimization-decision.js";
export * from "./optimization-candidate-a.js";
export * from "./optimization-candidates-shadow.js";
export * from "./optimization-persistence.js";

export const FORGE_GREEN_LEDGER_WORK_ITEM_KIND = "forgegreen_ledger";

export type EfficiencyScore = number & { readonly __forgeGreenEfficiencyScore: unique symbol };
export type WorkAvoidanceEstimate = number & { readonly __forgeGreenWorkAvoidanceEstimate: unique symbol };
export type ContextSavingsEstimate = number & { readonly __forgeGreenContextSavingsEstimate: unique symbol };
export type VerificationCostEstimate = number & { readonly __forgeGreenVerificationCostEstimate: unique symbol };
export type CacheConfidence = "unknown" | "bounded" | "high";
export type ReuseConfidence = "unknown" | "content_hash" | "identity_exact";
export type BlastRadiusCompleteness = "unknown" | "bounded" | "partial" | "candidate-only";

export type ForgeGreenReasonCode =
  | "context_cache_hit"
  | "content_hash_reuse"
  | "stable_prefix_reused"
  | "duplicate_request_suppressed"
  | "progressive_context_clamped"
  | "verification_candidate_ranked"
  | "safe_fallback"
  | "analysis_unavailable"
  | "stale_generation_rejected"
  | "corrupt_cache_rejected"
  | "user_intent_hold"
  | "forgegreen_disabled"
  | "provider_prompt_cache_reported"
  | "tool_output_compressed"
  | "duplicate_action_suppressed"
  | "no_progress_interrupted"
  | "canonical_cache_hit"
  | "canonical_cache_miss"
  | "canonical_cache_invalidated";

export interface ContextCacheIdentity {
  workspaceId: string;
  repositoryGeneration: number;
  taskIdentity: string;
  agentRole: string;
  retrievalPolicyVersion: string;
  contextBudget: number;
  featureVersion: string;
  authorityState?: string;
}

export interface VerificationRecommendation {
  kind: "verification_recommendation";
  candidateTests: string[];
  changedPaths: string[];
  completeness: BlastRadiusCompleteness;
  confidence: CacheConfidence;
  rationale: string[];
  reasonCodes: ForgeGreenReasonCode[];
}

export interface EfficiencyReceipt {
  receiptId: string;
  workspaceId: string;
  repositoryGeneration: number;
  contextRequestedTokens?: number;
  contextDeliveredTokens?: number;
  tokensAvoided: number;
  retrievalCacheHits: number;
  parseCacheHits?: number;
  promptPrefixCacheHits?: number;
  duplicateRequestsAvoided: number;
  retriesAvoided?: number;
  recommendedVerification?: string[];
  canonicalVerificationExecuted?: string[];
  fallbackUsed: boolean;
  reasonCodes: ForgeGreenReasonCode[];
  policyVersion: string;
  /** FG-1A: `provider_reported` only when the provider itself reported cached input tokens. */
  promptCacheAccounting: "unavailable" | "provider_reported";
  /** FG-1A: provider-reported cached input tokens observed during the run, when known. */
  providerCachedInputTokens?: number;
  /** FG-1B: measured model-context bytes avoided by deterministic tool-output compression. */
  toolOutputBytesAvoided?: number;
  /** FG-1C: duplicate read-only actions suppressed against unchanged state. */
  duplicateActionsSuppressed?: number;
  /** FG-1C: bounded no-progress interruptions. */
  noProgressInterruptions?: number;
  /** FG-1D: canonical analysis cache outcomes. */
  canonicalCacheHits?: number;
  canonicalCacheMisses?: number;
  interactiveEfficiency?: InteractiveEfficiencyMetrics;
}

export interface InteractiveEfficiencyMetrics {
  userIntentHoldCount: number;
  userIntentHoldDurationMs: number;
  modelDispatchesAvoided: number;
  toolDispatchesAvoided: number;
  subagentDispatchesAvoided: number;
  verifierDispatchesAvoided: number;
  speculativeStepsAvoided: number;
}

export interface ForgeGreenSnapshot {
  enabled: boolean;
  contextCacheHits: number;
  contentHashHits: number;
  promptPrefixHits: number;
  duplicateRequestsAvoided: number;
  fallbackCount: number;
}

export interface ForgeGreenOptions {
  enabled?: boolean;
  maxEntries?: number;
  policyVersion?: string;
}

interface CacheEntry<T> {
  value: T;
  touchedAt: number;
}

interface ImmutableFragment {
  content: string;
  contentHash: string;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function boundedEntries<T>(entries: Map<string, CacheEntry<T>>, maximum: number): void {
  while (entries.size > maximum) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return;
    entries.delete(oldest[0]);
  }
}

function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("ForgeGreen optimization cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      cleanup();
      reject(new Error("ForgeGreen optimization cancelled"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

/**
 * ForgeGreen is deliberately an advisor. It stores only bounded immutable evidence and never
 * returns a permission, verification, approval, or completion decision.
 */
export class ForgeGreenAdvisor {
  private readonly enabled: boolean;
  private readonly maximum: number;
  private readonly policyVersion: string;
  private readonly contextEntries = new Map<string, CacheEntry<unknown>>();
  private readonly fragments = new Map<string, CacheEntry<ImmutableFragment>>();
  private readonly prefixes = new Map<string, CacheEntry<true>>();
  private readonly completedRequests = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private contextCacheHits = 0;
  private contentHashHits = 0;
  private promptPrefixHits = 0;
  private duplicateRequestsAvoided = 0;
  private fallbackCount = 0;
  private readonly interactiveMetrics: InteractiveEfficiencyMetrics = {
    userIntentHoldCount: 0,
    userIntentHoldDurationMs: 0,
    modelDispatchesAvoided: 0,
    toolDispatchesAvoided: 0,
    subagentDispatchesAvoided: 0,
    verifierDispatchesAvoided: 0,
    speculativeStepsAvoided: 0,
  };

  constructor(options: ForgeGreenOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maximum = Math.max(1, options.maxEntries ?? 256);
    this.policyVersion = options.policyVersion ?? FORGE_GREEN_POLICY_VERSION;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  contextKey(identity: ContextCacheIdentity): string {
    return hash(stableJson(identity));
  }

  getContext<T>(identity: ContextCacheIdentity): T | undefined {
    if (!this.enabled) return undefined;
    const key = this.contextKey(identity);
    const entry = this.contextEntries.get(key);
    if (!entry) return undefined;
    if (identity.repositoryGeneration <= 0) {
      this.contextEntries.delete(key);
      return undefined;
    }
    entry.touchedAt = Date.now();
    this.contextCacheHits++;
    return entry.value as T;
  }

  putContext(identity: ContextCacheIdentity, value: unknown): void {
    if (!this.enabled) return;
    this.contextEntries.set(this.contextKey(identity), { value, touchedAt: Date.now() });
    boundedEntries(this.contextEntries, this.maximum);
  }

  getImmutableFragment(content: string): string {
    if (!this.enabled) return content;
    const contentHash = hash(content);
    const cached = this.fragments.get(contentHash);
    if (!cached || cached.value.contentHash !== contentHash) return content;
    cached.touchedAt = Date.now();
    this.contentHashHits++;
    return cached.value.content;
  }

  rememberImmutableFragment(content: string): string {
    if (!this.enabled) return content;
    const contentHash = hash(content);
    this.fragments.set(contentHash, { value: Object.freeze({ content, contentHash }), touchedAt: Date.now() });
    boundedEntries(this.fragments, this.maximum);
    return content;
  }

  observeStablePrefix(providerId: string, modelId: string, prefix: string): boolean {
    if (!this.enabled) return false;
    const key = hash(stableJson({ providerId, modelId, prefix }));
    const prior = this.prefixes.get(key);
    this.prefixes.set(key, { value: true, touchedAt: Date.now() });
    boundedEntries(this.prefixes, this.maximum);
    if (!prior) return false;
    prior.touchedAt = Date.now();
    this.promptPrefixHits++;
    return true;
  }

  async runDeduplicated<T>(identity: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<{ value: T; suppressed: boolean }> {
    if (signal?.aborted) throw new Error("ForgeGreen optimization cancelled");
    if (!this.enabled) return { value: await awaitAbortable(operation(), signal), suppressed: false };
    const key = hash(identity);
    const prior = this.inFlight.get(key);
    if (prior) {
      this.duplicateRequestsAvoided++;
      return { value: await awaitAbortable(prior as Promise<T>, signal), suppressed: true };
    }
    const completed = this.completedRequests.get(key);
    if (completed) {
      completed.touchedAt = Date.now();
      this.duplicateRequestsAvoided++;
      return { value: completed.value as T, suppressed: true };
    }
    const pending = operation();
    this.inFlight.set(key, pending as Promise<unknown>);
    try {
      const value = await pending;
      this.completedRequests.set(key, { value, touchedAt: Date.now() });
      boundedEntries(this.completedRequests, this.maximum);
      return { value, suppressed: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  recommendVerification(input: { changedPaths: string[]; candidateTests?: string[]; analysisAvailable?: boolean }): VerificationRecommendation {
    if (!this.enabled || input.analysisAvailable === false) {
      this.fallbackCount++;
      return {
        kind: "verification_recommendation",
        candidateTests: [],
        changedPaths: [...new Set(input.changedPaths)],
        completeness: "unknown",
        confidence: "unknown",
        rationale: ["ForgeGreen analysis unavailable; canonical verification remains required."],
        reasonCodes: [this.enabled ? "analysis_unavailable" : "forgegreen_disabled", "safe_fallback"],
      };
    }
    return {
      kind: "verification_recommendation",
      candidateTests: [...new Set(input.candidateTests ?? [])],
      changedPaths: [...new Set(input.changedPaths)],
      completeness: "candidate-only",
      confidence: "bounded",
      rationale: ["Candidates are ranked for efficiency only; canonical verification policy decides what executes."],
      reasonCodes: ["verification_candidate_ranked"],
    };
  }

  recordFallback(): void {
    this.fallbackCount++;
  }

  recordUserIntentHold(durationMs = 0): void {
    if (!this.enabled) return;
    this.interactiveMetrics.userIntentHoldCount++;
    this.interactiveMetrics.userIntentHoldDurationMs += Math.max(0, durationMs);
  }

  recordAvoidedDispatch(kind: "model" | "tool" | "subagent" | "verifier" | "other"): void {
    if (!this.enabled) return;
    if (kind === "model") this.interactiveMetrics.modelDispatchesAvoided++;
    else if (kind === "tool") this.interactiveMetrics.toolDispatchesAvoided++;
    else if (kind === "subagent") this.interactiveMetrics.subagentDispatchesAvoided++;
    else if (kind === "verifier") this.interactiveMetrics.verifierDispatchesAvoided++;
    else this.interactiveMetrics.speculativeStepsAvoided++;
  }

  interactiveEfficiency(): InteractiveEfficiencyMetrics {
    return { ...this.interactiveMetrics };
  }

  snapshot(): ForgeGreenSnapshot {
    return {
      enabled: this.enabled,
      contextCacheHits: this.contextCacheHits,
      contentHashHits: this.contentHashHits,
      promptPrefixHits: this.promptPrefixHits,
      duplicateRequestsAvoided: this.duplicateRequestsAvoided,
      fallbackCount: this.fallbackCount,
    };
  }

  createReceipt(input: {
    workspaceId: string;
    repositoryGeneration: number;
    requestedTokens?: number;
    deliveredTokens?: number;
    fallbackUsed?: boolean;
    reasonCodes?: ForgeGreenReasonCode[];
    recommendedVerification?: string[];
    canonicalVerificationExecuted?: string[];
    interactiveEfficiency?: InteractiveEfficiencyMetrics;
    providerCachedInputTokens?: number;
    toolOutputBytesAvoided?: number;
    duplicateActionsSuppressed?: number;
    noProgressInterruptions?: number;
    canonicalCacheHits?: number;
    canonicalCacheMisses?: number;
  }): EfficiencyReceipt {
    const snapshot = this.snapshot();
    return {
      receiptId: hash(stableJson({ input, snapshot, policyVersion: this.policyVersion })).slice(0, 24),
      workspaceId: input.workspaceId,
      repositoryGeneration: input.repositoryGeneration,
      contextRequestedTokens: input.requestedTokens,
      contextDeliveredTokens: input.deliveredTokens,
      tokensAvoided: Math.max(0, (input.requestedTokens ?? 0) - (input.deliveredTokens ?? 0)),
      retrievalCacheHits: snapshot.contextCacheHits + snapshot.contentHashHits,
      parseCacheHits: undefined,
      promptPrefixCacheHits: snapshot.promptPrefixHits,
      duplicateRequestsAvoided: snapshot.duplicateRequestsAvoided,
      retriesAvoided: undefined,
      recommendedVerification: input.recommendedVerification,
      canonicalVerificationExecuted: input.canonicalVerificationExecuted,
      fallbackUsed: Boolean(input.fallbackUsed || snapshot.fallbackCount > 0),
      reasonCodes: [...new Set(input.reasonCodes ?? [])],
      policyVersion: this.policyVersion,
      promptCacheAccounting: typeof input.providerCachedInputTokens === "number" && input.providerCachedInputTokens > 0 ? "provider_reported" : "unavailable",
      ...(typeof input.providerCachedInputTokens === "number" && input.providerCachedInputTokens > 0 ? { providerCachedInputTokens: input.providerCachedInputTokens } : {}),
      ...(typeof input.toolOutputBytesAvoided === "number" && input.toolOutputBytesAvoided > 0 ? { toolOutputBytesAvoided: input.toolOutputBytesAvoided } : {}),
      ...(typeof input.duplicateActionsSuppressed === "number" && input.duplicateActionsSuppressed > 0 ? { duplicateActionsSuppressed: input.duplicateActionsSuppressed } : {}),
      ...(typeof input.noProgressInterruptions === "number" && input.noProgressInterruptions > 0 ? { noProgressInterruptions: input.noProgressInterruptions } : {}),
      ...(typeof input.canonicalCacheHits === "number" && input.canonicalCacheHits > 0 ? { canonicalCacheHits: input.canonicalCacheHits } : {}),
      ...(typeof input.canonicalCacheMisses === "number" && input.canonicalCacheMisses > 0 ? { canonicalCacheMisses: input.canonicalCacheMisses } : {}),
      ...(input.interactiveEfficiency ? { interactiveEfficiency: input.interactiveEfficiency } : {}),
    };
  }
}

export function createForgeGreenAdvisor(options?: ForgeGreenOptions): ForgeGreenAdvisor {
  return new ForgeGreenAdvisor(options);
}

export function fingerprint(value: unknown): string {
  return hash(stableJson(value));
}

export function asEfficiencyScore(value: number): EfficiencyScore {
  return value as EfficiencyScore;
}

export function asWorkAvoidanceEstimate(value: number): WorkAvoidanceEstimate {
  return value as WorkAvoidanceEstimate;
}

export function asContextSavingsEstimate(value: number): ContextSavingsEstimate {
  return value as ContextSavingsEstimate;
}

export function asVerificationCostEstimate(value: number): VerificationCostEstimate {
  return value as VerificationCostEstimate;
}
