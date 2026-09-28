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
  paidAutoProviderModel,
  type PaidAutoCanonicalModelId,
  type PaidAutoModel,
  type PaidAutoRoute,
  type PaidAutoRouteId,
} from "./registry.js";
import { rank16Bit, type SixteenBitEvidenceMap, type SixteenBitRankOptions, type SixteenBitRanking, type SixteenBitRoleQualification, type SixteenBitTaskProfile } from "./expected-cost.js";
import { PAID_ROLE_EVIDENCE_MAX_AGE_MS, PaidRoleEvidenceBook, type PaidRoleVerdict } from "./role-router.js";
import { PaidFamilyCatalog, type PaidFamilyVersion } from "./families.js";

export const PAID_AUTO_PROVIDER_ID = "paid-auto";

/**
 * R55 wave 2: cost-mode preference for role-route ordering. Structurally identical to
 * ManagedPaidPolicy.costMode in @codeforge/cloud-usage — kept structural so paid-auto
 * never imports the accounting package. Ranking policy only: it can reorder candidates
 * that already passed qualification, price, and authorization gates; it can never expand
 * the admissible set.
 */
export type PaidRoleCostMode = "CHEAPEST" | "BALANCED" | "MAXIMUM_INTELLIGENCE" | "CUSTOM";

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
  familyCatalog?: PaidFamilyCatalog;
  credentialStore?: CredentialStore;
  adapters?: Partial<Record<PaidAutoRoute["providerId"], ProviderAdapter>>;
  paidExecutionEnabled?: boolean;
  openRouterFallbackEnabled?: boolean;
  routeQualifications?: Partial<Record<PaidAutoRouteId, PaidAutoRouteQualification>>;
  /** R48: seed the per-role verdict book — e.g. from persisted qualification receipts. */
  roleVerdicts?: readonly PaidRoleVerdict[];
  /** R48: verdict freshness window; defaults to 30 days like the free fleet's receipts. */
  roleEvidenceMaxAgeMs?: number;
  now?: () => number;
  onTelemetry?: (record: PaidAutoAttemptRecord) => void;
}

/** R48: one ordered admissible candidate for a role request — rank order already encodes the
 *  qualification floor (measured QUALIFIED > PROBATION > unmeasured) and expected completion
 *  cost; `route` is the route that would actually execute (direct, or the OpenRouter fallback
 *  when direct is credential-absent). */
export interface PaidRoleRouteCandidate {
  canonicalModelId: PaidAutoCanonicalModelId;
  route: PaidAutoRoute;
  roleStatus: SixteenBitRoleQualification;
  expectedCostUsd: number;
  reasonCodes: string[];
}

export type PaidRoleRouteOutcome =
  | "selected"
  | "no_qualified_role_route"
  | "no_admissible_route"
  | "no_executable_route";

export interface PaidRoleRouteSelection {
  outcome: PaidRoleRouteOutcome;
  role: string;
  /** The head of `orderedCandidates` — the route this role should dispatch on now. */
  selected?: PaidRoleRouteCandidate;
  /** Bounded rotation order for failover — every admissible candidate with an executable
   *  route right now, best first. Empty when the outcome carries no selection. */
  orderedCandidates: PaidRoleRouteCandidate[];
  ranking: SixteenBitRanking;
  reasonCodes: string[];
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

  constructor(upstream: ProviderAdapter, private readonly catalog: PaidFamilyCatalog = new PaidFamilyCatalog()) {
    this.upstream = upstream;
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.catalog.activeModels().map((model) => ({ ...paidAutoProviderModel(model), modelId: model.fallback.providerModelId }));
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
    return this.catalog.activeModels().some((model) => model.canonicalModelId === modelId);
  }

