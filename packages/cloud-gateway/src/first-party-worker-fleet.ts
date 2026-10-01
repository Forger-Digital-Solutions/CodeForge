import { OpenAICompatibleAdapter, ProviderError, type ProviderAdapter, type ProviderHealthResponse, type ProviderModel, type StreamEvent, type ChatRequest, type ChatResponse } from "@codeforge/providers";
import { z } from "zod";
import type { CloudFirewallManager } from "./cloud-firewall.js";

export const QWEN_FREE_MODEL_ID = "codeforge/qwen-coder-free";
export const QWEN_UPSTREAM_MODEL_ID = "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8";
export const QWEN_MODEL_REVISION = "dcaee4d4dfc5ee71ad501f01f530e5652438fde0";
export const QWEN_FLEET_PROVIDER_ID = "codeforge-qwen-free";

const QualificationStateSchema = z.enum(["QUALIFIED", "PROBATION", "NOT_QUALIFIED", "HARD_FAILURE", "QUOTA_EXHAUSTED"]);
const RoleReceiptStateSchema = z.enum(["QUALIFIED", "NOT_QUALIFIED", "HARD_FAILURE", "NOT_TESTED", "PROBATION"]);
export const QwenWorkerQualificationCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string(),
  upstreamModelId: z.string(),
  modelRevision: z.string(),
  license: z.string(),
  commercialUseAuthorized: z.boolean(),
  multiUserAuthorized: z.boolean(),
  qualificationState: QualificationStateSchema,
  suiteVersion: z.enum(["R10_FREE_QUALIFICATION_V1", "R1_FREE_CLOUD_COMPACT_V1", "R41_ROLE_QUALIFICATION_V3"]),
  completedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  runtimeProfileId: z.string().min(1),
  evidenceRef: z.string().min(1),
  roleResults: z.object({ CODER: z.object({ status: RoleReceiptStateSchema }), TOOL_AGENT: z.object({ status: RoleReceiptStateSchema }) }),
});
export const QwenWorkerQualificationSchema = QwenWorkerQualificationCandidateSchema.extend({
  modelId: z.literal(QWEN_FREE_MODEL_ID),
  upstreamModelId: z.literal(QWEN_UPSTREAM_MODEL_ID),
  modelRevision: z.literal(QWEN_MODEL_REVISION),
  license: z.literal("Apache-2.0"),
  commercialUseAuthorized: z.literal(true),
  multiUserAuthorized: z.literal(true),
  qualificationState: z.literal("QUALIFIED"),
  roleResults: z.object({ CODER: z.object({ status: z.literal("QUALIFIED") }), TOOL_AGENT: z.object({ status: z.literal("QUALIFIED") }) }),
});
export type QwenWorkerQualification = z.infer<typeof QwenWorkerQualificationCandidateSchema>;

export const QwenWorkerConfigSchema = z.object({
  workerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  baseUrl: z.string().url(),
  token: z.string().min(32),
  runtimeProfileId: z.string().min(1),
}).superRefine((worker, ctx) => {
  const endpoint = new URL(worker.baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "worker baseUrl must not contain credentials, query parameters, or fragments", path: ["baseUrl"] });
  }
});
export type QwenWorkerConfig = z.infer<typeof QwenWorkerConfigSchema>;

export interface FirstPartyWorkerFleetConfig {
  workers: QwenWorkerConfig[];
  qualification?: QwenWorkerQualification;
}

export interface FirstPartyWorkerSnapshot {
  workerId: string;
  models: string[];
  accelerator: string;
  vramMb: number;
  vramUsedMb: number | null;
  gpuUtilizationPct: number | null;
  activeRequests: number;
  queueDepth: number | null;
  maxConcurrentSequences: number;
  maxBatchTokens: number;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  gpuCacheUsagePct: number | null;
  prefixCacheHitRate: number | null;
  ttftP95Ms: number | null;
  state: "READY" | "DRAINING" | "UNAVAILABLE";
  observedAt: string;
  error?: string;
}

interface FleetMember {
  config: QwenWorkerConfig;
  adapter: OpenAICompatibleAdapter;
  snapshot: FirstPartyWorkerSnapshot;
  localActive: number;
}

export interface FirstPartyWorkerFleetOptions {
  firewallManager: CloudFirewallManager;
  config: FirstPartyWorkerFleetConfig;
  now?: () => Date;
  fetchFn?: typeof fetch;
  heartbeatIntervalMs?: number;
}

const QUALIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const WORKER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Server-owned, capability-oriented Qwen worker fleet. It only registers a logical ForgeZero
 * route after a fresh qualification/authorization receipt and a live worker identity check.
 * Worker credentials remain in this process and are never returned by listWorkers().
 */
