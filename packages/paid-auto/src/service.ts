import crypto from "node:crypto";
import {
  createAlibabaAdapter,
  createDeepSeekAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
  createZaiAdapter,
  EnvironmentCredentialStore,
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type CredentialStore,
  type ProviderAdapter,
  type ProviderHealthResponse,
  type ProviderModel,
  type StreamEvent,
} from "@codeforge/providers";
import {
  PAID_AUTO_MODELS,
  paidAutoModel,
  paidAutoProviderModel,
  type PaidAutoCanonicalModelId,
  type PaidAutoModel,
  type PaidAutoRoute,
  type PaidAutoRouteId,
} from "./registry.js";

export const PAID_AUTO_PROVIDER_ID = "paid-auto";

export type PaidAutoState =
  | "NOT_CONFIGURED"
  | "CONFIGURED_UNVERIFIED"
  | "READY"
  | "BILLING_REQUIRED"
  | "AUTHORIZATION_REQUIRED"
  | "POLICY_REVIEW_REQUIRED"
  | "CERTIFICATION_REQUIRED"
  | "TEMPORARILY_UNAVAILABLE"
  | "QUARANTINED"
  | "DISABLED";

export type PaidAutoFailureClass =
  | "connection_failure"
  | "provider_outage"
  | "capacity"
  | "auth_failure"
  | "billing_required"
  | "invalid_request"
  | "policy_rejection"
  | "unsupported_capability"
  | "context_overflow"
  | "partial_stream"
  | "cancelled"
  | "ambiguous_execution"
  | "unknown_failure";

export type PaidAutoExecutionCertainty = "not_started" | "no_output" | "partial_output" | "completed" | "ambiguous";
export type PaidAutoQualificationValue = "verified" | "unknown" | "ineligible";

export interface PaidAutoRouteQualification {
  state?: PaidAutoState;
  commercialEligibility?: PaidAutoQualificationValue;
  privacy?: PaidAutoQualificationValue;
  capabilityParity?: PaidAutoQualificationValue;
  certification?: "CERTIFIED" | "NOT_CERTIFIED";
}

export interface PaidAutoServiceOptions {
  credentialStore?: CredentialStore;
  adapters?: Partial<Record<PaidAutoRoute["providerId"], ProviderAdapter>>;
  paidExecutionEnabled?: boolean;
  openRouterFallbackEnabled?: boolean;
  routeQualifications?: Partial<Record<PaidAutoRouteId, PaidAutoRouteQualification>>;
  now?: () => number;
  onTelemetry?: (record: PaidAutoAttemptRecord) => void;
}

export interface PaidAutoAttemptRecord {
  logicalRequestId: string;
  attemptId: string;
  canonicalModelId: PaidAutoCanonicalModelId;
  routeId: PaidAutoRouteId;
  providerId: PaidAutoRoute["providerId"];
  providerModelId: string;
  outcome: "success" | "failure";
  failureClass?: PaidAutoFailureClass;
  executionCertainty: PaidAutoExecutionCertainty;
  startedAt: number;
  completedAt: number;
}

export interface PaidAutoModelView {
  id: PaidAutoCanonicalModelId;
  canonicalId: PaidAutoCanonicalModelId;
  providerId: typeof PAID_AUTO_PROVIDER_ID;
  displayName: string;
  tier: "paid-auto";
  freeStatus: "paid";
  accessClass: "PAID";
  state: PaidAutoState;
  available: boolean;
  unavailableReason?: string;
  directProviderId: PaidAutoRoute["providerId"];
  directModelId: string;
  openRouterSlug: string;
  verification: PaidAutoModel["verification"];
  contextWindow: number;
  maxOutput: number;
  capabilities: PaidAutoModel["capabilities"];
  costProfile: {
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
    isFree: boolean;
    paidFallbackPossible: boolean;
  };
}

export interface PaidAutoRuntimeModel {
  providerId: typeof PAID_AUTO_PROVIDER_ID;
  modelId: PaidAutoCanonicalModelId;
  displayName: string;
  freeStatus: "paid";
  tier: "paid";
  contextWindow: number;
  capabilities: PaidAutoModel["capabilities"];
  costProfile: {
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
    isFree: boolean;
    paidFallbackPossible: boolean;
    paidFallbackDisabled: boolean;
    source: string;
  };
  isRemote: true;
  isCloudHosted: false;
}