  private routeFor(modelId: string): PaidAutoRoute {
    const model = this.catalog.model(modelId);
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
  private readonly familyCatalog: PaidFamilyCatalog;
  private readonly credentialStore: CredentialStore;
  private readonly adapters: Record<PaidAutoRoute["providerId"], ProviderAdapter>;
  private readonly paidExecutionEnabled: boolean;
  private readonly openRouterFallbackEnabled: boolean;
  private readonly routeQualifications: Partial<Record<PaidAutoRouteId, PaidAutoRouteQualification>>;
  private readonly now: () => number;
  private readonly onTelemetry?: (record: PaidAutoAttemptRecord) => void;
  private readonly circuits = new Map<PaidAutoRouteId, CircuitState>();
  private readonly telemetry: PaidAutoAttemptRecord[] = [];
  private readonly roleEvidence: PaidRoleEvidenceBook;
  private readonly roleEvidenceMaxAgeMs: number;

  constructor(options: PaidAutoServiceOptions = {}) {
    this.familyCatalog = options.familyCatalog ?? new PaidFamilyCatalog();
    this.credentialStore = options.credentialStore ?? new EnvironmentCredentialStore();
    this.adapters = {
      openai: options.adapters?.openai ?? createOpenAIAdapter({ credentialStore: this.credentialStore }),
      zai: options.adapters?.zai ?? createZaiAdapter({ credentialStore: this.credentialStore }),
      alibaba: options.adapters?.alibaba ?? createAlibabaAdapter({ credentialStore: this.credentialStore }),
      deepseek: options.adapters?.deepseek ?? createDeepSeekAdapter({ credentialStore: this.credentialStore }),
      openrouter: options.adapters?.openrouter ?? new PaidAutoOpenRouterAdapter(createOpenRouterAdapter({ credentialStore: this.credentialStore }), this.familyCatalog),
    };
    this.paidExecutionEnabled = options.paidExecutionEnabled ?? false;
    this.openRouterFallbackEnabled = options.openRouterFallbackEnabled ?? false;
    this.routeQualifications = options.routeQualifications ?? {};
    this.roleEvidence = new PaidRoleEvidenceBook(options.roleVerdicts ?? []);
    this.roleEvidenceMaxAgeMs = options.roleEvidenceMaxAgeMs ?? PAID_ROLE_EVIDENCE_MAX_AGE_MS;
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
    return this.familyCatalog.model(canonicalModelId);
  }

  /**
   * R55 wave 2: the durable family-catalog record for a canonical id — real lifecycle and
   * provider availability, so roster projections name an ACTIVE_ECONOMY predecessor what
   * it is instead of manufacturing ACTIVE.
   */
  familyVersion(canonicalModelId: string): PaidFamilyVersion | undefined {
    return this.familyCatalog.version(canonicalModelId);
  }

  models(): readonly PaidAutoModel[] {
    return this.familyCatalog.activeModels();
  }

  modelViews(): PaidAutoModelView[] {
    return this.models().map((model) => {
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
        available: this.routeCanExecute(model.direct) || this.fallbackServes(model),
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
    const model = this.familyCatalog.model(canonicalModelId);
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
    const model = this.familyCatalog.model(canonicalModelId);
    return model ? this.stateFor(model.direct) : undefined;
  }

  attempts(): readonly PaidAutoAttemptRecord[] {
    return this.telemetry;
  }

  asProviderAdapter(): PaidAutoProviderAdapter {
    return new PaidAutoProviderAdapter(this);
  }

  /**
   * R48: record a measured per-role verdict (qualification suite or bounded requalification).
   * Runtime outcomes do not belong here — they are reliability telemetry, not qualification
   * evidence; only the qualification authority may move a verdict.
   */
  recordRoleVerdict(verdict: PaidRoleVerdict): void {
    this.roleEvidence.record(verdict);
  }

  /** R48: the live per-role verdict book (read-only view for evidence/receipts). */
  roleVerdicts(): readonly PaidRoleVerdict[] {
    return this.roleEvidence.entries();
  }

  /**
   * R48: evidence-driven per-role route selection. rank16Bit supplies the qualification
   * floor and expected-cost order; this layer then resolves which route would actually
   * execute for each admissible candidate (direct, or the OpenRouter fallback when direct
   * is credential-absent — every other gate still fails closed). The result is an ordered
   * rotation list, never a price winner that failed this role.
   */
  selectRoleRoute(input: {
    role: string;
    /** An explicit ForgeAuto roster may narrow the paid fleet; no route outside it may serve. */
    allowedModelIds?: readonly PaidAutoCanonicalModelId[];
    inputTokens?: number;
    outputTokens?: number;
    requiresTools?: boolean;
    requiredContextTokens?: number;
    /** Additional measured economics (successRate/roleFit/toolReliability) — caller-owned. */
    measured?: SixteenBitEvidenceMap;
    priceOverrides?: SixteenBitRankOptions["priceOverrides"];
    /** R48: reviewer independence — prefer candidates whose executable route is NOT this
     *  route id (the implementer's quota pool). Soft preference like the free fabric's:
     *  the same pool stays reachable when no independent route can serve, and the
     *  candidate's reasonCodes record SAME_POOL_FALLBACK/INDEPENDENT_POOL_PREFERRED. */
    preferIndependentFromRouteId?: PaidAutoRouteId;
    /** R55 wave 2: cost-mode ordering over an already-admissible candidate set.
     *  MAXIMUM_INTELLIGENCE reorders by measured role-fit evidence only — when no
     *  candidate carries a score the existing order is preserved untouched. */
    costMode?: PaidRoleCostMode;
  }): PaidRoleRouteSelection {
    const task: SixteenBitTaskProfile = {
      role: input.role,
      inputTokens: input.inputTokens ?? 4_000,
      outputTokens: input.outputTokens ?? 1_024,
      requiresTools: input.requiresTools ?? ["explorer", "coder", "tool_agent", "toolagent", "subagent"].includes(input.role.toLowerCase().replace(/[\s-]/g, "_")),
      requiredContextTokens: input.requiredContextTokens,
    };
    const now = this.now();
    const evidence: SixteenBitEvidenceMap = {};
    for (const model of this.models()) {
      evidence[model.canonicalModelId] = {
        ...input.measured?.[model.canonicalModelId],
        roleStatus: this.roleEvidence.verdictFor(model.canonicalModelId, input.role, now, this.roleEvidenceMaxAgeMs),
      };
    }
    const ranking = rank16Bit(task, evidence, () => now, { priceOverrides: input.priceOverrides, models: this.models() });
    const orderedCandidates: PaidRoleRouteCandidate[] = [];
    for (const candidate of ranking.candidates.filter((c) => c.excluded === undefined && (input.allowedModelIds === undefined || input.allowedModelIds.includes(c.canonicalModelId)))) {
      const model = this.familyCatalog.model(candidate.canonicalModelId);
      const route = model ? this.executableRouteFor(model) : undefined;
      if (!route) continue;
      orderedCandidates.push({
        canonicalModelId: candidate.canonicalModelId,
        route,
        roleStatus: evidence[candidate.canonicalModelId]?.roleStatus ?? "NOT_TESTED",
        expectedCostUsd: candidate.expectedCostUsd,
        reasonCodes: input.preferIndependentFromRouteId !== undefined
          ? [...candidate.reasonCodes, route.routeId === input.preferIndependentFromRouteId ? "SAME_POOL_FALLBACK" : "INDEPENDENT_POOL_PREFERRED"]
          : candidate.reasonCodes,
      });
    }
    // Soft preference only: an independent-pool candidate outranks the implementer's pool,
    // but the implementer's pool still serves when nothing independent can.
    if (input.preferIndependentFromRouteId !== undefined) {
      orderedCandidates.sort((a, b) => Number(a.route.routeId === input.preferIndependentFromRouteId) - Number(b.route.routeId === input.preferIndependentFromRouteId));
    }
    // R55 wave 2 cost modes. CHEAPEST is the existing expected-cost order; BALANCED and
    // CUSTOM keep it pending weights. MAXIMUM_INTELLIGENCE reorders only within the
    // already role-qualified/authorized list by the measured role-fit score — candidates
    // without a score keep their relative order at the tail, and a wholly unscored list
    // is left exactly as computed. The admissible set never changes.
    if (input.costMode === "MAXIMUM_INTELLIGENCE" && orderedCandidates.length > 1) {
      const scored = orderedCandidates.map((candidate) => ({ candidate, score: evidence[candidate.canonicalModelId]?.roleFit }));
      if (scored.some((entry) => entry.score !== undefined)) {
        scored.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
        orderedCandidates.splice(0, orderedCandidates.length, ...scored.map((entry) => entry.candidate));
      }
    }
    const selected = orderedCandidates[0];
    const outcome: PaidRoleRouteOutcome = selected
      ? "selected"
      : ranking.selected !== undefined || ranking.candidates.some((c) => c.excluded === undefined)
        ? "no_executable_route"
        : ranking.selectionStatus === "NO_QUALIFIED_ROLE_ROUTE"
          ? "no_qualified_role_route"
          : "no_admissible_route";
    return {
      outcome,
      role: input.role,
      ...(selected ? { selected } : {}),
      orderedCandidates,
      ranking,
      reasonCodes: selected ? selected.reasonCodes : input.allowedModelIds ? ["ROSTER_NO_ADMISSIBLE_SELECTED_MODEL", ranking.selectionStatus] : [ranking.selectionStatus],
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = this.requireModel(req.model);
    const logicalRequestId = this.logicalRequestId(req);
    const direct = this.routeForExecution(model);
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
    const direct = this.routeForExecution(model);
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
    const states = this.models().map((model) => this.stateFor(model.direct));
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
    const model = this.familyCatalog.model(canonicalModelId);
    if (!model || !this.models().some((item) => item.canonicalModelId === canonicalModelId)) throw new PaidAutoExecutionError({ code: "MODEL_NOT_FOUND", message: "Paid Auto accepts only active approved canonical models.", failureClass: "invalid_request", executionCertainty: "not_started" });
    return model;
  }

  /**
   * R55 wave 2: the route that would physically execute for a roster-authorized canonical
   * selection — needed by allowance accounting to price the *actual* attempt route.
   */
  executableRouteForModel(canonicalModelId: string): PaidAutoRoute | undefined {
    if (!this.models().some((item) => item.canonicalModelId === canonicalModelId)) return undefined;
    const model = this.familyCatalog.model(canonicalModelId);
    return model ? this.executableRouteFor(model) : undefined;
  }

  /** The route that would execute now, or undefined — mirrors routeForExecution without
   *  throwing, so role selection can see executability per candidate. */
  private executableRouteFor(model: PaidAutoModel): PaidAutoRoute | undefined {
    if (this.routeCanExecute(model.direct)) return model.direct;
    if (this.fallbackServes(model)) return model.fallback;
    return undefined;
  }

  private routeForExecution(model: PaidAutoModel): PaidAutoRoute {
    if (this.routeCanExecute(model.direct)) return model.direct;
    // A direct route that cannot execute *only* because its credential is absent must not block
    // the OpenRouter fallback — the fallback exists to serve the same canonical model. Every
    // other gate (kill switch, policy review, certification, open circuit) still fails closed.
    if (this.fallbackServes(model)) return this.requireFallbackRoute(model);
    const state = this.stateFor(model.direct);
    const failureClass = state === "BILLING_REQUIRED" ? "billing_required" : state === "AUTHORIZATION_REQUIRED" || state === "POLICY_REVIEW_REQUIRED" ? "policy_rejection" : "unknown_failure";
    throw new PaidAutoExecutionError({ code: `PAID_AUTO_${state}`, message: this.stateReason(state), failureClass, executionCertainty: "not_started", routeId: model.direct.routeId });
  }

  private fallbackServes(model: PaidAutoModel): boolean {
    return this.openRouterFallbackEnabled && this.stateFor(model.direct) === "NOT_CONFIGURED" && this.routeCanExecute(model.fallback);
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