export class FirstPartyWorkerFleet implements ProviderAdapter {
  readonly providerId = QWEN_FLEET_PROVIDER_ID;
  readonly supportsDispatchIdentity = false;
  private readonly firewallManager: CloudFirewallManager;
  private readonly config: FirstPartyWorkerFleetConfig;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  private readonly members: FleetMember[];
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private registered = false;

  constructor(options: FirstPartyWorkerFleetOptions) {
    this.firewallManager = options.firewallManager;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.fetchFn = options.fetchFn ?? fetch;
    const workerIds = new Set<string>();
    this.members = this.config.workers.map((worker) => {
      if (workerIds.has(worker.workerId)) throw new Error(`Duplicate CodeForge worker id '${worker.workerId}'`);
      workerIds.add(worker.workerId);
      const adapter = new OpenAICompatibleAdapter({
        providerId: this.providerId,
        baseUrl: `${worker.baseUrl.replace(/\/$/, "")}/v1`,
        apiKey: worker.token,
        timeoutMs: 120_000,
        fetchFn: this.fetchFn,
        includeUsageInStream: true,
        mapModel: (raw) => this.mapQualifiedModel(raw),
      });
      return {
        config: worker,
        adapter,
        localActive: 0,
        snapshot: {
          workerId: worker.workerId,
          models: [],
          accelerator: "unreported",
          vramMb: 0,
          vramUsedMb: null,
          gpuUtilizationPct: null,
          activeRequests: 0,
          queueDepth: null,
          maxConcurrentSequences: 0,
          maxBatchTokens: 0,
          promptTokensPerSecond: null,
          generationTokensPerSecond: null,
          gpuCacheUsagePct: null,
          prefixCacheHitRate: null,
          ttftP95Ms: null,
          state: "UNAVAILABLE",
          observedAt: this.now().toISOString(),
        },
      };
    });
  }

