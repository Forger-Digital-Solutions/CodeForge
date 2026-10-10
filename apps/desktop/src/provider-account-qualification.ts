import { randomUUID } from "node:crypto";
import { COMPACT_QUALIFICATION_SUITE_VERSION, ROLE_QUALIFICATION_SUITE_VERSION, REVIEWER_PROTOCOL, EXPLORER_PROTOCOL, runRoleAwareQualification, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { ProviderError, type ChatRequest, type ProviderAdapter, type ProviderModel, type StreamEvent, type Usage } from "@codeforge/providers";
import type { PersonalAccountBinding, PersonalAccountReservation } from "@codeforge/server";
import type { ConnectedAccountAuthority } from "./connected-accounts.js";

export interface PaidQualificationOptions {
  authority: ConnectedAccountAuthority;
  model: ProviderModel;
  workspacePath: string;
  transport: ProviderAdapter;
  assertCurrent(): void;
  reserve(binding: PersonalAccountBinding, request: ChatRequest): Promise<PersonalAccountReservation>;
  cachedReceipt?: ModelQualificationReceipt;
  recordReceipt(receipt: ModelQualificationReceipt): Promise<void>;
  runQualification?: typeof runRoleAwareQualification;
  signal?: AbortSignal;
  now?: () => number;
}

export async function qualifyPersonalPaidModel(options: PaidQualificationOptions): Promise<ModelQualificationReceipt> {
  const { authority, model, transport } = options;
  const now = options.now ?? Date.now;
  options.assertCurrent();
  if (authority.providerId !== "openrouter" || authority.accountClass !== "PAID" || !model.capabilities.toolCalling || !model.pricing
    || model.pricing.confidence !== "AUTHORITATIVE" || !model.pricing.tokenOnly || !options.workspacePath) throw new Error("PAID_QUALIFICATION_MODEL_NOT_ELIGIBLE");
  const cached = options.cachedReceipt;
  const cachedAge = cached ? now() - Date.parse(cached.completedAt) : NaN;
  const protocols = cached?.metadata?.roleProtocolVersions as Record<string, unknown> | undefined;
  const compatibleCached = cached?.suiteVersion === COMPACT_QUALIFICATION_SUITE_VERSION && cached.qualificationState === "HARD_FAILURE"
    || cached?.suiteVersion === ROLE_QUALIFICATION_SUITE_VERSION && protocols?.REVIEWER === REVIEWER_PROTOCOL.version && protocols.EXPLORER === EXPLORER_PROTOCOL.version;
  if (compatibleCached && cached?.providerId === authority.providerId && cached.modelId === model.modelId && !cached.metadata?.transient && cachedAge >= 0 && cachedAge < 6 * 3_600_000) return cached;
  const binding: PersonalAccountBinding = { ownerUserId: authority.ownerUserId, connectionId: authority.connectionId, canonicalProviderId: authority.providerId,
    credentialRef: authority.credentialRef, modelId: model.modelId, pricing: { inputCostPerMillion: model.pricing.inputCostPerMillion,
      outputCostPerMillion: model.pricing.outputCostPerMillion, currency: model.pricing.currency, confidence: model.pricing.confidence, source: model.pricing.source } };
  let requests = 0;
  let policyInterrupted = false;
  const reserve = async (request: ChatRequest): Promise<{ request: ChatRequest; hold: PersonalAccountReservation }> => {
    options.assertCurrent();
    if (options.signal?.aborted || requests >= 24) { policyInterrupted = true; throw new Error("R41_BOUND: paid qualification budget ended"); }
    if (request.model !== model.modelId || request.fallbackModels?.some(id => id !== model.modelId)) throw new Error("EXACT_PAID_MODEL_REQUIRED");
    const stamped: ChatRequest = { ...request, metadata: { personalAccountOwnerUserId: authority.ownerUserId, personalAccountConnectionId: authority.connectionId,
      personalAccountWorkspacePath: options.workspacePath, personalAccountRequestId: `personal-qualification-${randomUUID()}`, personalAccountPurpose: "QUALIFICATION" } };
    let hold: PersonalAccountReservation;
    try { hold = await options.reserve(binding, stamped); } catch (error) { policyInterrupted = true; throw error; }
    requests++;
    return { request: stamped, hold };
  };
  const bounded: ProviderAdapter = { providerId: authority.providerId, listModels: () => transport.listModels(), healthCheck: () => transport.healthCheck(),
    async chat(request) {
      const reserved = await reserve(request);
      let usage: Usage | undefined;
      try {
        options.assertCurrent();
        try { await reserved.hold.dispatch(); } catch (error) { policyInterrupted = true; throw error; }
        const response = await transport.chat(reserved.request);
        usage = response.usage;
        options.assertCurrent();
        if (response.model !== model.modelId) throw new ProviderError("Qualification served-model identity is unverified", response.model ? "MODEL_SUBSTITUTED" : "MODEL_IDENTITY_MISSING", true);
        if (!response.choices.length) throw new ProviderError("Qualification returned no usable completion choices", "EMPTY_COMPLETION", true);
        try { await reserved.hold.settle(response.usage); } catch (error) { policyInterrupted = true; throw error; }
        return response;
      } catch (error) { await reserved.hold.fail(error, usage ?? (error instanceof ProviderError ? error.observedUsage : undefined)); throw error; }
    },
    async *streamChat(request, signal) {
      const reserved = await reserve(request);
      let usage: Usage | undefined;
      try {
        options.assertCurrent();
        try { await reserved.hold.dispatch(); } catch (error) { policyInterrupted = true; throw error; }
        const frames: StreamEvent[] = [];
        let finish: Extract<StreamEvent, { type: "finish" }> | undefined;
        for await (const frame of transport.streamChat(reserved.request, signal)) {
          if (frame.type === "usage") usage = frame.usage;
          options.assertCurrent();
          if (finish && frame.type !== "usage") throw new ProviderError("Qualification provider stream interrupted", "STREAM_INTERRUPTED", true);
          if (frame.type === "finish") {
            if (frame.model !== model.modelId) throw new ProviderError("Qualification served-model identity is unverified", frame.model ? "MODEL_SUBSTITUTED" : "MODEL_IDENTITY_MISSING", true);
            if (finish || frame.finishReason === "error" || frame.finishReason === "content_filter") throw new ProviderError("Qualification provider stream interrupted", "STREAM_INTERRUPTED", true);
            finish = frame;
          }
          if (frame.type === "error") {
            const category = frame.status === 429 || frame.code === "RATE_LIMITED" || frame.code === "429" ? "rate limit 429"
              : frame.status === 401 || frame.status === 403 || frame.code === "AUTH_REQUIRED" || frame.code === "UNAUTHORIZED" ? "authentication rejected 401"
              : frame.status && frame.status >= 500 ? `HTTP ${frame.status}`
              : frame.code === "TIMEOUT" || frame.code === "STREAM_INTERRUPTED" ? "timed out or interrupted"
              : frame.code === "EMPTY_COMPLETION" ? "no usable completion choices" : "request failed";
            throw new ProviderError(`Qualification provider ${category}`, frame.code, frame.retryable, { status: frame.status, retryAfter: frame.retryAfter, rateLimitScope: frame.rateLimitScope });
          }
          frames.push(frame);
        }
        options.assertCurrent();
        if (!finish || signal?.aborted || options.signal?.aborted) throw new ProviderError("Qualification provider timed out or interrupted", "STREAM_INTERRUPTED", true);
        try { await reserved.hold.settle(usage); } catch (error) { policyInterrupted = true; throw error; }
        for (const frame of frames) yield frame;
      } catch (error) { await reserved.hold.fail(error, usage ?? (error instanceof ProviderError ? error.observedUsage : undefined)); throw error; }
    } };
  const record = createGenericFreeRecord({ providerId: authority.providerId, modelId: model.modelId, displayName: model.displayName,
    freeStatus: "paid", tier: "paid", accessClass: "PAID", supplyClass: "BYOK_PAID", capabilities: model.capabilities,
    contextWindow: model.contextWindow ?? 4_096, costProfile: { isFree: false, inputCostPerMillion: model.pricing.inputCostPerMillion,
      outputCostPerMillion: model.pricing.outputCostPerMillion, paidFallbackPossible: false, paidFallbackDisabled: true, source: model.pricing.source } });
  const measured = await (options.runQualification ?? runRoleAwareQualification)(record, bounded, { roles: ["EXPLORER", "REVIEWER"], signal: options.signal ?? AbortSignal.timeout(360_000) });
  options.assertCurrent();
  if (measured.providerId !== authority.providerId || measured.modelId !== model.modelId) throw new Error("QUALIFICATION_RECEIPT_IDENTITY_MISMATCH");
  const receipt: ModelQualificationReceipt = { ...measured, freeStatus: "paid", metadata: { ...measured.metadata, personalQualification: true,
    qualificationPurpose: "USER_AUTHORIZED_PAID", requests, ...(policyInterrupted ? { transient: true, qualificationAdmissionInterrupted: true } : {}) } };
  await options.recordReceipt(receipt);
  return receipt;
}
