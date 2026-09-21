import { ProviderError, type ProviderAdapter, type PromptCacheCapability, type ProviderResponseObservation } from "./index.js";
import type { ChatRequest, ChatResponse, StreamEvent } from "./chat-types.js";

/**
 * Observed provider quota facts extracted directly from HTTP response headers.
 * These are authoritative evidence from the live provider.
 */
export interface ObservedQuota {
  /** Provider-declared token limit for the window (`x-ratelimit-limit-tokens`). */
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensMs?: number;
  remainingRequests?: number;
  resetRequestsMs?: number;
  retryAfterMs?: number;
  observedAt: number;
}

/**
 * Fallback baseline capacity limits for providers where live headers are not yet observed.
 * Conservative fallback values only — never treated as immutable truth.
 */
export interface ProviderCapacityLimit {
  maxTokensPerMinute: number;
  maxRequestsPerMinute: number;
  maxConcurrent: number;
}

/**
 * Conservative fallback limits applied when live provider quota is unobserved.
 * Groq free accounts have ~8,000 TPM and 30 RPM limits.
 * Other providers are given conservative pacing until headers establish true limits.
 */
export const DEFAULT_FALLBACK_LIMITS: Readonly<Record<string, ProviderCapacityLimit>> = {
  openrouter: {
    maxTokensPerMinute: 60000,
    maxRequestsPerMinute: 14,
    maxConcurrent: 1,
  },
  groq: {
    maxTokensPerMinute: 7500,
    maxRequestsPerMinute: 28,
    maxConcurrent: 2,
  },
  "cloudflare-workers-ai": {
    maxTokensPerMinute: 60000,
    maxRequestsPerMinute: 20,
    maxConcurrent: 2,
  },
  zai: {
    maxTokensPerMinute: 30000,
    maxRequestsPerMinute: 30,
    maxConcurrent: 3,
  },
  default: {
    maxTokensPerMinute: 60000,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

export interface Reservation {
  readonly providerId: string;
  readonly estimatedTokens: number;
  /**
   * @param actualTokens provider-reported input+output tokens (falls back to the estimate)
   * @param actualInputTokens provider-reported prompt tokens — teaches the governor this
   *   provider's tokenizer ratio versus the byte-based prompt estimate
   */
  release(actualTokens?: number, actualInputTokens?: number): void;
}

export interface AcquireOptions {
  /**
   * Byte-based estimate of the PROMPT alone (system + messages + tool schemas), without any
   * completion reservation. Providers with a continuously refilling per-minute token bucket
   * admit a request when its prompt fits the bucket (Groq, measured 2026-09-21: a 2 566-token
   * prompt with `max_tokens 4096` was accepted at 5 170 remaining), so this is what the
   * header-driven admission compares against.
   */
  promptTokens?: number;
}

/** Freshness window for a header-derived token bucket; older observations fall back to the sliding window. */
const TOKEN_BUCKET_FRESH_MS = 90_000;
/** Minimum safety margin over the byte-based prompt estimate (tokenizers differ from chars/4). */
const PROMPT_ESTIMATE_MIN_MARGIN = 1.15;

interface ProviderState {
  tokenHistory: Array<{ timestamp: number; tokens: number }>;
  requestHistory: number[];
  activeConcurrent: number;
  inFlightTokens: number;
  cooldownUntil: number;
  waitingQueue: number;
  observedQuota?: ObservedQuota;
  customLimits?: Partial<ProviderCapacityLimit>;
  /**
   * Learned ratio of provider-reported prompt tokens to the byte-based prompt estimate (EMA).
   * Groq's gpt-oss tokenizer runs ~1.0× chars/4 on agent requests; Qwen's ran 1.8× on the same
   * request — the margin must come from evidence, not a constant.
   */
  tokenizerRatio?: number;
}

export interface ProviderCapacityGovernorOptions {
  limits?: Record<string, Partial<ProviderCapacityLimit>>;
  maxQueueDepth?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProviderCapacityReport {
  providerId: string;
  tpmUsed: number;
  tpmLimit: number;
  rpmUsed: number;
  rpmLimit: number;
  activeConcurrent: number;
  maxConcurrent: number;
  inFlightTokens: number;
  queueDepth: number;
  isCoolingDown: boolean;
  cooldownRemainingMs: number;
  observedQuota?: ObservedQuota;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Shared Provider Capacity Governor.
 *
 * Enforces evidence-driven capacity control across concurrent SubAgents:
 * 1. Sliding 60-second window tracking consumed input & output tokens.
 * 2. In-flight token pre-reservation and post-completion reconciliation.
 * 3. Asynchronous pacing queue when approaching TPM, RPM, or concurrency ceilings.
 * 4. Dynamic 429 & Retry-After backoff honoring upstream rate-limit reset headers.
 * 5. Multi-provider isolation: throttling one constrained provider never blocks another.
 */
export class ProviderCapacityGovernor {
  private readonly states = new Map<string, ProviderState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly defaultLimits: Record<string, Partial<ProviderCapacityLimit>>;
  private readonly maxQueueDepth?: number;

  constructor(options: ProviderCapacityGovernorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultLimits = options.limits ?? {};
    this.maxQueueDepth = options.maxQueueDepth;
  }

  private getState(providerId: string): ProviderState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        tokenHistory: [],
        requestHistory: [],
        activeConcurrent: 0,
        inFlightTokens: 0,
        cooldownUntil: 0,
        waitingQueue: 0,
        customLimits: this.defaultLimits[providerId],
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  private pruneHistory(state: ProviderState, now: number): void {
    const cutoff = now - 60_000;
    while (state.tokenHistory.length > 0 && state.tokenHistory[0]!.timestamp <= cutoff) {
      state.tokenHistory.shift();
    }
    while (state.requestHistory.length > 0 && state.requestHistory[0]! <= cutoff) {
      state.requestHistory.shift();
    }
  }

  getEffectiveLimits(providerId: string): ProviderCapacityLimit {
    const state = this.getState(providerId);
    const fallback = DEFAULT_FALLBACK_LIMITS[providerId] ?? DEFAULT_FALLBACK_LIMITS.default!;
    const custom = state.customLimits ?? {};

    let maxTokensPerMinute = custom.maxTokensPerMinute ?? fallback.maxTokensPerMinute;
    let maxRequestsPerMinute = custom.maxRequestsPerMinute ?? fallback.maxRequestsPerMinute;
    const maxConcurrent = custom.maxConcurrent ?? fallback.maxConcurrent;

    // Evidence-driven override: if the provider explicitly told us remaining tokens/requests
    // and reset timing, dynamically adjust our window
    if (state.observedQuota) {
      const quota = state.observedQuota;
      if (quota.remainingTokens !== undefined && quota.resetTokensMs && quota.resetTokensMs <= 60_000) {
        // If remaining tokens is critically low, temporarily constrict limit to avoid 429
        if (quota.remainingTokens < 1000) {
          maxTokensPerMinute = Math.min(maxTokensPerMinute, quota.remainingTokens + 100);
        }
      }
      if (quota.remainingRequests !== undefined && quota.remainingRequests <= 2) {
        maxRequestsPerMinute = Math.min(maxRequestsPerMinute, quota.remainingRequests + 1);
      }
    }

    return { maxTokensPerMinute, maxRequestsPerMinute, maxConcurrent };
  }

  /**
   * Acquire execution admission for a request.
   * If limits would be exceeded, pauses asynchronously until capacity frees up.
   */
  async acquire(
    providerId: string,
    estimatedTokens = 1500,
    signal?: AbortSignal,
    options: AcquireOptions = {},
  ): Promise<Reservation> {
    const state = this.getState(providerId);
    let enqueued = false;
    const promptEstimate = options.promptTokens;

    try {
      for (;;) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Acquire aborted");
        }

        const now = this.now();
        this.pruneHistory(state, now);

        // 1. Dynamic Cooldown Gate (from upstream 429 or explicit reset header)
        const isCooldown = now < state.cooldownUntil;
        const limits = this.getEffectiveLimits(providerId);
        const currentTokens = state.tokenHistory.reduce((sum, entry) => sum + entry.tokens, 0) + state.inFlightTokens;
        const currentRequests = state.requestHistory.length;

        // 2. Concurrency, RPM, TPM checks
        const isConcurrencyFull = state.activeConcurrent >= limits.maxConcurrent;
        const isRpmFull = currentRequests >= limits.maxRequestsPerMinute;
        const windowTpmFull = currentTokens + estimatedTokens > limits.maxTokensPerMinute && state.tokenHistory.length > 0;
        // Evidence-driven token bucket: when the provider's own headers describe a refilling
        // per-minute bucket and the observation is fresh, admission follows the provider's rule
        // (prompt fits the projected bucket) instead of the conservative sliding window, and a
        // wait is the exact refill time rather than a full minute.
        const bucket = promptEstimate !== undefined ? this.tokenBucketDecision(state, promptEstimate, now) : undefined;
        const isTpmFull = bucket ? !bucket.admit : windowTpmFull;

        if (isCooldown || isConcurrencyFull || isRpmFull || isTpmFull) {
          if (!enqueued) {
            if (this.maxQueueDepth !== undefined && state.waitingQueue >= this.maxQueueDepth) {
              throw new Error(`[PROVIDER_CAPACITY_EXCEEDED] Provider '${providerId}' queue depth limit (${this.maxQueueDepth}) exceeded`);
            }
            state.waitingQueue++;
            enqueued = true;
          }

          if (isCooldown) {
            const waitMs = state.cooldownUntil - now;
            if (waitMs > 60_000) {
              throw new Error(`[PROVIDER_RATE_LIMITED] Provider '${providerId}' is in cooldown (${Math.round(waitMs / 1000)}s remaining)`);
            }
            await this.sleep(waitMs, signal);
            continue;
          }

          if (isConcurrencyFull) {
            // Wait for an active request to finish (check back in 50ms)
            await this.sleep(50, signal);
            continue;
          }

          if (isRpmFull) {
            const oldestRequest = state.requestHistory[0]!;
            const waitMs = Math.max(50, oldestRequest + 60_000 - now);
            await this.sleep(waitMs, signal);
            continue;
          }

          if (isTpmFull) {
            if (bucket) {
              await this.sleep(bucket.waitMs, signal);
              continue;
            }
            const oldestToken = state.tokenHistory[0]!;
            const waitMs = Math.max(50, oldestToken.timestamp + 60_000 - now);
            await this.sleep(waitMs, signal);
            continue;
          }
        }

        // Admitted: remove from queue if previously enqueued
        if (enqueued) {
          state.waitingQueue = Math.max(0, state.waitingQueue - 1);
          enqueued = false;
        }

        // Reserve slot and estimated tokens
        state.activeConcurrent++;
        state.inFlightTokens += estimatedTokens;
        state.requestHistory.push(now);
        const acquiredAt = now;

        let released = false;
        return {
          providerId,
          estimatedTokens,
          release: (actualTokens?: number, actualInputTokens?: number) => {
            if (released) return;
            released = true;
            const releasedAt = this.now();
            state.activeConcurrent = Math.max(0, state.activeConcurrent - 1);
            state.inFlightTokens = Math.max(0, state.inFlightTokens - estimatedTokens);

            const finalTokens = actualTokens !== undefined ? Math.max(0, actualTokens) : estimatedTokens;
            state.tokenHistory.push({
              timestamp: releasedAt,
              tokens: finalTokens,
            });
            if (promptEstimate !== undefined && promptEstimate > 0 && typeof actualInputTokens === "number" && actualInputTokens > 0) {
              const observed = actualInputTokens / promptEstimate;
              state.tokenizerRatio = state.tokenizerRatio === undefined ? observed : state.tokenizerRatio * 0.7 + observed * 0.3;
            }
            // Rate-limit headers arrive with the response HEAD, after the prompt was debited but
            // before the completion existed; the provider debits the completion when generation
            // ends. A bucket observed during this request is therefore optimistic by exactly this
            // request's completion tokens (R23 round 5: a 1 494-token reasoning completion was
            // invisible to the projection and the next admission met a 429).
            const quota = state.observedQuota;
            if (quota && quota.remainingTokens !== undefined && quota.observedAt >= acquiredAt && quota.observedAt <= releasedAt && typeof actualTokens === "number" && typeof actualInputTokens === "number") {
              const completionTokens = Math.max(0, actualTokens - actualInputTokens);
              quota.remainingTokens = Math.max(0, quota.remainingTokens - completionTokens);
            }
          },
        };
      }
    } finally {
      if (enqueued) {
        state.waitingQueue = Math.max(0, state.waitingQueue - 1);
      }
    }
  }

  /**
   * Header-derived admission for providers with a refilling per-minute token bucket. Returns
   * undefined when no fresh bucket observation exists (caller falls back to the sliding window).
   */
  private tokenBucketDecision(state: ProviderState, promptEstimate: number, now: number): { admit: boolean; waitMs: number; projectedRemaining: number; need: number } | undefined {
    const quota = state.observedQuota;
    if (!quota || quota.limitTokens === undefined || quota.remainingTokens === undefined || quota.resetTokensMs === undefined) return undefined;
    if (now - quota.observedAt > TOKEN_BUCKET_FRESH_MS) return undefined;
    const limit = quota.limitTokens;
    const consumed = Math.max(0, limit - quota.remainingTokens);
    // Refill rate from the provider's own reset horizon; a full bucket (nothing to refill) or a
    // degenerate horizon falls back to the nominal limit-per-minute rate.
    const refillPerMs = consumed > 0 && quota.resetTokensMs > 0 ? consumed / quota.resetTokensMs : limit / 60_000;
    const projectedRemaining = Math.min(limit, quota.remainingTokens + refillPerMs * Math.max(0, now - quota.observedAt)) - state.inFlightTokens;
    const margin = Math.max(PROMPT_ESTIMATE_MIN_MARGIN, (state.tokenizerRatio ?? 1) * 1.1);
    const need = Math.ceil(promptEstimate * margin);
    if (need > limit) {
      // The prompt can never fit this bucket; let the request through so the provider's own
      // rejection (a definitive 4xx with its reason) is what the caller sees, not a silent hang.
      return { admit: true, waitMs: 0, projectedRemaining, need };
    }
    if (projectedRemaining >= need) return { admit: true, waitMs: 0, projectedRemaining, need };
    const waitMs = Math.min(60_000, Math.max(50, Math.ceil((need - projectedRemaining) / refillPerMs)));
    return { admit: false, waitMs, projectedRemaining, need };
  }

  /**
   * Feed an adapter's response observation (status + rate-limit headers) into the governor. This
   * is what makes pacing evidence-driven in production: factory-built adapters compose their
   * caller's observer with this method, so every Groq/Cloudflare/… response updates the bucket.
   */
  readonly observeResponse = (observation: ProviderResponseObservation): void => {
    this.recordResponse(observation.providerId, observation.status, observation.headers);
  };

  /**
   * Record authoritative response observation from provider headers.
   */
  recordResponse(
    providerId: string,
    status: number,
    headers: Array<[string, string]> | Record<string, string | undefined>,
  ): void {
    const state = this.getState(providerId);
    const now = this.now();

    const headerMap = new Map<string, string>();
    if (Array.isArray(headers)) {
      for (const [k, v] of headers) headerMap.set(k.toLowerCase(), v);
    } else {
      for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined) headerMap.set(k.toLowerCase(), v);
      }
    }

    let limitTokens: number | undefined;
    let remainingTokens: number | undefined;
    let resetTokensMs: number | undefined;
    let remainingRequests: number | undefined;
    let resetRequestsMs: number | undefined;
    let retryAfterMs: number | undefined;

    const limitTokensHeader = headerMap.get("x-ratelimit-limit-tokens");
    if (limitTokensHeader) {
      const parsed = parseInt(limitTokensHeader, 10);
      if (!Number.isNaN(parsed) && parsed > 0) limitTokens = parsed;
    }

    const remTokensHeader = headerMap.get("x-ratelimit-remaining-tokens");
    if (remTokensHeader) {
      const parsed = parseInt(remTokensHeader, 10);
      if (!Number.isNaN(parsed)) remainingTokens = parsed;
    }

    const resetTokensHeader = headerMap.get("x-ratelimit-reset-tokens");
    if (resetTokensHeader) {
      resetTokensMs = parseResetTimeToMs(resetTokensHeader);
    }

    const remReqsHeader = headerMap.get("x-ratelimit-remaining-requests");
    if (remReqsHeader) {
      const parsed = parseInt(remReqsHeader, 10);
      if (!Number.isNaN(parsed)) remainingRequests = parsed;
    }

    const resetReqsHeader = headerMap.get("x-ratelimit-reset-requests");
    if (resetReqsHeader) {
      resetRequestsMs = parseResetTimeToMs(resetReqsHeader);
    }

    const retryAfterHeader = headerMap.get("retry-after");
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!Number.isNaN(parsed)) {
        retryAfterMs = parsed * 1000;
      } else {
        const date = Date.parse(retryAfterHeader);
        if (!Number.isNaN(date)) retryAfterMs = Math.max(0, date - now);
      }
    }

    // 429 rate limit backoff
    if (status === 429) {
      const backoffMs = retryAfterMs ?? resetTokensMs ?? resetRequestsMs ?? 5000;
      state.cooldownUntil = Math.max(state.cooldownUntil, now + backoffMs);
    }

    state.observedQuota = {
      limitTokens,
      remainingTokens,
      resetTokensMs,
      remainingRequests,
      resetRequestsMs,
      retryAfterMs,
      observedAt: now,
    };
  }

  /**
   * Preserve a provider supplied retry horizon when an adapter reports a 429 as an exception
   * rather than a response object. This is intentionally provider-scoped: provider rate limits
   * are shared capacity, while 8-Bit still owns the route-level health and failover decision.
   */
  recordRateLimit(providerId: string, retryAfter?: number): void {
    const state = this.getState(providerId);
    const fallbackUntil = this.now() + 5_000;
    const suppliedUntil = typeof retryAfter === "number" && Number.isFinite(retryAfter)
      ? Math.max(this.now(), retryAfter)
      : fallbackUntil;
    state.cooldownUntil = Math.max(state.cooldownUntil, suppliedUntil);
  }

  isCoolingDown(providerId: string): boolean {
    const state = this.states.get(providerId);
    return state ? this.now() < state.cooldownUntil : false;
  }

  getCapacityReport(providerId: string): ProviderCapacityReport {
    const state = this.getState(providerId);
    const now = this.now();
    this.pruneHistory(state, now);
    const limits = this.getEffectiveLimits(providerId);
    const tpmUsed = state.tokenHistory.reduce((sum, e) => sum + e.tokens, 0) + state.inFlightTokens;
    const rpmUsed = state.requestHistory.length;
    const isCoolingDown = now < state.cooldownUntil;
    const cooldownRemainingMs = isCoolingDown ? state.cooldownUntil - now : 0;

    return {
      providerId,
      tpmUsed,
      tpmLimit: limits.maxTokensPerMinute,
      rpmUsed,
      rpmLimit: limits.maxRequestsPerMinute,
      activeConcurrent: state.activeConcurrent,
      maxConcurrent: limits.maxConcurrent,
      inFlightTokens: state.inFlightTokens,
      queueDepth: state.waitingQueue,
      isCoolingDown,
      cooldownRemainingMs,
      observedQuota: state.observedQuota,
    };
  }

  /**
   * Wrap any ProviderAdapter with capacity governance.
   */
  wrapAdapter(adapter: ProviderAdapter): ProviderAdapter {
    return new GovernedProviderAdapter(adapter, this);
  }
}