  async start(heartbeatIntervalMs = 10_000): Promise<void> {
    await this.heartbeat();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  async heartbeat(): Promise<FirstPartyWorkerSnapshot[]> {
    try {
      this.assertQualificationCurrent();
    } catch {
      for (const member of this.members) {
        member.snapshot = { ...member.snapshot, state: "UNAVAILABLE", error: "qualification_unavailable", observedAt: this.now().toISOString() };
      }
      if (this.registered) {
        this.firewallManager.unregisterModel(this.providerId, QWEN_FREE_MODEL_ID);
        this.registered = false;
      }
      return this.listWorkers();
    }
    await Promise.all(this.members.map(async (member) => {
      try {
        member.snapshot = await this.probe(member);
      } catch (error) {
        member.snapshot = {
          ...member.snapshot,
          state: "UNAVAILABLE",
          observedAt: this.now().toISOString(),
          error: safeError(error),
        };
      }
    }));
    const ready = this.members.some((member) => member.snapshot.state === "READY");
    if (!this.registered && ready) {
      this.firewallManager.registerProvider(this);
      this.firewallManager.registerModel(this.logicalModelRecord());
      this.registered = true;
    } else if (this.registered) {
      this.firewallManager.markProviderHealth(this.providerId, ready ? "available" : "offline", {
        lastError: ready ? undefined : "no_ready_qwen_workers",
      });
    }
    return this.listWorkers();
  }

  listWorkers(): FirstPartyWorkerSnapshot[] {
    return this.members.map(({ snapshot }) => ({ ...snapshot, models: [...snapshot.models] }));
  }

  availableCapacity(): number {
    return this.members.reduce((sum, member) => sum + this.availableSlots(member), 0);
  }

  capacitySnapshot(): Array<{ modelId: string; maxConcurrent: number }> {
    return [{
      modelId: QWEN_FREE_MODEL_ID,
      maxConcurrent: this.members.reduce((sum, member) => sum + (member.snapshot.state === "READY" ? member.snapshot.maxConcurrentSequences : 0), 0),
    }];
  }

  async listModels(): Promise<ProviderModel[]> {
    if (this.availableCapacity() < 1) return [];
    return [this.mapQualifiedModel({ id: QWEN_FREE_MODEL_ID, revision: QWEN_MODEL_REVISION })!];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.assertRequestFitsModel(request);
    const candidates = this.candidates(request.model);
    let lastError: unknown;
    for (const member of candidates) {
      if (this.availableSlots(member) < 1) continue;
      member.localActive += 1;
      try {
        return await member.adapter.chat(request);
      } catch (error) {
        lastError = error;
        this.markWorkerUnavailable(member, error);
      } finally {
        member.localActive = Math.max(0, member.localActive - 1);
      }
    }
    throw lastError ?? new ProviderError("CodeForge Qwen capacity is saturated", "CAPACITY_SATURATED", true, { status: 503 });
  }

  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.assertRequestFitsModel(request);
    const candidates = this.candidates(request.model);
    let lastError: unknown;
    for (const member of candidates) {
      if (this.availableSlots(member) < 1) continue;
      member.localActive += 1;
      let yielded = false;
      try {
        for await (const event of member.adapter.streamChat(request, signal)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        this.markWorkerUnavailable(member, error);
        if (yielded) throw error;
        lastError = error;
      } finally {
        member.localActive = Math.max(0, member.localActive - 1);
      }
    }
    throw lastError ?? new ProviderError("CodeForge Qwen capacity is saturated", "CAPACITY_SATURATED", true, { status: 503 });
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    const ready = this.members.filter((member) => member.snapshot.state === "READY");
    if (ready.length > 0) return { status: "available" };
    return { status: "offline", error: "No ready qualified CodeForge Qwen workers" };
  }

  canRoute(modelId: string): boolean {
    return modelId === QWEN_FREE_MODEL_ID && this.availableCapacity() > 0;
  }

  private assertQualificationCurrent(): void {
    if (!this.config.qualification) throw new Error("qualification_missing");
    const qualification = QwenWorkerQualificationSchema.parse(this.config.qualification);
    if (this.members.some((member) => member.config.runtimeProfileId !== qualification.runtimeProfileId)) {
      throw new Error("qualification_runtime_profile_mismatch");
    }
    const completedAt = Date.parse(qualification.completedAt);
    const expiresAt = Date.parse(qualification.expiresAt);
    const age = this.now().getTime() - completedAt;
    if (!Number.isFinite(completedAt) || !Number.isFinite(expiresAt) || age < 0 || age >= QUALIFICATION_MAX_AGE_MS || expiresAt <= this.now().getTime()) {
      throw new Error("Qwen worker qualification receipt is stale or expired");
    }
  }

  private logicalModelRecord() {
    const qualification = this.config.qualification!;
    const timestamp = qualification.completedAt;
    return {
      providerId: this.providerId,
      modelId: QWEN_FREE_MODEL_ID,
      displayName: "ForgeAuto Free (CodeForge Qwen)",
      freeStatus: "verified_free" as const,
      freeStatusVerifiedAt: timestamp,
      tier: "free" as const,
      entitlementStatus: "included" as const,
      contextWindow: 32_768,
      maxOutput: 4096,
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
      costProfile: {
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        isFree: true,
        freeTierVerifiedAt: timestamp,
        paidFallbackPossible: false,
        paidFallbackDisabled: true,
        source: `codeforge-worker-qualification:${qualification.evidenceRef}`,
      },
      health: { status: "available" as const, lastCheckedAt: this.now().toISOString() },
      isRemote: true,
      isCloudHosted: true,
      accessClass: "FREE_NATIVE" as const,
      supplyClass: "CODEFORGE_OWNED" as const,
      authMode: "HOSTED_RELAY" as const,
      privacyClass: "strict" as const,
      family: "Qwen3-Coder",
      upstreamSource: "official-qwen-pinned-revision",
      lastVerified: timestamp,
      verificationSource: "CodeForge first-party worker qualification",
      qualificationVersion: qualification.suiteVersion,
      roleSuitability: { CODER: "QUALIFIED" as const, TOOL_AGENT: "QUALIFIED" as const },
      lifecycle: "ACTIVE" as const,
      lastSuccessfulRuntimeProof: {
        status: "PASSED" as const,
        kind: "QUALIFICATION" as const,
        verifiedAt: timestamp,
        evidenceRef: qualification.evidenceRef,
      },
    };
  }

  private mapQualifiedModel(raw: unknown): ProviderModel | null {
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (value.id !== QWEN_FREE_MODEL_ID || value.revision !== QWEN_MODEL_REVISION) return null;
    return {
      modelId: QWEN_FREE_MODEL_ID,
      displayName: "Qwen3-Coder (CodeForge Free)",
      contextWindow: 32_768,
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
      isFree: true,
      freeStatus: "verified_free",
    };
  }

  private availableSlots(member: FleetMember): number {
    if (member.snapshot.state !== "READY") return 0;
    return Math.max(0, member.snapshot.maxConcurrentSequences - member.snapshot.activeRequests - member.localActive - (member.snapshot.queueDepth ?? 0));
  }

  private markWorkerUnavailable(member: FleetMember, error: unknown): void {
    member.snapshot = { ...member.snapshot, state: "UNAVAILABLE", error: safeError(error), observedAt: this.now().toISOString() };
    if (!this.registered) return;
    const anyReady = this.members.some((candidate) => candidate.snapshot.state === "READY");
    this.firewallManager.markProviderHealth(this.providerId, anyReady ? "available" : "offline", {
      lastError: anyReady ? undefined : "no_ready_qwen_workers",
    });
  }

  private candidates(modelId: string): FleetMember[] {
    if (modelId !== QWEN_FREE_MODEL_ID) throw new ProviderError("Unapproved CodeForge worker model", "MODEL_NOT_FOUND", false, { status: 404 });
    const candidates = this.members
      .filter((member) => this.availableSlots(member) > 0)
      .sort((a, b) => (a.snapshot.activeRequests + a.localActive + (a.snapshot.queueDepth ?? 0)) - (b.snapshot.activeRequests + b.localActive + (b.snapshot.queueDepth ?? 0)));
    if (candidates.length === 0) throw new ProviderError("CodeForge Qwen capacity is saturated", "CAPACITY_SATURATED", true, { status: 503 });
    return candidates;
  }

  private assertRequestFitsModel(request: ChatRequest): void {
    if (request.maxTokens !== undefined && request.maxTokens > 4096) {
      throw new ProviderError("Qwen worker output limit is 4,096 tokens", "OUTPUT_LIMIT_EXCEEDED", false, { status: 400 });
    }
    const input = JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools ?? [] });
    const estimatedInputTokens = Math.ceil(new TextEncoder().encode(input).byteLength / 3);
    if (estimatedInputTokens > 24_576) {
      throw new ProviderError("Qwen worker input limit is 24,576 estimated tokens", "CONTEXT_LENGTH", false, { status: 400 });
    }
  }

  private async probe(member: FleetMember): Promise<FirstPartyWorkerSnapshot> {
    const root = member.config.baseUrl.replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WORKER_REQUEST_TIMEOUT_MS);
    try {
      const ready = await this.fetchFn(`${root}/ready`, { signal: controller.signal });
      let workerDraining = false;
      if (!ready.ok) {
        const readiness = await ready.json().catch(() => undefined) as { draining?: unknown } | undefined;
        workerDraining = readiness?.draining === true;
        if (!workerDraining) throw new Error(`readiness_http_${ready.status}`);
      }
      const headers = { Authorization: `Bearer ${member.config.token}` };
      const [modelsResponse, metricsResponse] = await Promise.all([
        this.fetchFn(`${root}/v1/models`, { headers, signal: controller.signal }),
        this.fetchFn(`${root}/metrics`, { headers, signal: controller.signal }),
      ]);
      if (!modelsResponse.ok) throw new Error(`model_identity_http_${modelsResponse.status}`);
      if (!metricsResponse.ok) throw new Error(`worker_metrics_http_${metricsResponse.status}`);
      const models = await modelsResponse.json() as { data?: Array<{ id?: unknown; revision?: unknown }> };
      const matchingModel = models.data?.some((model) => model.id === QWEN_FREE_MODEL_ID && model.revision === QWEN_MODEL_REVISION) === true;
      if (!matchingModel) throw new Error("worker_model_identity_or_revision_mismatch");
      const metrics = await metricsResponse.json() as Record<string, unknown>;
      if (metrics.workerId !== member.config.workerId || metrics.modelId !== QWEN_FREE_MODEL_ID || metrics.modelRevision !== QWEN_MODEL_REVISION) {
        throw new Error("worker_metrics_identity_mismatch");
      }
      const maxConcurrentSequences = positiveInteger(metrics.maxConcurrentSequences);
      if (maxConcurrentSequences === 0) throw new Error("worker_capacity_unreported");
      return {
        workerId: member.config.workerId,
        models: [QWEN_FREE_MODEL_ID],
        accelerator: typeof metrics.accelerator === "string" ? metrics.accelerator : "unreported",
        vramMb: nonnegativeInteger(metrics.vramMb),
        vramUsedMb: finiteOrNull(metrics.vramUsedMb),
        gpuUtilizationPct: finiteOrNull(metrics.gpuUtilizationPct),
        activeRequests: nonnegativeInteger(metrics.activeRequests),
        queueDepth: typeof metrics.queueDepth === "number" && Number.isFinite(metrics.queueDepth) ? Math.max(0, Math.floor(metrics.queueDepth)) : null,
        maxConcurrentSequences,
        maxBatchTokens: positiveInteger(metrics.maxBatchTokens),
        promptTokensPerSecond: finiteOrNull(metrics.promptTokensPerSecond),
        generationTokensPerSecond: finiteOrNull(metrics.generationTokensPerSecond),
        gpuCacheUsagePct: finiteOrNull(metrics.gpuCacheUsagePct),
        prefixCacheHitRate: finiteOrNull(metrics.prefixCacheHitRate),
        ttftP95Ms: finiteOrNull(metrics.ttftP95Ms),
        state: workerDraining || metrics.draining === true ? "DRAINING" : "READY",
        observedAt: this.now().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 160);
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