export class PaidAutoExecutionError extends Error {
  readonly code: string;
  readonly failureClass: PaidAutoFailureClass;
  readonly executionCertainty: PaidAutoExecutionCertainty;
  readonly retryable: boolean;
  readonly routeId?: PaidAutoRouteId;

  constructor(options: {
    code: string;
    message: string;
    failureClass: PaidAutoFailureClass;
    executionCertainty: PaidAutoExecutionCertainty;
    retryable?: boolean;
    routeId?: PaidAutoRouteId;
  }) {
    super(options.message);
    this.name = "PaidAutoExecutionError";
    this.code = options.code;
    this.failureClass = options.failureClass;
    this.executionCertainty = options.executionCertainty;
    this.retryable = options.retryable ?? false;
    this.routeId = options.routeId;
  }
}

export class PaidAutoOpenRouterAdapter implements ProviderAdapter {
  readonly providerId = "openrouter";
  private readonly upstream: ProviderAdapter;

  constructor(upstream: ProviderAdapter) {
    this.upstream = upstream;
  }

  async listModels(): Promise<ProviderModel[]> {
    return PAID_AUTO_MODELS.map((model) => ({ ...paidAutoProviderModel(model), modelId: model.fallback.providerModelId }));
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    const route = this.routeFor(req.model);
    return this.upstream.chat(this.toUpstreamRequest(req, route));
  }

  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const route = this.routeFor(req.model);
    return this.upstream.streamChat(this.toUpstreamRequest(req, route), signal);
  }

  healthCheck(): Promise<ProviderHealthResponse> {
    return this.upstream.healthCheck();
  }

  canRoute(modelId: string): boolean {
    return PAID_AUTO_MODELS.some((model) => model.canonicalModelId === modelId);
  }

  private routeFor(modelId: string): PaidAutoRoute {
    const model = paidAutoModel(modelId);
    if (!model) {
      throw new PaidAutoExecutionError({
        code: "MODEL_NOT_FOUND",
        message: "Paid Auto accepts only one of the four registered canonical model IDs.",
        failureClass: "invalid_request",
        executionCertainty: "not_started",
      });
    }
    return model.fallback;
  }

  private toUpstreamRequest(req: ChatRequest, route: PaidAutoRoute): ChatRequest {
    const { fallbackModels: _fallbackModels, ...withoutFallback } = req;
    return { ...withoutFallback, model: route.providerModelId };
  }
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

const FALLBACK_FAILURES = new Set<PaidAutoFailureClass>([
  "connection_failure",
  "provider_outage",
  "capacity",
]);

export function classifyPaidAutoFailure(error: unknown): PaidAutoFailureClass {
  if (error instanceof PaidAutoExecutionError) return error.failureClass;
  if (error instanceof ProviderError) {
    if (error.code === "MISSING_API_KEY" || error.code === "AUTH_ERROR") return "auth_failure";
    if (error.code === "PAYMENT_REQUIRED") return "billing_required";
    if (error.code === "MODEL_NOT_FOUND" || error.code === "INVALID_REQUEST") return "invalid_request";
    if (error.code === "RATE_LIMITED" || error.code === "429" || error.status === 429) return "capacity";
    if (typeof error.code === "string" && /^5\d\d$/.test(error.code)) return "provider_outage";
    if (error.status !== undefined && error.status >= 500) return "provider_outage";
    if (error.code === "CONTEXT_LENGTH_EXCEEDED" || error.code === "CONTEXT_OVERFLOW") return "context_overflow";
    if (error.code === "UNSUPPORTED_PARAMETER" || error.code === "UNSUPPORTED_CAPABILITY") return "unsupported_capability";
    if (error.code === "TIMEOUT") return "ambiguous_execution";
    if (error.code === "CHAT_FAILED" || error.code === "STREAM_FAILED" || error.code === "CONNECTION_FAILED") return "connection_failure";
    if (error.code === "POLICY_REJECTED" || error.code === "POLICY_REVIEW_REQUIRED") return "policy_rejection";
  }
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "unknown_failure";
}