/**
 * Decorator that transparently paces all chat and streamChat requests through the governor.
 */
export class GovernedProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly isGoverned = true;

  constructor(
    readonly inner: ProviderAdapter,
    readonly governor: ProviderCapacityGovernor,
  ) {
    this.providerId = inner.providerId;
  }

  listModels() {
    return this.inner.listModels();
  }

  healthCheck() {
    return this.inner.healthCheck();
  }

  getPromptCacheCapability(modelId: string): PromptCacheCapability {
    return this.inner.getPromptCacheCapability
      ? this.inner.getPromptCacheCapability(modelId)
      : { mode: "unsupported", telemetryAvailable: false };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const estimatedTokens = estimatePromptTokens(req);
    const reservation = await this.governor.acquire(this.providerId, estimatedTokens, undefined, { promptTokens: estimatePromptOnlyTokens(req) });
    try {
      const res = await this.inner.chat(req);
      const actualTokens = (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
      reservation.release(actualTokens > 0 ? actualTokens : estimatedTokens, res.usage?.inputTokens);
      return res;
    } catch (err: unknown) {
      reservation.release(estimatedTokens);
      // Confirmed gap: this wrapper paced every call but never told the governor about an
      // observed 429, so its cooldown/backoff (and any future evidence-driven limit) never
      // engaged for calls that only ever throw rather than returning an error response.
      if (err instanceof ProviderError && err.status === 429) {
        this.governor.recordRateLimit(this.providerId, err.retryAfter);
      }
      throw err;
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const estimatedTokens = estimatePromptTokens(req);
    let reservation: Reservation | undefined;
    try {
      reservation = await this.governor.acquire(this.providerId, estimatedTokens, signal, { promptTokens: estimatePromptOnlyTokens(req) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        code: msg.includes("RATE_LIMITED") ? "PROVIDER_RATE_LIMITED" : "PROVIDER_CAPACITY_EXCEEDED",
        message: msg,
        retryable: true,
      };
      return;
    }

    let totalTokens = estimatedTokens;
    let inputTokens: number | undefined;
    try {
      for await (const event of this.inner.streamChat(req, signal)) {
        if (event.type === "usage" && event.usage) {
          totalTokens = (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
          inputTokens = event.usage.inputTokens;
        } else if ((event as any).usage) {
          const u = (event as any).usage;
          totalTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
          inputTokens = u.inputTokens;
        } else if (event.type === "error" && event.status === 429) {
          this.governor.recordRateLimit(this.providerId, event.retryAfter);
        }
        yield event;
      }
    } finally {
      reservation.release(totalTokens > 0 ? totalTokens : estimatedTokens, inputTokens);
    }
  }
}

export function estimatePromptTokens(req: ChatRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    if (typeof m.content === "string") chars += m.content.length;
  }
  return Math.max(500, Math.ceil(chars / 4) + (req.maxTokens ?? 1000));
}

/**
 * Byte-based estimate of the prompt alone: system prompt, every message (content, tool-call
 * arguments, tool-result payloads) and the serialized tool schemas — the parts a provider
 * actually tokenizes as input. No completion reservation; see {@link AcquireOptions.promptTokens}.
 */
export function estimatePromptOnlyTokens(req: ChatRequest): number {
  let chars = req.system?.length ?? 0;
  for (const m of req.messages) {
    if (typeof m.content === "string") chars += m.content.length;
    for (const call of m.toolCalls ?? []) chars += (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0) + 16;
  }
  if (req.tools && req.tools.length > 0) chars += JSON.stringify(req.tools).length;
  return Math.max(64, Math.ceil(chars / 4));
}

function parseResetTimeToMs(raw: string): number {
  const trimmed = raw.trim();
  // e.g. "6m0s", "120ms", "4.5s", "10s"
  let totalMs = 0;
  const mMatch = trimmed.match(/(\d+(?:\.\d+)?)m/);
  if (mMatch) totalMs += parseFloat(mMatch[1]!) * 60_000;
  const sMatch = trimmed.match(/(\d+(?:\.\d+)?)s/);
  if (sMatch && !trimmed.endsWith("ms")) totalMs += parseFloat(sMatch[1]!) * 1000;
  const msMatch = trimmed.match(/(\d+(?:\.\d+)?)ms/);
  if (msMatch) totalMs += parseFloat(msMatch[1]!);
  if (totalMs === 0) {
    const parsed = parseFloat(trimmed);
    if (!Number.isNaN(parsed)) totalMs = parsed * 1000;
  }
  return totalMs > 0 ? totalMs : 60_000;
}

export const defaultCapacityGovernor = new ProviderCapacityGovernor();