export class PaidAutoService {
  private readonly credentialStore: CredentialStore;
  private readonly adapters: Record<PaidAutoRoute["providerId"], ProviderAdapter>;
  private readonly paidExecutionEnabled: boolean;
  private readonly openRouterFallbackEnabled: boolean;
  private readonly routeQualifications: Partial<Record<PaidAutoRouteId, PaidAutoRouteQualification>>;
  private readonly now: () => number;
  private readonly onTelemetry?: (record: PaidAutoAttemptRecord) => void;
  private readonly circuits = new Map<PaidAutoRouteId, CircuitState>();
  private readonly telemetry: PaidAutoAttemptRecord[] = [];

  constructor(options: PaidAutoServiceOptions = {}) {
    this.credentialStore = options.credentialStore ?? new EnvironmentCredentialStore();
    this.adapters = {
      openai: options.adapters?.openai ?? createOpenAIAdapter({ credentialStore: this.credentialStore }),
      zai: options.adapters?.zai ?? createZaiAdapter({ credentialStore: this.credentialStore }),
      alibaba: options.adapters?.alibaba ?? createAlibabaAdapter({ credentialStore: this.credentialStore }),
      deepseek: options.adapters?.deepseek ?? createDeepSeekAdapter({ credentialStore: this.credentialStore }),
      openrouter: options.adapters?.openrouter ?? new PaidAutoOpenRouterAdapter(createOpenRouterAdapter({ credentialStore: this.credentialStore })),
    };
    this.paidExecutionEnabled = options.paidExecutionEnabled ?? false;
    this.openRouterFallbackEnabled = options.openRouterFallbackEnabled ?? false;
    this.routeQualifications = options.routeQualifications ?? {};
    this.now = options.now ?? Date.now;
    this.onTelemetry = options.onTelemetry;
  }

  get executionEnabled(): boolean {
    return this.paidExecutionEnabled;
  }

  get openRouterFallback(): boolean {
    return this.openRouterFallbackEnabled;
  }

  hasExecutableRoute(): boolean {
    return this.modelViews().some((model) => model.available);
  }

  getModel(canonicalModelId: string): PaidAutoModel | undefined {
    return paidAutoModel(canonicalModelId);
  }

  models(): readonly PaidAutoModel[] {
    return PAID_AUTO_MODELS;
  }

  modelViews(): PaidAutoModelView[] {
    return PAID_AUTO_MODELS.map((model) => {
      const state = this.stateFor(model.direct);
      return {
        id: model.canonicalModelId,
        canonicalId: model.canonicalModelId,
        providerId: PAID_AUTO_PROVIDER_ID,
        displayName: model.displayName,
        tier: "paid-auto",
        freeStatus: "paid",
        accessClass: "PAID",
        state,
        available: this.routeCanExecute(model.direct),
        ...(state !== "READY" ? { unavailableReason: this.stateReason(state) } : {}),
        directProviderId: model.direct.providerId,
        directModelId: model.direct.providerModelId,
        openRouterSlug: model.fallback.providerModelId,
        verification: model.verification,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        capabilities: model.capabilities,
        costProfile: {
          inputCostPerMillion: model.direct.pricing.inputCostPerMillion,
          outputCostPerMillion: model.direct.pricing.outputCostPerMillion,
          isFree: false,
          paidFallbackPossible: this.openRouterFallbackEnabled && this.routeCanExecute(model.fallback),
        },
      };
    });
  }

  runtimeModel(canonicalModelId: string): PaidAutoRuntimeModel | undefined {
    const model = paidAutoModel(canonicalModelId);
    if (!model) return undefined;
    return {
      providerId: PAID_AUTO_PROVIDER_ID,
      modelId: model.canonicalModelId,
      displayName: model.displayName,
      freeStatus: "paid",
      tier: "paid",
      contextWindow: model.contextWindow,
      capabilities: model.capabilities,
      costProfile: {
        inputCostPerMillion: model.direct.pricing.inputCostPerMillion,
        outputCostPerMillion: model.direct.pricing.outputCostPerMillion,
        isFree: false,
        paidFallbackPossible: this.openRouterFallbackEnabled && this.routeCanExecute(model.fallback),
        paidFallbackDisabled: !this.openRouterFallbackEnabled,
        source: model.direct.pricing.source,
      },
      isRemote: true,
      isCloudHosted: false,
    };
  }

  state(canonicalModelId: string): PaidAutoState | undefined {
    const model = paidAutoModel(canonicalModelId);
    return model ? this.stateFor(model.direct) : undefined;
  }

  attempts(): readonly PaidAutoAttemptRecord[] {
    return this.telemetry;
  }

  asProviderAdapter(): PaidAutoProviderAdapter {
    return new PaidAutoProviderAdapter(this);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = this.requireModel(req.model);
    const logicalRequestId = this.logicalRequestId(req);
    const direct = this.requireDirectRoute(model);
    try {
      const response = await this.callChat(direct, req, logicalRequestId);
      this.recordSuccess(logicalRequestId, direct);
      return response;
    } catch (error) {
      const classified = this.executionError(error, direct.routeId, "no_output");
      this.recordFailure(logicalRequestId, direct, classified);
      if (!this.shouldFallback(classified, direct)) throw classified;
      const fallback = this.requireFallbackRoute(model);
      const response = await this.callChat(fallback, req, logicalRequestId);
      this.recordSuccess(logicalRequestId, fallback);
      return response;
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const model = this.requireModel(req.model);
    const logicalRequestId = this.logicalRequestId(req);
    const direct = this.requireDirectRoute(model);
    let emittedOutput = false;
    let usableOutput = false;
    let finishEvent: Extract<StreamEvent, { type: "finish" }> | undefined;
    let finished = false;
    try {
      for await (const event of this.callStream(direct, req, signal)) {
        if (event.type === "error") {
          const eventError = new PaidAutoExecutionError({
            code: event.code,
            message: event.message,
            failureClass: classifyPaidAutoFailure(new ProviderError(event.message, event.code, event.retryable)),
            executionCertainty: emittedOutput ? "partial_output" : "no_output",
            retryable: event.retryable,
            routeId: direct.routeId,
          });
          if (emittedOutput) throw eventError;
          throw eventError;
        }
        if (event.type === "finish") {
          finished = true;
          finishEvent = event;
          if (event.finishReason === "error") {
            throw new PaidAutoExecutionError({ code: "STREAM_ERROR", message: "Provider terminated the stream with an error.", failureClass: "partial_stream", executionCertainty: emittedOutput ? "partial_output" : "no_output", routeId: direct.routeId });
          }
          continue;
        }
        if (event.type === "text_delta" && event.delta.length > 0) {
          emittedOutput = true;
          usableOutput = true;
        }
        if (event.type === "tool_call_started" || event.type === "tool_call_delta" || event.type === "tool_call_completed") {
          emittedOutput = true;
          usableOutput = true;
        }
        yield event;
      }
      if (!finished) {
        throw new PaidAutoExecutionError({ code: "PARTIAL_STREAM", message: "Provider stream ended without a terminal finish event.", failureClass: "partial_stream", executionCertainty: emittedOutput ? "partial_output" : "no_output", routeId: direct.routeId });
      }
      if (!usableOutput) {
        throw new PaidAutoExecutionError({ code: "EMPTY_COMPLETION", message: "Provider returned no usable stream output.", failureClass: "provider_outage", executionCertainty: "no_output", retryable: true, routeId: direct.routeId });
      }
      if (finishEvent) yield finishEvent;
      this.recordSuccess(logicalRequestId, direct);
    } catch (error) {
      if (signal?.aborted) throw new PaidAutoExecutionError({ code: "CANCELLED", message: "Paid Auto request was cancelled.", failureClass: "cancelled", executionCertainty: emittedOutput ? "partial_output" : "ambiguous", routeId: direct.routeId });
      const classified = this.executionError(error, direct.routeId, emittedOutput ? "partial_output" : "no_output");
      this.recordFailure(logicalRequestId, direct, classified);
      if (!emittedOutput && this.shouldFallback(classified, direct)) {
        const fallback = this.requireFallbackRoute(model);
        yield* this.streamFallback(fallback, req, signal, logicalRequestId);
        return;
      }
      throw classified;
    }
  }

  healthCheck(): ProviderHealthResponse {
    if (!this.paidExecutionEnabled) return { status: "offline", error: "Paid Auto execution is disabled by the server kill switch." };
    const states = PAID_AUTO_MODELS.map((model) => this.stateFor(model.direct));
    if (states.some((state) => state === "READY")) return { status: "available" };
    if (states.some((state) => state === "TEMPORARILY_UNAVAILABLE" || state === "QUARANTINED")) return { status: "degraded" };
    if (states.some((state) => state === "AUTHORIZATION_REQUIRED" || state === "BILLING_REQUIRED")) return { status: "auth_required" };
    return { status: "unknown", error: "Paid Auto has no certified executable route." };
  }

  private async *streamFallback(route: PaidAutoRoute, req: ChatRequest, signal: AbortSignal | undefined, logicalRequestId: string): AsyncIterable<StreamEvent> {
    let emittedOutput = false;
    let usableOutput = false;
    let finishEvent: Extract<StreamEvent, { type: "finish" }> | undefined;
    let finished = false;
    try {
      for await (const event of this.callStream(route, req, signal)) {
        if (event.type === "error") {
          throw new PaidAutoExecutionError({ code: event.code, message: event.message, failureClass: classifyPaidAutoFailure(new ProviderError(event.message, event.code, event.retryable)), executionCertainty: emittedOutput ? "partial_output" : "no_output", retryable: event.retryable, routeId: route.routeId });
        }
        if (event.type === "finish") {
          finished = true;
          finishEvent = event;
          if (event.finishReason === "error") throw new PaidAutoExecutionError({ code: "STREAM_ERROR", message: "Fallback provider terminated the stream with an error.", failureClass: "partial_stream", executionCertainty: emittedOutput ? "partial_output" : "no_output", routeId: route.routeId });
          continue;
        }
        if (event.type === "text_delta" && event.delta.length > 0) {
          emittedOutput = true;
          usableOutput = true;
        }
        if (event.type === "tool_call_started" || event.type === "tool_call_delta" || event.type === "tool_call_completed") {
          emittedOutput = true;
          usableOutput = true;
        }
        yield event;
      }
      if (!finished) throw new PaidAutoExecutionError({ code: "PARTIAL_STREAM", message: "Fallback provider stream ended without a terminal finish event.", failureClass: "partial_stream", executionCertainty: emittedOutput ? "partial_output" : "no_output", routeId: route.routeId });
      if (!usableOutput) throw new PaidAutoExecutionError({ code: "EMPTY_COMPLETION", message: "Fallback provider returned no usable stream output.", failureClass: "provider_outage", executionCertainty: "no_output", retryable: true, routeId: route.routeId });
      if (finishEvent) yield finishEvent;
      this.recordSuccess(logicalRequestId, route);
    } catch (error) {
      const classified = this.executionError(error, route.routeId, emittedOutput ? "partial_output" : "no_output");
      this.recordFailure(logicalRequestId, route, classified);
      throw classified;
    }
  }

  private async callChat(route: PaidAutoRoute, req: ChatRequest, _logicalRequestId: string): Promise<ChatResponse> {
    const response = await this.adapters[route.providerId].chat(this.requestFor(route, req));
    if (!Array.isArray(response.choices) || response.choices.length === 0) {
      throw new PaidAutoExecutionError({ code: "EMPTY_COMPLETION", message: "Provider returned no usable completion choices.", failureClass: "provider_outage", executionCertainty: "no_output", retryable: true, routeId: route.routeId });
    }
    return response;
  }

  private callStream(route: PaidAutoRoute, req: ChatRequest, signal: AbortSignal | undefined): AsyncIterable<StreamEvent> {
    return this.adapters[route.providerId].streamChat(this.requestFor(route, req), signal);
  }

  private requestFor(route: PaidAutoRoute, req: ChatRequest): ChatRequest {
    const { fallbackModels: _fallbackModels, ...withoutFallback } = req;
    return { ...withoutFallback, model: route.providerModelId };
  }

  private requireModel(canonicalModelId: string): PaidAutoModel {
    const model = paidAutoModel(canonicalModelId);
    if (!model) throw new PaidAutoExecutionError({ code: "MODEL_NOT_FOUND", message: "Paid Auto accepts only its four registered canonical models.", failureClass: "invalid_request", executionCertainty: "not_started" });
    return model;
  }

  private requireDirectRoute(model: PaidAutoModel): PaidAutoRoute {
    if (!this.routeCanExecute(model.direct)) {
      const state = this.stateFor(model.direct);
      const failureClass = state === "BILLING_REQUIRED" ? "billing_required" : state === "AUTHORIZATION_REQUIRED" || state === "POLICY_REVIEW_REQUIRED" ? "policy_rejection" : "unknown_failure";
      throw new PaidAutoExecutionError({ code: `PAID_AUTO_${state}`, message: this.stateReason(state), failureClass, executionCertainty: "not_started", routeId: model.direct.routeId });
    }
    return model.direct;
  }

  private requireFallbackRoute(model: PaidAutoModel): PaidAutoRoute {
    if (!this.openRouterFallbackEnabled) throw new PaidAutoExecutionError({ code: "OPENROUTER_FALLBACK_DISABLED", message: "OpenRouter fallback is disabled by policy.", failureClass: "policy_rejection", executionCertainty: "no_output" });
    if (!this.routeCanExecute(model.fallback)) {
      const state = this.stateFor(model.fallback);
      throw new PaidAutoExecutionError({ code: `PAID_AUTO_${state}`, message: this.stateReason(state), failureClass: "policy_rejection", executionCertainty: "no_output", routeId: model.fallback.routeId });
    }
    return model.fallback;
  }

  private routeCanExecute(route: PaidAutoRoute): boolean {
    if (!this.paidExecutionEnabled) return false;
    if (this.stateFor(route) !== "READY") return false;
    const qualification = this.qualificationFor(route);
    if (qualification.commercialEligibility !== "verified" || qualification.privacy !== "verified" || qualification.capabilityParity !== "verified" || qualification.certification !== "CERTIFIED") return false;
    if (this.isCircuitOpen(route)) return false;
    return true;
  }

  private stateFor(route: PaidAutoRoute): PaidAutoState {
    if (!this.paidExecutionEnabled) return "DISABLED";
    const explicitState = this.routeQualifications[route.routeId]?.state;
    const state = explicitState ?? (route.providerId === "alibaba"
      ? "AUTHORIZATION_REQUIRED"
      : this.hasCredential(route.providerId) ? "CONFIGURED_UNVERIFIED" : "NOT_CONFIGURED");
    return state === "READY" && this.isCircuitOpen(route) ? "TEMPORARILY_UNAVAILABLE" : state;
  }

  private qualificationFor(route: PaidAutoRoute): Required<PaidAutoRouteQualification> {
    const qualification = this.routeQualifications[route.routeId] ?? {};
    return {
      state: qualification.state ?? "CONFIGURED_UNVERIFIED",
      commercialEligibility: qualification.commercialEligibility ?? "unknown",
      privacy: qualification.privacy ?? "unknown",
      capabilityParity: qualification.capabilityParity ?? "unknown",
      certification: qualification.certification ?? "NOT_CERTIFIED",
    };
  }

  private hasCredential(providerId: PaidAutoRoute["providerId"]): boolean {
    if (providerId === "alibaba") return this.credentialStore.has("DASHSCOPE_API_KEY") || Boolean(this.credentialStore.get("DASHSCOPE_API_KEY"));
    return this.credentialStore.has(providerId);
  }

  private stateReason(state: PaidAutoState): string {
    switch (state) {
      case "DISABLED": return "Paid Auto execution is disabled by the server kill switch.";
      case "NOT_CONFIGURED": return "The provider credential is not configured.";
      case "AUTHORIZATION_REQUIRED": return "Provider authorization or Alibaba Model Studio KYC is required.";
      case "BILLING_REQUIRED": return "A provider billing setup is required.";
      case "POLICY_REVIEW_REQUIRED": return "The route requires privacy and policy review.";
      case "CERTIFICATION_REQUIRED": return "The route has not completed CodeForge certification.";
      case "TEMPORARILY_UNAVAILABLE": return "The route is temporarily unavailable.";
      case "QUARANTINED": return "The route is quarantined pending review.";
      case "CONFIGURED_UNVERIFIED": return "The provider is configured but the route is not verified.";
      case "READY": return "Ready";
    }
  }

  private logicalRequestId(req: ChatRequest): string {
    const value = req.metadata?.logicalRequestId;
    return typeof value === "string" && value.length > 0 ? value : crypto.randomUUID();
  }

  private shouldFallback(error: PaidAutoExecutionError, direct: PaidAutoRoute): boolean {
    return this.openRouterFallbackEnabled && direct.kind === "direct" && error.executionCertainty === "no_output" && FALLBACK_FAILURES.has(error.failureClass);
  }

  private executionError(error: unknown, routeId: PaidAutoRouteId, certainty: PaidAutoExecutionCertainty): PaidAutoExecutionError {
    if (error instanceof PaidAutoExecutionError) {
      if (error.routeId === routeId && error.executionCertainty === certainty) return error;
      return new PaidAutoExecutionError({ code: error.code, message: error.message, failureClass: error.failureClass, executionCertainty: certainty, retryable: error.retryable, routeId });
    }
    const failureClass = classifyPaidAutoFailure(error);
    return new PaidAutoExecutionError({ code: error instanceof ProviderError ? error.code ?? "PROVIDER_ERROR" : "PROVIDER_ERROR", message: error instanceof Error ? error.message : "Paid Auto provider request failed.", failureClass, executionCertainty: failureClass === "cancelled" ? "ambiguous" : certainty, retryable: error instanceof ProviderError ? error.retryable : false, routeId });
  }

  private recordSuccess(logicalRequestId: string, route: PaidAutoRoute): void {
    this.circuits.delete(route.routeId);
    this.recordTelemetry({ logicalRequestId, attemptId: crypto.randomUUID(), canonicalModelId: route.canonicalModelId, routeId: route.routeId, providerId: route.providerId, providerModelId: route.providerModelId, outcome: "success", executionCertainty: "completed", startedAt: this.now(), completedAt: this.now() });
  }

  private recordFailure(logicalRequestId: string, route: PaidAutoRoute, error: PaidAutoExecutionError): void {
    if (FALLBACK_FAILURES.has(error.failureClass)) {
      const current = this.circuits.get(route.routeId) ?? { failures: 0, openUntil: 0 };
      const failures = current.failures + 1;
      const cooldownMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 5));
      this.circuits.set(route.routeId, { failures, openUntil: this.now() + cooldownMs });
    }
    this.recordTelemetry({ logicalRequestId, attemptId: crypto.randomUUID(), canonicalModelId: route.canonicalModelId, routeId: route.routeId, providerId: route.providerId, providerModelId: route.providerModelId, outcome: "failure", failureClass: error.failureClass, executionCertainty: error.executionCertainty, startedAt: this.now(), completedAt: this.now() });
  }

  private recordTelemetry(record: PaidAutoAttemptRecord): void {
    this.telemetry.push(record);
    this.onTelemetry?.(record);
  }

  private isCircuitOpen(route: PaidAutoRoute): boolean {
    const state = this.circuits.get(route.routeId);
    return Boolean(state && state.openUntil > this.now());
  }
}

export class PaidAutoProviderAdapter implements ProviderAdapter {
  readonly providerId = PAID_AUTO_PROVIDER_ID;
  private readonly service: PaidAutoService;

  constructor(service: PaidAutoService) {
    this.service = service;
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.service.models().map(paidAutoProviderModel);
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.service.chat(req);
  }

  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    return this.service.streamChat(req, signal);
  }

  healthCheck(): Promise<ProviderHealthResponse> {
    return Promise.resolve(this.service.healthCheck());
  }

  canRoute(modelId: string): boolean {
    const model = this.service.getModel(modelId);
    if (!model) return false;
    return this.service.modelViews().some((view) => view.id === model.canonicalModelId && view.available);
  }
}

export function createPaidAutoService(options: PaidAutoServiceOptions = {}): PaidAutoService {
  return new PaidAutoService(options);
}
